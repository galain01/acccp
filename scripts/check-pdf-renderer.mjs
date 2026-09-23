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
      !/^(?:lib[/\\]pdf-(?:rendering-child|image-alternatives|revisions)\.mjs|node_modules[/\\](?:pdfjs-dist|@napi-rs)[/\\]|node_modules[/\\]pdf-lib[/\\]dist[/\\]pdf-lib\.min\.js$)/.test(
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
  // A small compressed file may contain a high-resolution source scan. Exercise
  // the new source-image allowance using actual decoded pixels, not a declaration
  // that PDF.js never draws. Every page has a distinct 20.16 MP bilevel image.
  for (let index = 0; index < 18; index++) {
    const width = 3600,
      height = 5600;
    const pixels = new Uint8Array((width / 8) * height).fill(255);
    for (let row = 1400; row < 4200; row++) {
      pixels.fill(0, row * (width / 8) + 112, row * (width / 8) + 338);
    }
    const ref = pdf.context.register(
      pdf.context.flateStream(pixels, {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Image"),
        Width: width,
        Height: height,
        BitsPerComponent: 1,
        ColorSpace: PDFName.of("DeviceGray"),
      })
    );
    const page = pdf.addPage([432, 672]);
    page.node.set(
      PDFName.of("Resources"),
      pdf.context.obj({ XObject: { Scan: ref } })
    );
    page.pushOperators(
      PDFOperator.of("q"),
      PDFOperator.of(
        "cm",
        [432, 0, 0, 672, 0, 0].map((n) => pdf.context.obj(n))
      ),
      PDFOperator.of("Do", [PDFName.of("Scan")]),
      PDFOperator.of("Q")
    );
    page.drawText(`Scan page ${index + 1}`, { x: 10, y: 640, size: 10 });
  }
  // Exercise an ordinary appended save in the traced runtime too: the current
  // catalog is an update of an earlier compressed definition in this same PDF.
  const original = Buffer.from(await pdf.save());
  const previousXref = [
    ...original.toString("latin1").matchAll(/startxref\s+(\d+)/g),
  ].at(-1)?.[1];
  if (!previousXref)
    throw new Error("Synthetic PDF has no cross-reference index");
  pdf.catalog.set(PDFName.of("Lang"), PDFHexString.fromText("en"));
  const rootRef = pdf.context.trailerInfo.Root;
  const updatedCatalog = `\n${rootRef.objectNumber} ${rootRef.generationNumber} obj\n${pdf.catalog.toString()}\nendobj\n`;
  const updatedOffset = original.length + 1;
  const xrefOffset = original.length + Buffer.byteLength(updatedCatalog);
  const update = `${updatedCatalog}xref\n${rootRef.objectNumber} 1\n${String(updatedOffset).padStart(10, "0")} ${String(rootRef.generationNumber).padStart(5, "0")} n \ntrailer\n<< /Size ${pdf.context.largestObjectNumber + 1} /Root ${rootRef.toString()} /Prev ${previousXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const request = JSON.stringify({
    pdf: Buffer.concat([original, Buffer.from(update)]).toString("base64"),
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
        `--allow-fs-read=${join(target, "lib/pdf-revisions.mjs")}`,
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
    const timer = setTimeout(stop, 90_000);
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
  if (!result.ok || result.pageCount !== 21 || result.pages?.length !== 21)
    throw new Error("Traced PDF renderer omitted pages");
  for (const [index, page] of result.pages.entries()) {
    if (index >= 3) {
      if (
        page.pageNumber !== index + 1 ||
        !page.text?.includes(`Scan page ${index - 2}`) ||
        page.width !== 864 ||
        page.height !== 1344
      ) {
        throw new Error(
          "Traced PDF renderer lost scanned page order or dimensions"
        );
      }
      const image = await loadImage(Buffer.from(page.png, "base64"));
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const center = context.getImageData(432, 672, 1, 1).data;
      const corner = context.getImageData(20, 1200, 1, 1).data;
      if (center[0] !== 0 || center[3] !== 255 || corner[0] !== 255) {
        throw new Error("Traced PDF renderer lost scan pixels");
      }
      canvas.width = canvas.height = 1;
      continue;
    }
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
    `[pdf-renderer] Traced runtime passed: ${process.platform}/${process.arch}, ${process.version}, saved-revision PDF with 21 pages including 18 high-resolution scans, text, vector pixels and located image alternatives, ${copied} runtime assets.`
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
