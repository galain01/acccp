import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  retained: vi.fn(),
  upload: vi.fn(),
  sign: vi.fn(),
  remove: vi.fn(),
  render: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  events: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/document-retention", () => ({
  withRetainedDocument: mocks.retained,
}));
vi.mock("@/lib/storage", () => ({
  uploadObject: mocks.upload,
  createSignedUrl: mocks.sign,
  removeObjects: mocks.remove,
}));
vi.mock("@/lib/powerpoint-rendering", () => ({
  renderPowerPointToPdf: mocks.render,
  PowerPointRenderingError: class extends Error {},
}));
import { createStoredPowerPointRenderer } from "@/lib/powerpoint-render-storage";
const pdf = Buffer.from("%PDF-test");
const large = Buffer.alloc(5 * 1024 * 1024);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.select.mockReturnValue({
    from: () => ({ where: async () => [{ id: "job" }] }),
  });
  mocks.insert.mockReturnValue({
    values: async () => {
      mocks.events.push("receipt");
    },
  });
  mocks.retained.mockImplementation(async (_id, action) =>
    action(
      { select: mocks.select, insert: mocks.insert },
      { sessionId: "session", createdAt: new Date().toISOString() }
    )
  );
  mocks.upload.mockImplementation(async () => {
    mocks.events.push("upload");
  });
  mocks.sign.mockImplementation(async () => {
    mocks.events.push("sign");
    return "https://storage.example/signed";
  });
  mocks.render.mockImplementation(async () => {
    mocks.events.push("render");
    return pdf;
  });
  mocks.remove.mockImplementation(async () => {
    mocks.events.push("remove");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe("PowerPoint rendering through private storage", () => {
  it("keeps the existing direct renderer path for small files", async () => {
    const result = await createStoredPowerPointRenderer(
      "doc",
      "session",
      "job"
    )(Buffer.from("PK-small"), 60000);
    expect(result).toBe(pdf);
    expect(mocks.retained).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("records temporary input before upload, signs an attachment, and cleans up after rendering", async () => {
    const result = await createStoredPowerPointRenderer(
      "doc",
      "session",
      "job"
    )(large, 60000);
    expect(result).toBe(pdf);
    expect(mocks.events).toEqual([
      "receipt",
      "upload",
      "sign",
      "render",
      "remove",
    ]);
    const key = mocks.upload.mock.calls[0][0];
    expect(key).toMatch(/^session\/doc\/job\/render-[0-9a-f-]+\.pptx$/);
    expect(mocks.sign).toHaveBeenCalledWith(key, 60, "source.pptx", {
      signal: mocks.upload.mock.calls[0][3].signal,
    });
    expect(mocks.render.mock.calls[0][0]).toBe(large);
    expect(mocks.render.mock.calls[0][2]).toEqual({
      downloadUrl: "https://storage.example/signed",
    });
    expect(mocks.remove.mock.calls[0][0]).toEqual([key]);
  });
  it("subtracts storage time and reserves cleanup time within the render budget", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    mocks.upload.mockImplementationOnce(async () => {
      elapsed = 8000;
    });
    await createStoredPowerPointRenderer("doc", "session", "job")(large, 60000);
    expect(mocks.render.mock.calls[0][1]).toBe(50000);
    expect(mocks.upload.mock.calls[0][3].signal).toBeInstanceOf(AbortSignal);
    expect(mocks.sign.mock.calls[0][3].signal).toBe(
      mocks.upload.mock.calls[0][3].signal
    );
  });
  it("does not begin an upload after waiting beyond the storage deadline", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const retained = mocks.retained.getMockImplementation()!;
    let count = 0;
    mocks.retained.mockImplementation(async (...args) => {
      if (++count === 2) elapsed = 59000;
      return retained(...args);
    });
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 60000)
    ).rejects.toThrow();
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("stops after a late upload and limits deletion to the remaining budget", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mocks.upload.mockImplementationOnce(async () => {
      elapsed = 59000;
    });
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 60000)
    ).rejects.toThrow();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([58000, 1000]);
  });
  it("keeps the receipt for purge instead of adding a new deadline after a late render", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.render.mockImplementationOnce(async () => {
      elapsed = 60000;
      throw new Error("render timeout");
    });
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 60000)
    ).rejects.toThrow("render timeout");
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("withholds a signed URL if signing latency would pass original retention", async () => {
    const now = Date.now();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(Date, "now").mockImplementation(() => now + elapsed);
    mocks.retained.mockImplementation(async (_id, action) =>
      action(
        { select: mocks.select, insert: mocks.insert },
        {
          sessionId: "session",
          createdAt: new Date(
            now - 14 * 24 * 60 * 60 * 1000 + 36000
          ).toISOString(),
        }
      )
    );
    mocks.sign.mockImplementationOnce(async () => {
      elapsed = 2000;
      return "https://storage.example/signed";
    });
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 6000)
    ).rejects.toThrow();
    expect(mocks.sign.mock.calls[0][1]).toBe(35);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("preserves a successful render and its receipt when immediate cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.remove.mockRejectedValueOnce(new Error("delete failed"));
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 60000)
    ).resolves.toBe(pdf);
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      "[powerpoint] temporary render input awaits document cleanup"
    );
  });
  it("attempts cleanup when rendering fails", async () => {
    mocks.render.mockRejectedValueOnce(new Error("render failed"));
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 60000)
    ).rejects.toThrow("render failed");
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("keeps the committed receipt if upload fails", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("upload failed"));
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 60000)
    ).rejects.toThrow("upload failed");
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("rejects a job outside the retained document before storing bytes", async () => {
    mocks.select.mockReturnValueOnce({
      from: () => ({ where: async () => [] }),
    });
    await expect(
      createStoredPowerPointRenderer("doc", "session", "job")(large, 60000)
    ).rejects.toThrow();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
