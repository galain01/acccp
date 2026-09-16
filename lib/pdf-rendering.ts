// Node-only, memory-only renderer. Uploaded bytes never become arguments or files.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { MAX_FILE_SIZE_BYTES } from "./document-input";
import {
  createJobDiagnostic,
  describeJobDiagnostic,
  type JobDiagnostic,
} from "./job-diagnostics";

export interface PdfImageAlternative {
  /** Generated per-page occurrence ID, never a source-supplied identifier. */
  id: string;
  alt: string;
  /** Measured region in the rendered page; top-left origin, normalized 0..1. */
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface PdfImageAlternatives {
  /** Complete describes extraction, not the quality of the source descriptions. */
  status: "complete" | "unavailable";
  figures: PdfImageAlternative[];
}

export interface RenderedPdfPage {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
  /** Null means optional text extraction was unavailable or exceeded its bounds. */
  text: string | null;
  imageAlternatives: PdfImageAlternatives;
}

export interface RenderedPdf {
  pageCount: number;
  pages: RenderedPdfPage[];
}

// Keep these protocol bounds synchronized with the fixed child renderer.
export const PDF_RENDERING_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxPages: 60,
  maxPagePixels: 2_000_000,
  maxPageDimension: 4096,
  maxTotalPagePixels: 120_000_000,
  maxImagePixels: 24_000_000,
  maxImageDimension: 8192,
  maxPageImagePixels: 32_000_000,
  maxDeclaredImagePixels: 480_000_000,
  maxPngBytes: 8 * 1024 * 1024,
  maxTotalPngBytes: 24 * 1024 * 1024,
  maxPageTextChars: 100_000,
  maxTotalTextChars: 500_000,
  maxFiguresPerPage: 100,
  maxFigures: 500,
  maxAltChars: 8_000,
  maxPageAltChars: 32_000,
  maxTotalAltChars: 128_000,
  maxStderrBytes: 16 * 1024,
});

export const PDF_RENDERING_QUEUE_LIMITS = Object.freeze({
  maxWaiting: 4,
  timeoutMs: 30_000,
});

export class PdfRenderingError extends Error {
  readonly diagnostic: JobDiagnostic;

  constructor(diagnostic?: JobDiagnostic) {
    const safe = createJobDiagnostic(
      diagnostic ?? { stage: "pdf_render", code: "unknown_error" }
    );
    super(describeJobDiagnostic(safe));
    this.name = "PdfRenderingError";
    this.diagnostic = safe;
  }
}

// The child uses a fixed, data-only failure protocol; no library exception text.
const PDF_FAILURE_CODES = [
  "pdf_invalid",
  "pdf_password",
  "pdf_page_limit",
  "pdf_image_limit",
  "pdf_complexity_limit",
  "pdf_render_warning",
  "pdf_page_failed",
  "pdf_output_limit",
  "pdf_timeout",
  "pdf_worker_failed",
  "pdf_protocol_error",
  "unknown_error",
] as const;
type PdfFailureCode = (typeof PDF_FAILURE_CODES)[number];

function renderingError(
  code: PdfFailureCode,
  pageNumber?: number,
  elapsedMs?: number
): PdfRenderingError {
  return new PdfRenderingError(
    createJobDiagnostic({ stage: "pdf_render", code, pageNumber, elapsedMs })
  );
}

type ReleaseRenderer = () => void;
interface RendererWaiter {
  resolve: (release: ReleaseRenderer) => void;
  reject: (error: PdfRenderingError) => void;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  elapsed: () => number;
}
interface RendererQueue {
  active: boolean;
  waiting: RendererWaiter[];
}

// Bundled routes can evaluate this module independently within one Node process.
// Sharing the gate prevents their native-memory-heavy children from overlapping.
// Separate server processes still have separate gates.
const rendererQueueKey = Symbol.for("acccp.pdf-renderer-queue.v1");
const rendererGlobals = globalThis as typeof globalThis & {
  [rendererQueueKey]?: RendererQueue;
};
const rendererQueue = (rendererGlobals[rendererQueueKey] ??= {
  active: false,
  waiting: [],
});

function rendererBusy(elapsed: () => number): PdfRenderingError {
  return new PdfRenderingError({
    version: 1,
    stage: "pdf_render",
    code: "pdf_renderer_busy",
    elapsedMs: elapsed(),
  });
}

function rendererRelease(): ReleaseRenderer {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let waiter: RendererWaiter | undefined;
    while ((waiter = rendererQueue.waiting.shift())) {
      clearTimeout(waiter.timer);
      // Honor the deadline even if a blocked event loop delayed its timer.
      if (performance.now() >= waiter.deadline) {
        waiter.reject(rendererBusy(waiter.elapsed));
        continue;
      }
      waiter.resolve(rendererRelease());
      return;
    }
    rendererQueue.active = false;
  };
}

