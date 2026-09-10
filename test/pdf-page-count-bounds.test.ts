import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ worker: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:worker_threads", () => ({ Worker: mocks.worker }));

import { countPdfPages, PDF_PAGE_COUNT_TIMEOUT_MS } from "@/lib/pdf-page-count";
import { MAX_FILE_SIZE_BYTES } from "@/lib/document-input";

let worker: EventEmitter & {
  terminate: ReturnType<typeof vi.fn>;
  stdout: { resume: ReturnType<typeof vi.fn> };
  stderr: { resume: ReturnType<typeof vi.fn> };
};
const bytes = Buffer.from("%PDF-1.7\nsynthetic source");

beforeEach(() => {
  vi.clearAllMocks();
  worker = Object.assign(new EventEmitter(), {
    terminate: vi.fn().mockResolvedValue(1),
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
  });
  mocks.worker.mockImplementation(function () {
    return worker;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("page-count resource and failure bounds", () => {
  it("terminates a stalled parser at the deadline and resolves unknown", async () => {
    vi.useFakeTimers();
    const result = countPdfPages(bytes);
    await vi.advanceTimersByTimeAsync(PDF_PAGE_COUNT_TIMEOUT_MS);
    expect(await result).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates app secrets, limits worker heap, and privately drains output", async () => {
    const result = countPdfPages(bytes);
    expect(mocks.worker).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        workerData: expect.objectContaining({
          bytes: new Uint8Array(bytes),
          parserPath: expect.stringContaining("pdf-lib.min.js"),
        }),
      })
    );
    const parserPath = mocks.worker.mock.calls[0][1].workerData.parserPath;
    expect(typeof parserPath).toBe("string");
    expect(isAbsolute(parserPath)).toBe(true);
    expect(parserPath).toBe(
      join(process.cwd(), "node_modules", "pdf-lib", "dist", "pdf-lib.min.js")
    );
    expect(statSync(parserPath).isFile()).toBe(true);
    expect(worker.stdout.resume).toHaveBeenCalledOnce();
    expect(worker.stderr.resume).toHaveBeenCalledOnce();
    worker.emit("message", 8);
    expect(await result).toBe(8);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, "8", 2_147_483_648, null])(
    "rejects an invalid worker count %s",
    async (value) => {
      const result = countPdfPages(bytes);
      worker.emit("message", value);
      expect(await result).toBeNull();
    }
  );

  it.each(["error", "exit"])("returns unknown on worker %s", async (event) => {
    const result = countPdfPages(bytes);
    worker.emit(
      event,
      event === "error" ? new Error("private parser details") : 1
    );
    expect(await result).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("returns unknown if a worker cannot start", async () => {
    mocks.worker.mockImplementationOnce(() => {
      throw new Error("private startup details");
    });
    expect(await countPdfPages(bytes)).toBeNull();
  });

  it("rejects oversized or non-PDF input before creating a worker", async () => {
    const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
    oversized.write("%PDF-");
    expect(await countPdfPages(oversized)).toBeNull();
    expect(await countPdfPages(Buffer.from("not PDF"))).toBeNull();
    expect(mocks.worker).not.toHaveBeenCalled();
  });
});
