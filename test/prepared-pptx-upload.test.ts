import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    insert: vi.fn(),
  },
  retain: vi.fn(),
  reserve: vi.fn(),
  sign: vi.fn(),
  download: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/document-retention", () => ({
  withRetainedDocument: mocks.retain,
}));
vi.mock("@/lib/storage", () => ({
  sourcePptxKey: (s: string, d: string) => `${s}/${d}/source.pptx`,
  createSignedUploadUrl: mocks.sign,
  downloadObjectBounded: mocks.download,
  StorageObjectSizeError: class extends Error {},
}));
vi.mock("@/lib/document-submission", async () => ({
  ...(await vi.importActual<typeof import("@/lib/document-submission")>(
    "@/lib/document-submission"
  )),
  reserveDocumentSubmission: mocks.reserve,
}));

import {
  isPowerPointUploadRequest,
  reservePowerPointUpload,
} from "@/lib/document-upload";
import {
  issueSubmissionToken,
  readSubmissionToken,
} from "@/lib/document-submission-token";
import { StorageObjectSizeError } from "@/lib/storage";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const bytes = Buffer.from("PK\x03\x04synthetic prepared deck");
const metadata = {
  sessionId,
  filename: "Synthetic.pptx",
  fileSizeBytes: bytes.length,
  checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  outputTarget: "accessible_pptx" as const,
};
let ticket: ReturnType<typeof issueSubmissionToken>;
let open: boolean;
let document: { uploadExpiresAt: string; uploadCompletedAt: string | null };

function query(value: unknown = []) {
  const result = {
    from: vi.fn(),
    where: vi.fn(),
    set: vi.fn(),
    then: Promise.resolve(value).then.bind(Promise.resolve(value)),
  };
  result.from.mockReturnValue(result);
  result.where.mockReturnValue(result);
  result.set.mockReturnValue(result);
  return result;
}
function request() {
  return {
    sessionId: metadata.sessionId,
    filename: metadata.filename,
    fileSizeBytes: metadata.fileSizeBytes,
    checksumSha256: metadata.checksumSha256,
    submissionToken: ticket.submissionToken,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-prepared-upload-secret-32-chars");
  ticket = issueSubmissionToken(userId, metadata);
  open = true;
  document = {
    uploadExpiresAt: new Date(
      Date.parse(ticket.expiresAt) + 125 * 60_000
    ).toISOString(),
    uploadCompletedAt: null,
  };
  mocks.db.select.mockImplementation((fields) =>
    query(fields?.open ? [{ open }] : [{ id: sessionId }])
  );
  mocks.db.update.mockReturnValue(query());
  mocks.retain.mockImplementation(async (_id, action) =>
    action(mocks.db, document)
  );
  mocks.reserve.mockImplementation(async (owner, token) =>
    readSubmissionToken(token, owner, { allowExpired: true })
  );
  mocks.download.mockRejectedValue(new Error("Synthetic missing object"));
  mocks.sign.mockResolvedValue({
    uploadUrl: "https://storage.test/synthetic-signed-upload",
    expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("prepared PowerPoint uploads", () => {
  it.each(["", "x".repeat(4097), null])(
    "rejects invalid prepared-token values before persistence or signing",
    async (submissionToken) => {
      const input = { ...request(), submissionToken };
      expect(isPowerPointUploadRequest(input)).toBe(false);
      await expect(
        reservePowerPointUpload(userId, input as never)
      ).rejects.toMatchObject({ status: 400 });
      expect(mocks.reserve).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.db.transaction).not.toHaveBeenCalled();
    }
  );

  it("reuses the prepared identity and fixed cleanup deadline while signing within the window", async () => {
    const expiresAt = document.uploadExpiresAt;
    await expect(reservePowerPointUpload(userId, request())).resolves.toEqual({
      documentId: ticket.documentId,
      uploadUrl: "https://storage.test/synthetic-signed-upload",
      sourceReady: false,
    });
    expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith(
      userId,
      ticket.submissionToken
    );
    expect(mocks.retain).toHaveBeenCalledWith(
      ticket.documentId,
      expect.any(Function)
    );
    expect(mocks.download).toHaveBeenCalledWith(
      `${sessionId}/${ticket.documentId}/source.pptx`,
      25 * 1024 * 1024
    );
    expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(
      `${sessionId}/${ticket.documentId}/source.pptx`
    );
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(document.uploadExpiresAt).toBe(expiresAt);
  });

  it.each([
    { filename: "Different.pptx" },
    { fileSizeBytes: bytes.length + 1 },
    { checksumSha256: "b".repeat(64) },
    { sessionId: "33333333-3333-4333-8333-333333333333" },
  ])(
    "rejects metadata that differs from the signed preparation: %j",
    async (changed) => {
      await expect(
        reservePowerPointUpload(userId, { ...request(), ...changed })
      ).rejects.toMatchObject({ status: 409 });
      expect(mocks.reserve).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
    }
  );

  it("marks only the exact bounded source ready and does not mint a new upload URL", async () => {
    mocks.download.mockResolvedValue(bytes);
    await expect(reservePowerPointUpload(userId, request())).resolves.toEqual({
      documentId: ticket.documentId,
      sourceReady: true,
    });
    expect(mocks.db.update).toHaveBeenCalledTimes(1);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("reads an already-ready source after preparation expiry without extending its capability", async () => {
    document.uploadCompletedAt = new Date().toISOString();
    mocks.download.mockResolvedValue(bytes);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(ticket.expiresAt) + 1);
    await expect(reservePowerPointUpload(userId, request())).resolves.toEqual({
      documentId: ticket.documentId,
      sourceReady: true,
    });
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not sign an expired preparation when the source is absent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(ticket.expiresAt) + 1);
    await expect(
      reservePowerPointUpload(userId, request())
    ).rejects.toMatchObject({ status: 410 });
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("checks the database deadline before signing after waiting for the document lock", async () => {
    open = false;
    await expect(
      reservePowerPointUpload(userId, request())
    ).rejects.toMatchObject({ status: 410 });
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("withholds a signed URL if its database submission window expires during signing", async () => {
    mocks.sign.mockImplementationOnce(async () => {
      open = false;
      return {
        uploadUrl: "secret-signed-capability",
        expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
      };
    });
    await expect(
      reservePowerPointUpload(userId, request())
    ).rejects.toMatchObject({ status: 410 });
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("withholds a provider capability that outlives the retained cleanup deadline", async () => {
    mocks.sign.mockResolvedValueOnce({
      uploadUrl: "secret-signed-capability",
      expiresAt: new Date(
        Date.parse(document.uploadExpiresAt) + 1
      ).toISOString(),
    });
    await expect(
      reservePowerPointUpload(userId, request())
    ).rejects.toMatchObject({ status: 503 });
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it.each([
    Buffer.from("wrong size"),
    Buffer.from("PK\x03\x04synthetic prepAred deck"),
  ])("refuses source readiness for a conflicting object", async (wrong) => {
    mocks.download.mockResolvedValueOnce(wrong);
    await expect(
      reservePowerPointUpload(userId, request())
    ).rejects.toMatchObject({ status: 415 });
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not re-sign after the bounded source read reports an oversized object", async () => {
    mocks.download.mockRejectedValueOnce(new StorageObjectSizeError());
    await expect(
      reservePowerPointUpload(userId, request())
    ).rejects.toMatchObject({ status: 413 });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
