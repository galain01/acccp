// Node-only, memory-only renderer. Uploaded bytes never become arguments or files.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { MAX_FILE_SIZE_BYTES } from "./document-input";

export interface RenderedPdfPage {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
  /** Null means optional text extraction was unavailable or exceeded its bounds. */
  text: string | null;
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
  maxImagePixels: 8_000_000,
  maxImageDimension: 8192,
  maxDeclaredImagePixels: 32_000_000,
  maxPngBytes: 8 * 1024 * 1024,
  maxTotalPngBytes: 24 * 1024 * 1024,
  maxPageTextChars: 100_000,
  maxTotalTextChars: 500_000,
  maxStderrBytes: 16 * 1024,
});

export class PdfRenderingError extends Error {
  constructor() {
    super(
      "This PDF could not be rendered within the supported limits. Re-export a fresh PDF of up to 60 pages, or try a smaller or simpler PDF."
    );
    this.name = "PdfRenderingError";
  }
}

const MAX_STDIN_BYTES = Math.ceil(MAX_FILE_SIZE_BYTES / 3) * 4 + 64;
const MAX_STDOUT_BYTES =
  Math.ceil(PDF_RENDERING_LIMITS.maxTotalPngBytes / 3) * 4 +
  PDF_RENDERING_LIMITS.maxTotalTextChars * 6 +
  64 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    throw new PdfRenderingError();
  }
  let totalBytes = 0;
  let totalPixels = 0;
  let totalTextChars = 0;
  const pages = value.pages.map((page: unknown, index): RenderedPdfPage => {
    if (!isRecord(page)) throw new PdfRenderingError();
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
      throw new PdfRenderingError();
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
      throw new PdfRenderingError();
    }
    return { pageNumber, width, height, png, text };
  });
  return { pageCount: value.pageCount, pages };
}

/**
 * Render every physical page once; failure never falls back to a text-only source.
 * The child has no inherited app environment, bounded pipes and an OS process
 * deadline. Native memory is isolated from the parent JS heap, not OS-sandboxed.
 */
export async function renderPdfPages(buffer: Buffer): Promise<RenderedPdf> {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length > MAX_FILE_SIZE_BYTES ||
    buffer.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new PdfRenderingError();
  }
  const request = JSON.stringify({ pdf: buffer.toString("base64") });
  if (Buffer.byteLength(request) > MAX_STDIN_BYTES)
    throw new PdfRenderingError();
  const root = process.cwd();
  const childPath = join(root, "lib", "pdf-rendering-child.mjs");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  // Windows may need this public OS path to load system DLLs. No user/app vars.
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [
          "--max-old-space-size=192",
          "--permission",
          "--allow-addons",
          `--allow-fs-read=${childPath}`,
          `--allow-fs-read=${join(root, "node_modules", "pdf-lib", "dist", "pdf-lib.min.js")}`,
          `--allow-fs-read=${join(root, "node_modules", "pdfjs-dist")}`,
          `--allow-fs-read=${join(root, "node_modules", "@napi-rs")}`,
          childPath,
        ],
        { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch {
      reject(new PdfRenderingError());
      return;
    }
    let closed = false;
    let failed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks: Buffer[] = [];
    const stop = () => {
      if (closed) return;
      failed = true;
      child.stdin?.destroy();
      // SIGKILL maps to forceful process termination on Windows as well.
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, PDF_RENDERING_LIMITS.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) stop();
      else if (!failed) chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Discard native/library output privately; never retain document errors.
      stderrBytes += chunk.length;
      if (stderrBytes > PDF_RENDERING_LIMITS.maxStderrBytes) stop();
    });
    child.on("error", stop);
    child.stdin?.on("error", stop);
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timer);
      if (failed || code !== 0) {
        reject(new PdfRenderingError());
        return;
      }
      try {
        resolve(
          parseResult(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        );
      } catch {
        reject(new PdfRenderingError());
      }
    });
    // Await close even on failure: rejection never leaves a renderer running.
    child.stdin?.end(request);
  });
}
