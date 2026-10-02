import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadPowerPointDocument } from "../lib/document-upload-client";
import {
  MAX_PPTX_FILE_SIZE_BYTES,
  PPTX_MIME_TYPE,
} from "../lib/document-input";

const fetchMock = vi.fn<typeof fetch>();
const uploadUrl =
  "https://storage.example.test/storage/v1/object/upload/sign/documents/source.pptx?token=scoped-test";
const reservation = (url = uploadUrl) =>
  ({
    ok: true,
    json: async () => ({ documentId: "reserved-document", uploadUrl: url }),
  }) as Response;
const file = () =>
  new File([new Uint8Array([0x50, 0x4b, 3, 4, 15, 16])], "Lecture.PPTX", {
    type: "untrusted/type",
  });
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockResolvedValueOnce(reservation())
    .mockResolvedValueOnce({ ok: true } as Response);
});
afterEach(() => vi.unstubAllGlobals());

describe("private PowerPoint browser upload", () => {
  it("explains the unfinished-upload limit without encouraging immediate retries", async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    const onReserved = vi.fn();
    await expect(
      uploadPowerPointDocument({
        file: file(),
        sessionId: "session",
        signal: new AbortController().signal,
        onReserved,
      })
    ).rejects.toThrow(
      "Too many unfinished PowerPoint uploads. Finish an existing upload, or wait up to three hours for abandoned uploads to clear."
    );
    expect(onReserved).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hashes the exact file, reserves once, and uploads raw bytes without app credentials", async () => {
    const input = file();
    const onReserved = vi.fn();
    const controller = new AbortController();
    expect(
      await uploadPowerPointDocument({
        file: input,
        sessionId: "session",
        signal: controller.signal,
        onReserved,
      })
    ).toBe("reserved-document");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/document-upload");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({
      sessionId: "session",
      filename: input.name,
      fileSizeBytes: input.size,
      checksumSha256: createHash("sha256")
        .update(new Uint8Array(await input.arrayBuffer()))
        .digest("hex"),
    });
    expect(onReserved).toHaveBeenCalledExactlyOnceWith("reserved-document");
    const [target, put] = fetchMock.mock.calls[1];
    expect(target).toBe(uploadUrl);
    expect(put).toMatchObject({
      method: "PUT",
      body: input,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    expect(put?.headers).toEqual({
      "Content-Type": PPTX_MIME_TYPE,
      "x-upsert": "false",
      "cache-control": "max-age=0",
    });
  });

  it("reports a reservation ID arriving after cancellation so the caller can delete it without starting PUT", async () => {
    const controller = new AbortController();
    const onReserved = vi.fn();
    fetchMock.mockReset().mockImplementationOnce(async () => {
      controller.abort();
      return reservation();
    });
    await expect(
      uploadPowerPointDocument({
        file: file(),
        sessionId: "session",
        signal: controller.signal,
        onReserved,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onReserved).toHaveBeenCalledWith("reserved-document");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose storage error bodies or signed tokens when PUT fails", async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(reservation())
      .mockResolvedValueOnce({
        ok: false,
        text: async () => "private storage details and scoped-test",
      } as Response);
    await expect(
      uploadPowerPointDocument({
        file: file(),
        sessionId: "session",
        signal: new AbortController().signal,
        onReserved: vi.fn(),
      })
    ).rejects.toThrow(
      "The PowerPoint upload did not finish. Please try again."
    );
  });

  it.each([
    "javascript:alert(1)",
    "http://external.example.test/upload",
    "https://user:secret@storage.example.test/upload",
  ])(
    "refuses an unsafe upload URL %s after making its reservation available for cleanup",
    async (url) => {
      fetchMock.mockReset().mockResolvedValueOnce(reservation(url));
      const onReserved = vi.fn();
      await expect(
        uploadPowerPointDocument({
          file: file(),
          sessionId: "session",
          signal: new AbortController().signal,
          onReserved,
        })
      ).rejects.toThrow();
      expect(onReserved).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects invalid type, empty and oversized files before reserving storage", async () => {
    for (const input of [
      new File(["data"], "legacy.ppt"),
      new File([], "empty.pptx"),
      new File([new Uint8Array(MAX_PPTX_FILE_SIZE_BYTES + 1)], "large.pptx"),
    ]) {
      await expect(
        uploadPowerPointDocument({
          file: input,
          sessionId: "session",
          signal: new AbortController().signal,
          onReserved: vi.fn(),
        })
      ).rejects.toThrow("up to 25 MB");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
