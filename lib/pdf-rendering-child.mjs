import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import {
  createImageAlternativeBudget,
  extractImageAlternatives,
  inspectImageAlternativeStructure,
  locateImageAlternatives,
  prepareImageAlternativeBounds,
  unavailableImageAlternatives,
} from "./pdf-image-alternatives.mjs";

// Fixed code, data-only input, fixed local assets, and no output files.
// JS network guards are defense in depth; Node 24 has no OS egress sandbox.
const denyNetwork = () => {
  throw new Error("network-disabled");
};
globalThis.fetch = denyNetwork;
http.request = http.get = https.request = https.get = denyNetwork;
net.connect =
  net.createConnection =
  tls.connect =
  dgram.createSocket =
    denyNetwork;
let warnings = 0;
// PDF.js uses console.log for some warnings, including skipped oversized images.
console.log =
  console.info =
  console.warn =
  console.error =
    () => {
      warnings++;
    };
console.debug = () => {};

const MAX_INPUT = 4 * 1024 * 1024;
const MAX_STDIN = Math.ceil(MAX_INPUT / 3) * 4 + 64;
const MAX_PAGES = 60;
const MAX_PAGE_PIXELS = 2_000_000;
const MAX_DIMENSION = 4096;
const MAX_TOTAL_PIXELS = 120_000_000;
const MAX_IMAGE_PIXELS = 8_000_000;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_DECLARED_IMAGE_PIXELS = 32_000_000;
const MAX_PREFLIGHT_OBJECTS = 100_000;
const MAX_PNG = 8 * 1024 * 1024;
const MAX_TOTAL_PNG = 24 * 1024 * 1024;
const MAX_PAGE_TEXT = 100_000;
const MAX_TOTAL_TEXT = 500_000;

function fail() {
  throw new Error("render-failed");
}
function checkCanvas(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_IMAGE_PIXELS
  )
    fail();
}

