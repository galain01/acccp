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
import { PDFDocument, PDFHexString, PDFName, PDFOperator, rgb } from "pdf-lib";
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
      !/^(?:lib[/\\]pdf-(?:rendering-child|image-alternatives)\.mjs|node_modules[/\\](?:pdfjs-dist|@napi-rs)[/\\]|node_modules[/\\]pdf-lib[/\\]dist[/\\]pdf-lib\.min\.js$)/.test(
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
  const structure = pdf.context.obj({ Type: PDFName.of("StructTreeRoot") });
  const structureRef = pdf.context.register(structure);
  const figureRefs = [];
  const parentEntries = [];
  const colors = [
    [1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ];
  for (const [index, color] of colors.entries()) {
    const page = pdf.addPage([200, 200]);
    page.pushOperators(
      PDFOperator.of("BDC", [
        PDFName.of("Figure"),
        pdf.context.obj({ MCID: 0 }),
      ])
    );
    page.drawRectangle({
      x: 50,
      y: 50,
      width: 100,
      height: 100,
      color: rgb(...color),
    });
    page.pushOperators(PDFOperator.of("EMC"));
    page.drawText(`Runtime page ${index + 1}`, { x: 10, y: 180, size: 10 });
    page.node.set(PDFName.of("StructParents"), pdf.context.obj(index));
    const figureRef = pdf.context.register(
      pdf.context.obj({
        Type: PDFName.of("StructElem"),
        S: PDFName.of("Figure"),
        P: structureRef,
        Pg: page.ref,
        K: 0,
        Alt: PDFHexString.fromText(`Runtime figure ${index + 1} description`),
      })
    );
    figureRefs.push(figureRef);
    parentEntries.push(index, pdf.context.obj([figureRef]));
  }
  structure.set(PDFName.of("K"), pdf.context.obj(figureRefs));
  structure.set(
    PDFName.of("ParentTree"),
    pdf.context.register(pdf.context.obj({ Nums: parentEntries }))
  );
  pdf.catalog.set(PDFName.of("StructTreeRoot"), structureRef);
  pdf.catalog.set(PDFName.of("MarkInfo"), pdf.context.obj({ Marked: true }));
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
        `--allow-fs-read=${join(target, "lib/pdf-image-alternatives.mjs")}`,
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
    const alternatives = page.imageAlternatives;
    const figure = alternatives?.figures?.[0];
    if (
      alternatives?.status !== "complete" ||
      alternatives.figures.length !== 1 ||
      figure?.alt !== `Runtime figure ${index + 1} description` ||
      figure?.id !== `p${index + 1}-figure1` ||
      !figure.bounds ||
      Math.abs(figure.bounds.x - 0.25) > 0.02 ||
      Math.abs(figure.bounds.y - 0.25) > 0.02 ||
      Math.abs(figure.bounds.width - 0.5) > 0.02 ||
      Math.abs(figure.bounds.height - 0.5) > 0.02
    )
      throw new Error(
        "Traced PDF renderer lost authored image descriptions or their locations"
      );
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
    `[pdf-renderer] Traced runtime passed: ${process.platform}/${process.arch}, ${process.version}, 3 pages, text, vector pixels and located image alternatives, ${copied} runtime assets.`
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
