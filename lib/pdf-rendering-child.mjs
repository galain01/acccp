import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { loadPdfWithRevisions } from "./pdf-revisions.mjs";
import { isRecoverableFontHintWarning } from "./pdf-render-warnings.mjs";
import { createPdfImageUsageInspector } from "./pdf-image-usage.mjs";
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
    (...args) => {
      // Only a verified hint-bytecode recovery is nonfatal with our fixed
      // outline-rendering configuration. Unknown warnings still fail closed.
      if (!isRecoverableFontHintWarning(args)) warnings++;
    };
console.debug = () => {};

// The parent chooses this fixed mode, outside untrusted PDF/stdin content.
// Keep these bounds aligned with document-input.ts; both modes retain the
// same page, pixel, image, text and output limits below.
const MAX_INPUT =
  process.argv.length === 3 && process.argv[2] === "--powerpoint-preview"
    ? 16 * 1024 * 1024
    : 4 * 1024 * 1024;
const MAX_STDIN = Math.ceil(MAX_INPUT / 3) * 4 + 64;
const MAX_PAGES = 60;
const MAX_PAGE_PIXELS = 2_000_000;
const MAX_DIMENSION = 4096;
const MAX_TOTAL_PIXELS = 120_000_000;
const MAX_IMAGE_PIXELS = 24_000_000;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_PAGE_DECLARED_IMAGE_PIXELS = 32_000_000;
const MAX_DECLARED_IMAGE_PIXELS = 480_000_000;
const MAX_PREFLIGHT_OBJECTS = 100_000;
const MAX_PNG = 8 * 1024 * 1024;
const MAX_TOTAL_PNG = 24 * 1024 * 1024;
const MAX_PAGE_TEXT = 100_000;
const MAX_TOTAL_TEXT = 500_000;
const MAX_PAGE_TEXT_REGIONS = 5000;
const MAX_TOTAL_TEXT_REGIONS = 20_000;

let currentPage;
let guardedFailure;
const passwordErrorTypes = [];
const invalidPdfErrorTypes = [];
class RendererFailure extends Error {
  constructor(code, pageNumber) {
    super("PDF rendering stopped.");
    this.code = code;
    this.pageNumber = pageNumber;
  }
}
function fail(code, pageNumber = currentPage) {
  // A parser may catch a canvas/object guard and later issue only a warning.
  // Keep the original observed limit and page rather than replacing its cause.
  guardedFailure ??= new RendererFailure(code, pageNumber);
  throw guardedFailure;
}
function checkCanvas(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    fail("pdf_page_failed");
  if (width * height > MAX_IMAGE_PIXELS) fail("pdf_image_limit");
}