async function preflightImages(bytes) {
  // Inspect stream dictionaries without decoding image payloads. PDF.js checks
  // only the base image's dimensions; larger SMask/Mask streams otherwise bypass
  // maxImageSize. Include unreferenced objects and nested masks conservatively.
  const require = createRequire(import.meta.url);
  const {
    PDFDocument,
    ParseSpeeds,
    PDFRawStream,
    PDFDict,
    PDFArray,
    PDFName,
    PDFNumber,
    PDFString,
    PDFHexString,
    PDFRef,
    PDFContext,
  } = require(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      "pdf-lib",
      "dist",
      "pdf-lib.min.js"
    )
  );
  // PDF.js follows xref-selected definitions; pdf-lib otherwise overwrites them
  // with later physical definitions. Reject duplicates instead of preflighting
  // one object graph while rendering another (including object-stream entries).
  const originalAssign = PDFContext.prototype.assign;
  const assigned = new Set();
  let duplicate = false;
  let document;
  PDFContext.prototype.assign = function (ref, object) {
    const key = ref.toString();
    if (assigned.has(key)) duplicate = true;
    assigned.add(key);
    if (assigned.size > MAX_PREFLIGHT_OBJECTS) fail();
    return originalAssign.call(this, ref, object);
  };
  try {
    document = await PDFDocument.load(bytes, {
      parseSpeed: ParseSpeeds.Fastest,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
  } finally {
    PDFContext.prototype.assign = originalAssign;
  }
  if (duplicate) fail();
  if (document.getPageCount() < 1 || document.getPageCount() > MAX_PAGES)
    fail();
  const objects = document.context.enumerateIndirectObjects();
  if (objects.length > MAX_PREFLIGHT_OBJECTS) fail();
  const pending = objects.map(([, object]) => object);
  const visited = new Set();
  const streams = new Set();
  const masks = new Set();
  const name = (key) => PDFName.of(key);
  while (pending.length) {
    const object = document.context.lookup(pending.pop());
    if (!object || visited.has(object)) continue;
    visited.add(object);
    if (visited.size > MAX_PREFLIGHT_OBJECTS) fail();
    if (object instanceof PDFRawStream) {
      streams.add(object);
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const key of ["SMask", "Mask"]) {
        const mask = object.lookup(name(key));
        if (mask instanceof PDFRawStream) masks.add(mask);
      }
      pending.push(...object.values());
    } else if (object instanceof PDFArray) {
      pending.push(...object.asArray());
    }
    if (pending.length > MAX_PREFLIGHT_OBJECTS) fail();
  }
  const dimensions = new Map();
  const dimension = (dict, short, long) => {
    const shortValue = dict.lookup(name(short));
    const longValue = dict.lookup(name(long));
    const value = shortValue ?? longValue;
    if (!(value instanceof PDFNumber)) fail();
    const number = value.asNumber();
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > MAX_IMAGE_DIMENSION
    )
      fail();
    if (
      shortValue &&
      longValue &&
      (!(longValue instanceof PDFNumber) || longValue.asNumber() !== number)
    )
      fail();
    return number;
  };
  for (const stream of streams) {
    const dict = stream.dict;
    if (
      dict.lookup(name("Subtype")) !== name("Image") &&
      !masks.has(stream) &&
      !["W", "Width", "H", "Height"].some((key) => dict.has(name(key)))
    )
      continue;
    const width = dimension(dict, "W", "Width");
    const height = dimension(dict, "H", "Height");
    if (width * height > MAX_IMAGE_PIXELS) fail();
    dimensions.set(stream, { width, height });
  }
  let totalPixels = 0;
  for (const [stream, size] of dimensions) {
    let width = size.width,
      height = size.height;
    for (const key of ["SMask", "Mask"]) {
      const mask = dimensions.get(stream.dict.lookup(name(key)));
      if (mask) {
        width = Math.max(width, mask.width);
        height = Math.max(height, mask.height);
      }
    }
    // Differently shaped base and mask can expand both axes beyond either area.
    const pixels = width * height;
    if (pixels > MAX_IMAGE_PIXELS) fail();
    totalPixels += pixels;
    if (totalPixels > MAX_DECLARED_IMAGE_PIXELS) fail();
  }
  // This is a declared-resource guard, not an OS/native RSS memory limit. Inline
  // images still use PDF.js's per-image bound and the whole-process deadline.
  return inspectImageAlternativeStructure(document, {
    PDFDict,
    PDFArray,
    PDFName,
    PDFNumber,
    PDFString,
    PDFHexString,
    PDFRef,
  });
}

async function extractText(page, remaining) {
  if (remaining <= 0) return null;
  let reader;
  try {
    reader = page.streamTextContent().getReader();
    const parts = [];
    let chars = 0;
    let exceeded = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const item of chunk.value.items) {
        if (exceeded) continue;
        if (typeof item.str !== "string") continue;
        chars += item.str.length + 1;
        if (chars > MAX_PAGE_TEXT || chars > remaining) {
          exceeded = true;
          parts.length = 0;
          // PDF.js 6 can throw a late stream error when cancelled. Drain without
          // retaining more text; the process deadline still bounds this work.
          continue;
        }
        parts.push(item.str, item.hasEOL ? "\n" : " ");
      }
    }
    return exceeded ? null : parts.join("").trim();
  } catch {
    return null;
  }
}

