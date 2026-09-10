import "server-only";

import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { MAX_FILE_SIZE_BYTES } from "./document-input";

export const PDF_PAGE_COUNT_TIMEOUT_MS = 3_000;

// Fixed worker code; uploaded bytes are data, never executable source. The
// self-contained distribution is explicitly traced into the conversion route.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
console.log = console.warn = console.error = () => {};
(async () => {
  try {
    const { PDFDocument, ParseSpeeds } = require(workerData.parserPath);
    const document = await PDFDocument.load(workerData.bytes, {
      parseSpeed: ParseSpeeds.Fastest,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    parentPort.postMessage(document.getPageCount());
  } catch {
    parentPort.postMessage(null);
  }
})();
`;

/**
 * Count the final PDF without blocking the request's event loop on an untrusted
 * parser. Input, runtime and worker JS heap are bounded; encrypted, malformed,
 * oversized or resource-intensive PDFs simply have an unknown page count.
 */
export async function countPdfPages(buffer: Buffer): Promise<number | null> {
  if (
    buffer.byteLength > MAX_FILE_SIZE_BYTES ||
    buffer.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    return null;
  }

  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Termination is real cancellation, unlike racing PDFDocument.load on
      // the main thread. Never print parser errors or document-derived output.
      void worker?.terminate().catch(() => {});
      resolve(
        typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value > 0 &&
          value <= 2_147_483_647
          ? value
          : null
      );
    };

    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          // Turbopack rewrites require.resolve to an internal numeric module
          // ID. A worker needs the actual file included by output-file tracing.
          parserPath: join(
            process.cwd(),
            "node_modules",
            "pdf-lib",
            "dist",
            "pdf-lib.min.js"
          ),
          bytes: new Uint8Array(buffer),
        },
        env: {},
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      });
      // Drain privately so unexpected library output cannot fill buffers or
      // reach host logs. The worker environment contains no app credentials.
      worker.stdout?.resume();
      worker.stderr?.resume();
      worker.once("message", finish);
      worker.once("error", () => finish(null));
      worker.once("exit", () => finish(null));
      timer = setTimeout(() => finish(null), PDF_PAGE_COUNT_TIMEOUT_MS);
    } catch {
      finish(null);
    }
  });
}