async function preflightImages(bytes) {
  // Inspect stream dictionaries without decoding image payloads. PDF.js checks
  // only the base image's dimensions; larger SMask/Mask streams otherwise bypass
  // maxImageSize. Include unreferenced objects and nested masks conservatively.
  const require = createRequire(import.meta.url);
  const pdfLib = require(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      "pdf-lib",
      "dist",
      "pdf-lib.min.js"
    )
  );
  const {
    PDFRawStream,
    PDFDict,
    PDFArray,
    PDFName,
    PDFNumber,
    PDFString,
    PDFHexString,
    PDFRef,
  } = pdfLib;
  // Use the saved-revision index rather than physical object order. The same
  // current definitions must be inspected here and rendered by PDF.js below.
  let document;
  try {
    document = await loadPdfWithRevisions(bytes, pdfLib, {
      maxObjects: MAX_PREFLIGHT_OBJECTS,
      fail,
    });
  } catch (error) {
    if (error instanceof RendererFailure) throw error;
    // The input failed the bounded parser call; no exception text is examined.
    fail("pdf_invalid");
  }
  if (guardedFailure) throw guardedFailure;
  if (document.isEncrypted) fail("pdf_password");
  if (document.getPageCount() < 1) fail("pdf_invalid");
  if (document.getPageCount() > MAX_PAGES) fail("pdf_page_limit");
  const objects = document.context.enumerateIndirectObjects();
  if (objects.length > MAX_PREFLIGHT_OBJECTS) fail("pdf_complexity_limit");
  const pending = objects.map(([, object]) => object);
  const visited = new Set();
  const streams = new Set();
  const masks = new Set();
  const name = (key) => PDFName.of(key);
  while (pending.length) {
    const object = document.context.lookup(pending.pop());
    if (!object || visited.has(object)) continue;
    visited.add(object);
    if (visited.size > MAX_PREFLIGHT_OBJECTS) fail("pdf_complexity_limit");
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
    if (pending.length > MAX_PREFLIGHT_OBJECTS) fail("pdf_complexity_limit");
  }
  const dimensions = new Map();
  const dimension = (dict, short, long) => {
    const shortValue = dict.lookup(name(short));
    const longValue = dict.lookup(name(long));
    const value = shortValue ?? longValue;
    if (!(value instanceof PDFNumber)) fail("pdf_invalid");
    const number = value.asNumber();
    if (!Number.isSafeInteger(number) || number < 1) fail("pdf_invalid");
    if (number > MAX_IMAGE_DIMENSION) fail("pdf_image_limit");
    if (
      shortValue &&
      longValue &&
      (!(longValue instanceof PDFNumber) || longValue.asNumber() !== number)
    )
      fail("pdf_invalid");
    return number;
  };
  for (const stream of streams) {
    const dict = stream.dict;
    // An xref stream's /W array describes index field widths, not image width.
    // Still inspect any stream used as an image/mask or declaring image sizes;
    // a misleading /Type must not exempt a resource that PDF.js can decode.
    if (
      dict.lookup(name("Type")) === name("XRef") &&
      dict.lookup(name("W")) instanceof PDFArray &&
      dict.lookup(name("Subtype")) !== name("Image") &&
      !masks.has(stream) &&
      !["Width", "H", "Height"].some((key) => dict.has(name(key)))
    )
      continue;
    if (
      dict.lookup(name("Subtype")) !== name("Image") &&
      !masks.has(stream) &&
      !["W", "Width", "H", "Height"].some((key) => dict.has(name(key)))
    )
      continue;
    const width = dimension(dict, "W", "Width");
    const height = dimension(dict, "H", "Height");
    if (width * height > MAX_IMAGE_PIXELS) fail("pdf_image_limit");
    dimensions.set(stream, { width, height });
  }
  const declaredAreas = new Map();
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
    if (pixels > MAX_IMAGE_PIXELS) fail("pdf_image_limit");
    declaredAreas.set(stream, pixels);
    totalPixels += pixels;
    if (totalPixels > MAX_DECLARED_IMAGE_PIXELS) fail("pdf_image_limit");
  }
  const usageInspector = createPdfImageUsageInspector(document, pdfLib, {
    maxObjects: MAX_PREFLIGHT_OBJECTS,
  });
  // Pages render sequentially. A shared resource dictionary can list images
  // from the entire document; count only the page's referenced images when the
  // bounded content inspector can prove their use. Otherwise retain the full
  // resource-graph guard, including complex appearances, fonts and patterns.
  for (const [index, page] of document.getPages().entries()) {
    const pageNumber = index + 1;
    const usage = usageInspector.inspectPage(page);
    if (
      usage.precise &&
      [...usage.images].every((image) => declaredAreas.has(image))
    ) {
      let usedPixels = 0;
      for (const image of usage.images) {
        usedPixels += declaredAreas.get(image);
        if (usedPixels > MAX_PAGE_DECLARED_IMAGE_PIXELS)
          fail("pdf_image_limit", pageNumber);
      }
      continue;
    }
    const pendingResources = [];
    const seen = new Map();
    const countedImages = new Set();
    let visits = 0;
    let pagePixels = 0;
    const enqueue = (kind, object) => {
      if (object) pendingResources.push([kind, object]);
      if (pendingResources.length > MAX_PREFLIGHT_OBJECTS)
        fail("pdf_complexity_limit", pageNumber);
    };
    const enqueueValues = (kind, dictionary) => {
      if (dictionary instanceof PDFDict)
        for (const value of dictionary.values()) enqueue(kind, value);
    };
    // PDF.js merges inherited resource categories. On the conservative path,
    // include every ancestor dictionary so partially inherited images cannot
    // escape the guard. Object identities still deduplicate shared images.
    let ancestor = page.node;
    const ancestors = new Set();
    while (ancestor instanceof PDFDict) {
      if (ancestors.has(ancestor)) fail("pdf_invalid", pageNumber);
      ancestors.add(ancestor);
      if (ancestors.size > MAX_PREFLIGHT_OBJECTS)
        fail("pdf_complexity_limit", pageNumber);
      const resources = ancestor.lookup(name("Resources"));
      if (resources instanceof PDFDict) {
        enqueue("resources", resources);
      }
      ancestor = ancestor.lookup(name("Parent"));
    }
    const annotations = page.node.lookup(name("Annots"));
    if (annotations instanceof PDFArray)
      for (const annotation of annotations.asArray())
        enqueue("annotation", annotation);
    while (pendingResources.length) {
      const [kind, ref] = pendingResources.pop();
      const object = document.context.lookup(ref);
      if (!object) continue;
      let kinds = seen.get(object);
      if (kinds?.has(kind)) continue;
      if (!kinds) seen.set(object, (kinds = new Set()));
      kinds.add(kind);
      if (++visits > MAX_PREFLIGHT_OBJECTS)
        fail("pdf_complexity_limit", pageNumber);
      const dict = object instanceof PDFRawStream ? object.dict : object;
      if (!(dict instanceof PDFDict)) continue;
      if (kind === "resources") {
        enqueueValues("stream", dict.lookup(name("XObject")));
        enqueueValues("stream", dict.lookup(name("Pattern")));
        enqueueValues("font", dict.lookup(name("Font")));
        enqueueValues("graphicsState", dict.lookup(name("ExtGState")));
      } else if (kind === "annotation") {
        enqueue("appearances", dict.lookup(name("AP")));
      } else if (kind === "appearances") {
        for (const state of ["N", "R", "D"])
          enqueue("appearanceState", dict.lookup(name(state)));
      } else if (kind === "appearanceState") {
        if (object instanceof PDFRawStream) enqueue("stream", object);
        else enqueueValues("stream", dict);
      } else if (kind === "graphicsState") {
        const mask = dict.lookup(name("SMask"));
        if (mask instanceof PDFDict) enqueue("stream", mask.lookup(name("G")));
        const font = dict.lookup(name("Font"));
        if (font instanceof PDFArray) enqueue("font", font.get(0));
      } else if (kind === "font") {
        enqueue("resources", dict.lookup(name("Resources")));
        enqueueValues("stream", dict.lookup(name("CharProcs")));
      } else if (kind === "stream") {
        if (declaredAreas.has(object) && !countedImages.has(object)) {
          countedImages.add(object);
          pagePixels += declaredAreas.get(object);
          if (pagePixels > MAX_PAGE_DECLARED_IMAGE_PIXELS)
            fail("pdf_image_limit", pageNumber);
        }
        enqueue("resources", dict.lookup(name("Resources")));
        for (const mask of ["SMask", "Mask"])
          enqueue("stream", dict.lookup(name(mask)));
      }
    }
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

async function extractText(
  page,
  remaining,
  viewport,
  includeRegions,
  regionBudget
) {
  if (remaining <= 0) return { text: null, textRegions: null };
  let reader;
  try {
    reader = page.streamTextContent().getReader();
    const parts = [];
    const textRegions = [];
    let regionsUnavailable = !includeRegions;
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
        if (!regionsUnavailable && item.str.trim()) {
          const m = item.transform;
          const v = viewport.transform;
          const finite =
            Array.isArray(m) &&
            m.length === 6 &&
            m.every(Number.isFinite) &&
            Array.isArray(v) &&
            v.length === 6 &&
            v.every(Number.isFinite);
          // Native Word pages are horizontal. Rotated/sheared text needs a
          // different geometric proof, so it makes this optional evidence unavailable.
          if (
            !finite ||
            Math.abs(m[1]) > 0.0001 ||
            Math.abs(m[2]) > 0.0001 ||
            m[0] <= 0 ||
            m[3] <= 0 ||
            Math.abs(v[1]) > 0.0001 ||
            Math.abs(v[2]) > 0.0001 ||
            v[0] <= 0 ||
            v[3] >= 0 ||
            !Number.isFinite(item.width) ||
            item.width <= 0 ||
            textRegions.length >= MAX_PAGE_TEXT_REGIONS ||
            regionBudget.count + textRegions.length >= MAX_TOTAL_TEXT_REGIONS
          ) {
            regionsUnavailable = true;
            textRegions.length = 0;
          } else {
            const x = Math.max(0, v[0] * m[4] + v[4] - 1);
            const fontHeight = Math.abs(v[3] * m[3]);
            const baseline = v[3] * m[5] + v[5];
            const y = Math.max(0, baseline - fontHeight * 1.2 - 1);
            const right = Math.min(
              Math.ceil(viewport.width),
              v[0] * m[4] + v[4] + item.width * v[0] + 1
            );
            const bottom = Math.min(
              Math.ceil(viewport.height),
              baseline + fontHeight * 0.3 + 1
            );
            if (
              ![x, y, right, bottom].every(Number.isFinite) ||
              right <= x ||
              bottom <= y
            ) {
              regionsUnavailable = true;
              textRegions.length = 0;
            } else
              textRegions.push({
                text: item.str,
                x,
                y,
                width: right - x,
                height: bottom - y,
              });
          }
        }
      }
    }
    if (exceeded) return { text: null, textRegions: null };
    if (!regionsUnavailable) regionBudget.count += textRegions.length;
    return {
      text: parts.join("").trim(),
      textRegions: regionsUnavailable ? null : textRegions,
    };
  } catch {
    return { text: null, textRegions: null };
  }
}