function acquireRenderer(
  elapsed: () => number
): ReleaseRenderer | Promise<ReleaseRenderer> {
  if (!rendererQueue.active) {
    rendererQueue.active = true;
    return rendererRelease();
  }
  if (rendererQueue.waiting.length >= PDF_RENDERING_QUEUE_LIMITS.maxWaiting)
    throw rendererBusy(elapsed);
  return new Promise((resolve, reject) => {
    const waiter: RendererWaiter = {
      resolve,
      reject,
      elapsed,
      deadline: performance.now() + PDF_RENDERING_QUEUE_LIMITS.timeoutMs,
      timer: setTimeout(() => {
        const index = rendererQueue.waiting.indexOf(waiter);
        if (index === -1) return;
        rendererQueue.waiting.splice(index, 1);
        reject(rendererBusy(elapsed));
      }, PDF_RENDERING_QUEUE_LIMITS.timeoutMs),
    };
    rendererQueue.waiting.push(waiter);
  });
}

const MAX_STDIN_BYTES = Math.ceil(MAX_FILE_SIZE_BYTES / 3) * 4 + 64;
const MAX_STDOUT_BYTES =
  Math.ceil(PDF_RENDERING_LIMITS.maxTotalPngBytes / 3) * 4 +
  PDF_RENDERING_LIMITS.maxTotalTextChars * 6 +
  PDF_RENDERING_LIMITS.maxTotalAltChars * 6 +
  PDF_RENDERING_LIMITS.maxFigures * 256 +
  64 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailure(value: Record<string, unknown>): JobDiagnostic {
  if (
    value.ok !== false ||
    !PDF_FAILURE_CODES.includes(value.code as PdfFailureCode) ||
    Object.keys(value).some(
      (key) => !["ok", "code", "pageNumber"].includes(key)
    ) ||
    (value.pageNumber !== undefined &&
      (typeof value.pageNumber !== "number" ||
        !Number.isSafeInteger(value.pageNumber) ||
        value.pageNumber < 1 ||
        value.pageNumber > PDF_RENDERING_LIMITS.maxPages))
  )
    throw renderingError("pdf_protocol_error");
  return createJobDiagnostic({
    stage: "pdf_render",
    code: value.code,
    pageNumber: value.pageNumber,
  });
}

