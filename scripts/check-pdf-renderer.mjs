// Build-only smoke check: render synthetic pages using only traced runtime files.
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { PDFDocument, rgb } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const app = process.cwd();
const trace = join(app, ".next/server/app/api/convert/route.js.nft.json");
const files = JSON.parse(await readFile(trace, "utf8")).files;
const target = await mkdtemp(join(tmpdir(), "acccp-pdf-build-"));
try {
  let copied = 0;
  for (const item of new Set(files)) {
    const source = resolve(dirname(trace), item);
    const sub = relative(app, source);
    if (
      isAbsolute(sub) ||
      sub === ".." ||
      sub.startsWith(`..\\`) ||
      sub.startsWith("../")
    )
      continue;
    if (
      !/^(?:lib[/\\]pdf-rendering-child\.mjs|node_modules[/\\](?:pdfjs-dist|@napi-rs)[/\\]|node_modules[/\\]pdf-lib[/\\]dist[/\\]pdf-lib\.min\.js$)/.test(
        sub
      )
    )
      continue;
    const destination = join(target, sub);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copied++;
  }
  const pdf = await PDFDocument.create();
  const colors = [
    [1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ];
  for (const [index, color] of colors.entries()) {
    const page = pdf.addPage([200, 200]);
    page.drawRectangle({
      x: 50,
      y: 50,
      width: 100,
      height: 100,
      color: rgb(...color),
    });
    page.drawText(`Runtime page ${index + 1}`, { x: 10, y: 180, size: 10 });
  }
  const request = JSON.stringify({
    pdf: Buffer.from(await pdf.save()).toString("base64"),
  });
  const childPath = join(target, "lib/pdf-rendering-child.mjs");
  const result = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=192",
        "--permission",
        "--allow-addons",
        `--allow-fs-read=${childPath}`,
        `--allow-fs-read=${join(target, "node_modules/pdf-lib/dist/pdf-lib.min.js")}`,
        `--allow-fs-read=${join(target, "node_modules/pdfjs-dist")}`,
        `--allow-fs-read=${join(target, "node_modules/@napi-rs")}`,
        childPath,
      ],
      {
        cwd: target,
        env: {
          NODE_ENV: "production",
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let output = "",
      stderrBytes = 0,
      failed = false;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 30_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 8 * 1024 * 1024) stop();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16 * 1024) stop();
    });
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0)
        return reject(new Error("Traced PDF renderer did not complete"));
      try {
        done(JSON.parse(output));
      } catch {
        reject(new Error("Traced PDF renderer returned invalid output"));
      }
    });
    child.stdin.end(request);
  });
  if (!result.ok || result.pageCount !== 3 || result.pages?.length !== 3)
    throw new Error("Traced PDF renderer omitted pages");
  for (const [index, page] of result.pages.entries()) {
    if (
      page.pageNumber !== index + 1 ||
      !page.text?.includes(`Runtime page ${index + 1}`)
    )
      throw new Error("Traced PDF renderer lost page text or order");
    const img = await loadImage(Buffer.from(page.png, "base64"));
    const canvas = createCanvas(img.width, img.height);
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    const pixel = context.getImageData(
      Math.floor(img.width / 2),
      Math.floor(img.height / 2),
      1,
      1
    ).data;
    if (
      colors[index].some(
        (value, channel) => Math.abs(pixel[channel] - value * 255) > 2
      )
    )
      throw new Error("Traced PDF renderer lost page graphics");
  }
  console.log(
    `[pdf-renderer] Traced runtime passed: ${process.platform}/${process.arch}, ${process.version}, 3 pages, text and vector pixels, ${copied} runtime assets.`
  );
} finally {
  // Only remove the exact temporary build directory allocated above.
  if (
    dirname(resolve(target)) !== resolve(tmpdir()) ||
    !basename(target).startsWith("acccp-pdf-build-")
  )
    throw new Error("Unexpected temporary build path");
  await rm(target, { recursive: true, force: true });
}
