import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({
  db: {
    transaction: vi.fn(),
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  retain: vi.fn(),
  sign: vi.fn(),
  download: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/document-retention", () => ({
  withRetainedDocument: mocks.retain,
}));
vi.mock("@/lib/storage", () => ({
  sourcePptxKey: (session: string, document: string) =>
    `${session}/${document}/source.pptx`,
  createSignedUploadUrl: mocks.sign,
  downloadObjectBounded: mocks.download,
  StorageObjectSizeError: class extends Error {},
}));
import {
  isPowerPointUploadRequest,
  readAndFinalizePowerPointUpload,
  reservePowerPointUpload,
} from "@/lib/document-upload";
import { StorageObjectSizeError } from "@/lib/storage";
const sessionId = "00000000-0000-0000-0000-000000000001";
const documentId = "00000000-0000-0000-0000-000000000002";
const bytes = Buffer.from("PK\x03\x04synthetic deck");
const input = {
  sessionId,
  filename: "Lecture.pptx",
  fileSizeBytes: bytes.length,
  checksumSha256: createHash("sha256").update(bytes).digest("hex"),
};
const document = {
  id: documentId,
  sessionId,
  uploadedByUserId: "owner",
  originalFilename: input.filename,
  mimeType:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  fileSizeBytes: input.fileSizeBytes,
  checksumSha256: input.checksumSha256,
  uploadExpiresAt: new Date(Date.now() + 125 * 60_000).toISOString(),
  uploadCompletedAt: null,
};
function chain(value: unknown = []) {
  const result = {
    from: vi.fn(),
    where: vi.fn(),
    for: vi.fn(),
    values: vi.fn(),
    returning: vi.fn(),
    set: vi.fn(),
    then: Promise.resolve(value).then.bind(Promise.resolve(value)),
  };
  for (const key of [
    "from",
    "where",
    "for",
    "values",
    "returning",
    "set",
  ] as const)
    result[key].mockReturnValue(result);
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.transaction.mockImplementation(async (action) => action(mocks.db));
  mocks.db.execute.mockResolvedValue([]);
  mocks.db.select.mockReturnValue(chain([{ id: sessionId }]));
  mocks.db.insert.mockReturnValue(chain([{ id: documentId }]));
  mocks.db.update.mockReturnValue(chain());
  mocks.retain.mockImplementation(async (_id, action) =>
    action(mocks.db, { ...document })
  );
  mocks.download.mockResolvedValue(bytes);
  mocks.sign.mockResolvedValue({
    uploadUrl: "https://storage.test/upload?token=opaque",
    expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
  });
});
describe("PowerPoint upload reservation", () => {
  it.each([
    { filename: "../x.pptx" },
    { filename: "a.docx" },
    { filename: " a.pptx" },
    { fileSizeBytes: 25 * 1024 * 1024 + 1 },
    { fileSizeBytes: 0 },
    { checksumSha256: "bad" },
    { sessionId: "bad" },
    { key: "other/file" },
  ])("rejects unsupported details %j", (patch) => {
    expect(isPowerPointUploadRequest({ ...input, ...patch })).toBe(false);
  });
  it("accepts the exact 25 MiB boundary", () => {
    expect(
      isPowerPointUploadRequest({ ...input, fileSizeBytes: 25 * 1024 * 1024 })
    ).toBe(true);
  });
  it("commits discovery metadata before signing and records the actual token deadline before returning", async () => {
    mocks.db.select
      .mockReturnValueOnce(chain([{ id: "owner" }]))
      .mockReturnValueOnce(chain([{ id: sessionId }]))
      .mockReturnValueOnce(chain([{ total: 0 }]));
    const output = await reservePowerPointUpload("owner", input);
    expect(output).toEqual({
      documentId,
      uploadUrl: "https://storage.test/upload?token=opaque",
    });
    expect(mocks.db.insert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sign.mock.invocationCallOrder[0]
    );
    expect(mocks.sign).toHaveBeenCalledWith(
      `${sessionId}/${documentId}/source.pptx`
    );
    expect(mocks.db.update).toHaveBeenCalledTimes(1);
  });
  it("limits concurrent abandoned reservations across the user's sessions before signing", async () => {
    mocks.db.select
      .mockReturnValueOnce(chain([{ id: "owner" }]))
      .mockReturnValueOnce(chain([{ id: sessionId }]))
      .mockReturnValueOnce(chain([{ total: 3 }]));
    await expect(reservePowerPointUpload("owner", input)).rejects.toMatchObject(
      { status: 429 }
    );
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });
  it("rejects an unowned or archived session before signing", async () => {
    mocks.db.select
      .mockReturnValueOnce(chain([{ id: "owner" }]))
      .mockReturnValueOnce(chain([]));
    await expect(reservePowerPointUpload("owner", input)).rejects.toMatchObject(
      { status: 404 }
    );
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("withholds an unexpectedly long-lived token", async () => {
    mocks.sign.mockResolvedValue({
      uploadUrl: "secret",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    await expect(reservePowerPointUpload("owner", input)).rejects.toMatchObject(
      { status: 503 }
    );
  });
});
describe("PowerPoint upload finalization", () => {
  const request = { userId: "owner", sessionId, documentId };
  it("checks the bounded canonical bytes against size and SHA256 before marking complete", async () => {
    await expect(readAndFinalizePowerPointUpload(request)).resolves.toEqual({
      buffer: bytes,
      filename: input.filename,
    });
    expect(mocks.download).toHaveBeenCalledWith(
      `${sessionId}/${documentId}/source.pptx`,
      25 * 1024 * 1024
    );
    expect(mocks.db.update).toHaveBeenCalledTimes(1);
  });
  it("rejects another owner's document before reading Storage", async () => {
    mocks.retain.mockImplementation(async (_id, action) =>
      action(mocks.db, { ...document, uploadedByUserId: "other" })
    );
    await expect(
      readAndFinalizePowerPointUpload(request)
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it.each([Buffer.from("changed"), Buffer.from("PK\x03\x04synthetic seek")])(
    "rejects wrong size or checksum",
    async (wrong) => {
      mocks.download.mockResolvedValue(wrong);
      await expect(
        readAndFinalizePowerPointUpload(request)
      ).rejects.toMatchObject({ status: 415 });
      expect(mocks.db.update).not.toHaveBeenCalled();
    }
  );
  it("returns a safe retryable missing-upload response", async () => {
    mocks.download.mockRejectedValue(new Error("provider secret"));
    await expect(
      readAndFinalizePowerPointUpload(request)
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.db.update).not.toHaveBeenCalled();
  });
  it("reports a bounded-download overflow without finalizing", async () => {
    mocks.download.mockRejectedValue(new StorageObjectSizeError());
    await expect(
      readAndFinalizePowerPointUpload(request)
    ).rejects.toMatchObject({ status: 413 });
    expect(mocks.db.update).not.toHaveBeenCalled();
  });
  it("keeps existing completed and legacy files retryable without moving their timestamps", async () => {
    mocks.retain.mockImplementation(async (_id, action) =>
      action(mocks.db, { ...document, uploadExpiresAt: null })
    );
    await readAndFinalizePowerPointUpload(request);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });
});
