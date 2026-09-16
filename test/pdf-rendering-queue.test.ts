import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import {
  PDF_RENDERING_LIMITS,
  PDF_RENDERING_QUEUE_LIMITS,
  renderPdfPages,
} from "../lib/pdf-rendering";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function mockChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    pid: 1234,
  });
}
type MockChild = ReturnType<typeof mockChild>;
let children: MockChild[];

function closeSuccessfully(child: MockChild) {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  child.stdout.emit(
    "data",
    Buffer.from(
      JSON.stringify({
        ok: true,
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            width: 1,
            height: 1,
            png: png.toString("base64"),
            text: "",
          },
        ],
      })
    )
  );
  child.emit("close", 0);
}

function request(marker: string) {
  return Buffer.from(`%PDF-${marker}`);
}

function inputOf(child: MockChild): string {
  const data = child.stdin.read() as Buffer;
  return Buffer.from(JSON.parse(data.toString()).pdf, "base64").toString();
}

beforeEach(() => {
  children = [];
  vi.mocked(childProcess.spawn)
    .mockReset()
    .mockImplementation(() => {
      const child = mockChild();
      children.push(child);
      return child as unknown as ReturnType<typeof childProcess.spawn>;
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded PDF renderer queue", () => {
  it("runs one child at a time in FIFO order and delays base64 allocation until admission", async () => {
    const secondInput = request("second");
    const secondEncode = vi.spyOn(secondInput, "toString");
    const first = renderPdfPages(request("first"));
    const second = renderPdfPages(secondInput);
    const third = renderPdfPages(request("third"));
    expect(children).toHaveLength(1);
    expect(secondEncode).not.toHaveBeenCalled();
    expect(inputOf(children[0])).toBe("%PDF-first");

    closeSuccessfully(children[0]);
    await first;
    expect(children).toHaveLength(2);
    expect(secondEncode).toHaveBeenCalledWith("base64");
    expect(inputOf(children[1])).toBe("%PDF-second");
    closeSuccessfully(children[1]);
    await second;
    expect(children).toHaveLength(3);
    expect(inputOf(children[2])).toBe("%PDF-third");
    closeSuccessfully(children[2]);
    await expect(third).resolves.toMatchObject({ pageCount: 1 });
  });

  it("allows four waiters and rejects excess work before encoding or spawning", async () => {
    const pending = Array.from(
      { length: PDF_RENDERING_QUEUE_LIMITS.maxWaiting + 1 },
      (_, i) => renderPdfPages(request(String(i)))
    );
    const excess = request("private-document");
    const encode = vi.spyOn(excess, "toString");
    await expect(renderPdfPages(excess)).rejects.toMatchObject({
      diagnostic: { code: "pdf_renderer_busy" },
      message:
        "PDF page preparation stopped. Several documents are being prepared right now. Please try this document again shortly.",
    });
    expect(encode).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
    for (const [index, promise] of pending.entries()) {
      expect(inputOf(children[index])).toBe(`%PDF-${index}`);
      closeSuccessfully(children[index]);
      await promise;
      expect(children).toHaveLength(Math.min(index + 2, pending.length));
    }
  });

  it("expires waiting work at 30 seconds while the active renderer continues and recovers queue capacity", async () => {
    vi.useFakeTimers();
    const first = renderPdfPages(request("first"));
    const expired = renderPdfPages(request("expired")).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(PDF_RENDERING_QUEUE_LIMITS.timeoutMs);
    expect(await expired).toMatchObject({
      diagnostic: { code: "pdf_renderer_busy", elapsedMs: 30_000 },
    });
    expect(children).toHaveLength(1);
    const replacement = renderPdfPages(request("replacement"));
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
    closeSuccessfully(children[0]);
    await expect(first).resolves.toMatchObject({ pageCount: 1 });
    expect(children).toHaveLength(2);
    expect(inputOf(children[1])).toBe("%PDF-replacement");
    closeSuccessfully(children[1]);
    await replacement;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives an admitted child its own full 90 seconds and holds the slot until actual close", async () => {
    vi.useFakeTimers();
    const first = renderPdfPages(request("first")).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(70_000);
    expect(children[0].kill).not.toHaveBeenCalled();
    const second = renderPdfPages(request("second")).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(children).toHaveLength(1);
    children[0].emit("close", null);
    await first;
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(children[1].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PDF_RENDERING_LIMITS.timeoutMs - 30_000 - 1);
    expect(children[1].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(children[1].kill).toHaveBeenCalledWith("SIGKILL");
    children[1].emit("close", null);
    expect(await second).toMatchObject({
      diagnostic: { code: "pdf_timeout", elapsedMs: 110_000 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a slot after a failed launch without exposing the launch error", async () => {
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      throw new Error("private launch details");
    });
    const first = renderPdfPages(request("first")).catch(
      (error: unknown) => error
    );
    const second = renderPdfPages(request("second"));
    expect(await first).toMatchObject({
      diagnostic: { code: "pdf_worker_failed" },
    });
    expect(children).toHaveLength(1);
    expect(inputOf(children[0])).toBe("%PDF-second");
    closeSuccessfully(children[0]);
    await second;
  });

  it("releases after malformed output only when the failed child closes", async () => {
    const first = renderPdfPages(request("first")).catch(
      (error: unknown) => error
    );
    const second = renderPdfPages(request("second"));
    children[0].stdout.emit("data", Buffer.from("private invalid output"));
    expect(children).toHaveLength(1);
    children[0].emit("close", 0);
    const failure = await first;
    expect(failure).toMatchObject({
      diagnostic: { code: "pdf_protocol_error" },
    });
    expect(String(failure)).not.toContain("private");
    expect(children).toHaveLength(2);
    closeSuccessfully(children[1]);
    await second;
  });

  it("holds the slot after process or pipe errors until the child closes", async () => {
    const first = renderPdfPages(request("first")).catch(
      (error: unknown) => error
    );
    const second = renderPdfPages(request("second"));
    children[0].emit("error", new Error("private process details"));
    children[0].stdin.emit("error", new Error("private pipe details"));
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(children).toHaveLength(1);
    children[0].emit("close", 1);
    expect(await first).toMatchObject({
      diagnostic: { code: "pdf_worker_failed" },
    });
    expect(children).toHaveLength(2);
    closeSuccessfully(children[1]);
    await second;
  });

  it("holds the slot if writing the request throws until the child closes", async () => {
    const child = mockChild();
    vi.spyOn(child.stdin, "end").mockImplementation(() => {
      throw new Error("private pipe details");
    });
    vi.mocked(childProcess.spawn).mockReturnValueOnce(
      child as unknown as ReturnType<typeof childProcess.spawn>
    );
    const first = renderPdfPages(request("first")).catch(
      (error: unknown) => error
    );
    const second = renderPdfPages(request("second"));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(children).toHaveLength(0);
    child.emit("close", 1);
    expect(await first).toMatchObject({
      diagnostic: { code: "pdf_worker_failed" },
    });
    expect(children).toHaveLength(1);
    closeSuccessfully(children[0]);
    await second;
  });

  it("shares the active slot across independently evaluated module copies", async () => {
    const first = renderPdfPages(request("first"));
    vi.resetModules();
    const separateModule = await import("../lib/pdf-rendering");
    const second = separateModule.renderPdfPages(request("second"));
    expect(children).toHaveLength(1);
    closeSuccessfully(children[0]);
    await first;
    expect(children).toHaveLength(2);
    closeSuccessfully(children[1]);
    await second;
  });
});