function parseImageAlternatives(
  value: unknown,
  pageNumber: number,
  budget: { figures: number; chars: number }
): PdfImageAlternatives {
  const unavailable: PdfImageAlternatives = {
    status: "unavailable",
    figures: [],
  };
  const limits = PDF_RENDERING_LIMITS;
  if (
    !isRecord(value) ||
    value.status !== "complete" ||
    !Array.isArray(value.figures) ||
    value.figures.length > limits.maxFiguresPerPage ||
    budget.figures + value.figures.length > limits.maxFigures
  )
    return unavailable;
  const figures: PdfImageAlternative[] = [];
  let chars = 0;
  for (const [index, figure] of value.figures.entries()) {
    if (
      !isRecord(figure) ||
      figure.id !== `p${pageNumber}-figure${index + 1}` ||
      typeof figure.alt !== "string" ||
      figure.alt.length > limits.maxAltChars
    )
      return unavailable;
    chars += figure.alt.length;
    if (
      chars > limits.maxPageAltChars ||
      budget.chars + chars > limits.maxTotalAltChars
    )
      return unavailable;
    let bounds: PdfImageAlternative["bounds"] = null;
    if (figure.bounds !== null) {
      const box = figure.bounds;
      if (
        !isRecord(box) ||
        ![box.x, box.y, box.width, box.height].every(
          (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1
        )
      )
        return unavailable;
      const { x, y, width, height } = box as NonNullable<
        PdfImageAlternative["bounds"]
      >;
      if (
        width <= 0 ||
        height <= 0 ||
        x + width > 1.000001 ||
        y + height > 1.000001
      )
        return unavailable;
      bounds = { x, y, width, height };
    }
    figures.push({ id: figure.id as string, alt: figure.alt, bounds });
  }
  budget.figures += figures.length;
  budget.chars += chars;
  return { status: "complete", figures };
}

function parseResult(value: unknown): RenderedPdf {
  const limits = PDF_RENDERING_LIMITS;
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.pageCount !== "number" ||
    !Number.isSafeInteger(value.pageCount) ||
    value.pageCount < 1 ||
    value.pageCount > limits.maxPages ||
    !Array.isArray(value.pages) ||
    value.pages.length !== value.pageCount
  ) {
    throw renderingError("pdf_protocol_error");
  }
  let totalBytes = 0;
  let totalPixels = 0;
  let totalTextChars = 0;
  const alternativeBudget = { figures: 0, chars: 0 };
  const pages = value.pages.map((page: unknown, index): RenderedPdfPage => {
    if (!isRecord(page)) throw renderingError("pdf_protocol_error");
    const { pageNumber, width, height, png: encoded, text } = page;
    if (
      pageNumber !== index + 1 ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > limits.maxPageDimension ||
      height > limits.maxPageDimension ||
      width * height > limits.maxPagePixels ||
      typeof encoded !== "string" ||
      encoded.length > Math.ceil(limits.maxPngBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      (text !== null && typeof text !== "string") ||
      (typeof text === "string" && text.length > limits.maxPageTextChars)
    ) {
      throw renderingError("pdf_protocol_error");
    }
    const png = Buffer.from(encoded, "base64");
    totalBytes += png.length;
    totalPixels += width * height;
    totalTextChars += typeof text === "string" ? text.length : 0;
    if (
      png.length < 24 ||
      png.length > limits.maxPngBytes ||
      totalBytes > limits.maxTotalPngBytes ||
      totalPixels > limits.maxTotalPagePixels ||
      totalTextChars > limits.maxTotalTextChars ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
      png.readUInt32BE(16) !== width ||
      png.readUInt32BE(20) !== height
    ) {
      throw renderingError("pdf_protocol_error");
    }
    const imageAlternatives = parseImageAlternatives(
      page.imageAlternatives,
      pageNumber,
      alternativeBudget
    );
    return { pageNumber, width, height, png, text, imageAlternatives };
  });
  return { pageCount: value.pageCount, pages };
}

/**
 * Render every physical page once; failure never falls back to a text-only source.
 * The child has no inherited app environment, bounded pipes and an OS process
 * deadline. Native memory is isolated from the parent JS heap, not OS-sandboxed.
 */
export async function renderPdfPages(buffer: Buffer): Promise<RenderedPdf> {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length > MAX_FILE_SIZE_BYTES ||
    buffer.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw renderingError("pdf_invalid", undefined, elapsed());
  }
  const slot = acquireRenderer(elapsed);
  const release = typeof slot === "function" ? slot : await slot;
  try {
    // Queued requests retain only their original bytes, not another base64 copy.
    const request = JSON.stringify({ pdf: buffer.toString("base64") });
    if (Buffer.byteLength(request) > MAX_STDIN_BYTES)
      throw renderingError("pdf_invalid", undefined, elapsed());
    const root = process.cwd();
    const childPath = join(root, "lib", "pdf-rendering-child.mjs");
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    // Windows may need this public OS path to load system DLLs. No user/app vars.
    if (process.platform === "win32" && process.env.SystemRoot) {
      env.SystemRoot = process.env.SystemRoot;
    }

    return await new Promise<RenderedPdf>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          process.execPath,
          [
            "--max-old-space-size=192",
            "--permission",
            "--allow-addons",
            `--allow-fs-read=${childPath}`,
            `--allow-fs-read=${join(root, "lib", "pdf-image-alternatives.mjs")}`,
            `--allow-fs-read=${join(root, "node_modules", "pdf-lib", "dist", "pdf-lib.min.js")}`,
            `--allow-fs-read=${join(root, "node_modules", "pdfjs-dist")}`,
            `--allow-fs-read=${join(root, "node_modules", "@napi-rs")}`,
            childPath,
          ],
          { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
        );
      } catch {
        reject(renderingError("pdf_worker_failed", undefined, elapsed()));
        return;
      }
      let closed = false;
      let failureCode: PdfFailureCode | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const chunks: Buffer[] = [];
      const stop = (code: PdfFailureCode) => {
        if (closed) return;
        // Preserve the first observed failure instead of replacing a timeout with
        // a subsequent pipe error caused by terminating the same worker.
        failureCode ??= code;
        child.stdin?.destroy();
        // SIGKILL maps to forceful process termination on Windows as well.
        child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () => stop("pdf_timeout"),
        PDF_RENDERING_LIMITS.timeoutMs
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) stop("pdf_output_limit");
        else if (!failureCode) chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        // Discard native/library output privately; never retain document errors.
        stderrBytes += chunk.length;
        if (stderrBytes > PDF_RENDERING_LIMITS.maxStderrBytes)
          stop("pdf_worker_failed");
      });
      child.on("error", () => stop("pdf_worker_failed"));
      child.stdin?.on("error", () => stop("pdf_worker_failed"));
      child.once("close", (code) => {
        closed = true;
        clearTimeout(timer);
        if (failureCode) {
          reject(renderingError(failureCode, undefined, elapsed()));
          return;
        }
        if (stdoutBytes === 0 && code !== 0) {
          reject(renderingError("pdf_worker_failed", undefined, elapsed()));
          return;
        }
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          );
          if (isRecord(value) && value.ok === false) {
            if (stdoutBytes > 512) throw renderingError("pdf_protocol_error");
            throw new PdfRenderingError(
              createJobDiagnostic({
                ...parseFailure(value),
                elapsedMs: elapsed(),
              })
            );
          }
          if (code !== 0) throw renderingError("pdf_worker_failed");
          resolve(parseResult(value));
        } catch (error) {
          const diagnostic =
            error instanceof PdfRenderingError
              ? error.diagnostic
              : { stage: "pdf_render", code: "pdf_protocol_error" };
          reject(
            new PdfRenderingError(
              createJobDiagnostic({ ...diagnostic, elapsedMs: elapsed() })
            )
          );
        }
      });
      // Await close even on failure: rejection never leaves a renderer running.
      try {
        child.stdin?.end(request);
      } catch {
        stop("pdf_worker_failed");
      }
    });
  } finally {
    release();
  }
}