async function render() {
  const input = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    inputBytes += chunk.length;
    if (inputBytes > MAX_STDIN) fail("pdf_protocol_error");
    input.push(chunk);
  }
  let message;
  try {
    message = JSON.parse(Buffer.concat(input).toString("utf8"));
  } catch {
    fail("pdf_protocol_error");
  }
  if (
    !message ||
    typeof message.pdf !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(message.pdf)
  )
    fail("pdf_protocol_error");
  const bytes = new Uint8Array(Buffer.from(message.pdf, "base64"));
  if (
    bytes.byteLength > MAX_INPUT ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  )
    fail("pdf_invalid");
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
  const { getDocument, OPS, PasswordException, InvalidPDFException } =
    await import("pdfjs-dist/legacy/build/pdf.mjs");
  passwordErrorTypes.push(PasswordException);
  invalidPdfErrorTypes.push(InvalidPDFException);
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
    // error. Its warning path is reliable; content/unknown warnings fail below.
    stopAtErrors: false,
    verbosity: 1,
  });
  try {
    const document = await task.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1)
      fail("pdf_invalid");
    if (document.numPages > MAX_PAGES) fail("pdf_page_limit");
    // Startup/parser warnings cannot reliably be assigned to a physical page.
    if (warnings > 0) fail("pdf_render_warning");
    const pages = [];
    const imageAlternativeBudget = createImageAlternativeBudget();
    const regionBudget = { count: 0 };
    let totalPixels = 0,
      totalPng = 0,
      totalText = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      currentPage = pageNumber;
      const page = await document.getPage(pageNumber);
      let viewport = page.getViewport({ scale: 2 });
      if (
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0
      )
        fail("pdf_page_failed");
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
        fail("pdf_output_limit");
      const target = document.canvasFactory.create(width, height);
      try {
        // Unlike visible page text, authored image alternatives live in tags.
        // PDF.js may warn when it cannot read the complete tree. Treat that as
        // unavailable metadata, never as proof that no descriptions existed.
        if (warnings > 0) fail("pdf_render_warning");
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
        if (guardedFailure) throw guardedFailure;
        // Do not silently omit images/fonts that PDF.js warns it cannot render.
        if (warnings > 0) fail("pdf_render_warning");
        const imageAlternatives = locateImageAlternatives(
          page,
          alternatives,
          alternativeOperators,
          OPS
        );
        const png = await target.canvas.encode("png");
        totalPng += png.length;
        if (png.length > MAX_PNG || totalPng > MAX_TOTAL_PNG)
          fail("pdf_output_limit");
        const { text, textRegions } = await extractText(
          page,
          MAX_TOTAL_TEXT - totalText,
          viewport,
          message.includeTextRegions === true,
          regionBudget
        );
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
          ...(message.includeTextRegions === true ? { textRegions } : {}),
        });
      } finally {
        document.canvasFactory.destroy(target);
        page.cleanup();
      }
    }
    currentPage = undefined;
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
} catch (error) {
  // Errors can contain document strings, paths or native details. Never return them.
  const matches = (types) =>
    types.some((type) => typeof type === "function" && error instanceof type);
  const failure =
    guardedFailure ?? (error instanceof RendererFailure ? error : undefined);
  const code = failure
    ? failure.code
    : matches(passwordErrorTypes)
      ? "pdf_password"
      : matches(invalidPdfErrorTypes)
        ? "pdf_invalid"
        : currentPage === undefined
          ? "pdf_worker_failed"
          : "pdf_page_failed";
  const pageNumber = failure ? failure.pageNumber : currentPage;
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code,
      ...(Number.isSafeInteger(pageNumber) &&
      pageNumber >= 1 &&
      pageNumber <= MAX_PAGES
        ? { pageNumber }
        : {}),
    })
  );
  process.exitCode = 1;
}