async function render() {
  const input = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    inputBytes += chunk.length;
    if (inputBytes > MAX_STDIN) fail();
    input.push(chunk);
  }
  const message = JSON.parse(Buffer.concat(input).toString("utf8"));
  if (
    typeof message.pdf !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(message.pdf)
  )
    fail();
  const bytes = new Uint8Array(Buffer.from(message.pdf, "base64"));
  if (
    bytes.byteLength > MAX_INPUT ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  )
    fail();
  const imageAlternativeStructure = await preflightImages(bytes);
  const { createCanvas } = await import("@napi-rs/canvas");
  class BoundedCanvasFactory {
    create(width, height) {
      width = Math.ceil(width);
      height = Math.ceil(height);
      checkCanvas(width, height);
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(target, width, height) {
      checkCanvas(width, height);
      target.canvas.width = width;
      target.canvas.height = height;
    }
    destroy(target) {
      if (target.canvas) {
        target.canvas.width = 1;
        target.canvas.height = 1;
      }
      target.canvas = null;
      target.context = null;
    }
  }
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "pdfjs-dist"
  );
  const task = getDocument({
    data: bytes,
    CanvasFactory: BoundedCanvasFactory,
    cMapUrl: join(root, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts") + "/",
    wasmUrl: join(root, "wasm") + "/",
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    maxImageSize: MAX_IMAGE_PIXELS,
    // PDF.js 6 can resolve its page promise before propagating an operator-list
    // error. Its warning path is reliable; every rendering warning fails below.
    stopAtErrors: false,
    verbosity: 1,
  });
  try {
    const document = await task.promise;
    if (
      !Number.isSafeInteger(document.numPages) ||
      document.numPages < 1 ||
      document.numPages > MAX_PAGES
    )
      fail();
    const pages = [];
    const imageAlternativeBudget = createImageAlternativeBudget();
    let totalPixels = 0,
      totalPng = 0,
      totalText = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      let viewport = page.getViewport({ scale: 2 });
      if (
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0
      )
        fail();
      const factor = Math.min(
        1,
        Math.sqrt(
          MAX_PAGE_PIXELS /
            (Math.ceil(viewport.width) * Math.ceil(viewport.height))
        ),
        MAX_DIMENSION / Math.ceil(viewport.width),
        MAX_DIMENSION / Math.ceil(viewport.height)
      );
      if (factor < 1)
        viewport = page.getViewport({ scale: 2 * factor * 0.999 });
      const width = Math.ceil(viewport.width),
        height = Math.ceil(viewport.height);
      totalPixels += width * height;
      if (
        width * height > MAX_PAGE_PIXELS ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION ||
        totalPixels > MAX_TOTAL_PIXELS
      )
        fail();
      const target = document.canvasFactory.create(width, height);
      try {
        // Unlike visible page text, authored image alternatives live in tags.
        // PDF.js may warn when it cannot read the complete tree. Treat that as
        // unavailable metadata, never as proof that no descriptions existed.
        if (warnings > 0) fail();
        let alternatives = imageAlternativeStructure.available
          ? await extractImageAlternatives(
              page,
              pageNumber,
              imageAlternativeBudget
            )
          : unavailableImageAlternatives();
        if (warnings > 0) alternatives = unavailableImageAlternatives();
        const expectedFigures =
          imageAlternativeStructure.expectedFigureCounts?.[pageNumber - 1];
        if (
          alternatives.status === "complete" &&
          expectedFigures !== undefined &&
          alternatives.figures.length !== expectedFigures
        )
          alternatives = unavailableImageAlternatives();
        warnings = 0;
        const alternativeOperators = imageAlternativeStructure.allowBounds
          ? await prepareImageAlternativeBounds(
              page,
              alternatives,
              imageAlternativeBudget
            )
          : null;
        await page.render({
          canvas: target.canvas,
          canvasContext: target.context,
          viewport,
          background: "#ffffff",
          recordOperations: alternativeOperators !== null,
        }).promise;
        // Do not silently omit images/fonts that PDF.js warns it cannot render.
        if (warnings > 0) fail();
        const imageAlternatives = locateImageAlternatives(
          page,
          alternatives,
          alternativeOperators,
          OPS
        );
        const png = await target.canvas.encode("png");
        totalPng += png.length;
        if (png.length > MAX_PNG || totalPng > MAX_TOTAL_PNG) fail();
        const text = await extractText(page, MAX_TOTAL_TEXT - totalText);
        // Text is optional and has no authority over a successfully rendered page.
        warnings = 0;
        totalText += text?.length ?? 0;
        pages.push({
          pageNumber,
          width,
          height,
          png: png.toString("base64"),
          text,
          imageAlternatives,
        });
      } finally {
        document.canvasFactory.destroy(target);
        page.cleanup();
      }
    }
    await task.destroy();
    process.stdout.write(
      JSON.stringify({ ok: true, pageCount: pages.length, pages })
    );
  } finally {
    await task.destroy();
  }
}

try {
  await render();
} catch {
  // Errors can contain document strings, paths or native details. Never return them.
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exitCode = 1;
}
