import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  verifyRoleOrRedirect: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/storage", () => ({
  downloadObject: vi.fn(),
  removeObjects: vi.fn(),
  // Produce real-looking keys so the removeObjects assertion is meaningful.
  sourcePdfKey: vi
    .fn()
    .mockImplementation(
      (sessionId: string, docId: string) => `${sessionId}/${docId}/source.pdf`
    ),
  sourceDocxKey: vi
    .fn()
    .mockImplementation(
      (sessionId: string, docId: string) => `${sessionId}/${docId}/source.docx`
    ),
  htmlOutputKey: vi
    .fn()
    .mockImplementation(
      (sessionId: string, docId: string) => `${sessionId}/${docId}/output.html`
    ),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { verifyRoleOrRedirect } from "@/lib/auth";
import { db } from "@/lib/db";
import { downloadObject, removeObjects } from "@/lib/storage";
import { deleteDocument, getDocumentHtml, listDocuments } from "./documents";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChain<T>(value: T) {
  const chain: Record<string, unknown> = {};

  const selfFn = () => {
    const fn = vi.fn();
    fn.mockReturnValue(chain);
    return fn;
  };

  chain.from = selfFn();
  chain.where = selfFn();
  chain.orderBy = selfFn();
  chain.innerJoin = selfFn();
  chain.leftJoin = selfFn();
  chain.groupBy = selfFn();
  chain.limit = selfFn();
  chain.offset = selfFn();
  chain.values = selfFn();
  chain.set = selfFn();
  chain.returning = vi.fn().mockResolvedValue(value);
  const promise = Promise.resolve(value);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);

  // Duck-types Drizzle's query builders: `any` satisfies mockReturnValue's
  // builder types while keeping property access for assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return chain as any;
}

/** Raw row shape that the listDocuments query returns before mapping. */
function makeDocRow(
  overrides: Partial<{
    id: string;
    name: string;
    size: number;
    uploadedAt: string;
    jobId: string | null;
    status: string | null;
    errorMessage: string | null;
  }> = {}
) {
  return {
    id: "doc-1",
    name: "slides.docx",
    size: 12_345,
    uploadedAt: "2026-01-15T10:00:00Z",
    // null skips the second db.select() for validation findings.
    // Tests that need findings data should pass jobId: "job-1" and queue
    // a second mockReturnValueOnce for the findings query.
    jobId: null,
    status: null,
    errorMessage: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("listDocuments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns documents for a session with status mapped to ConversionStatus", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([makeDocRow({ status: "completed" })])
    );

    const result = await listDocuments("session-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "doc-1",
      name: "slides.docx",
      size: 12_345,
      status: "success", // "completed" → "success"
      locked: false,
    });
    expect(result[0].uploadedAt).toBeInstanceOf(Date);
  });

  it("maps null job status (no conversion yet) to idle", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([makeDocRow({ status: null })])
    );

    const [doc] = await listDocuments("session-1");

    expect(doc.status).toBe("idle");
  });

  it("maps failed status to error and forwards the error message", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([makeDocRow({ status: "failed", errorMessage: "LiteLLM 500" })])
    );

    const [doc] = await listDocuments("session-1");

    expect(doc.status).toBe("error");
    expect(doc.errorMessage).toBe("LiteLLM 500");
  });

  it("maps needs_review to success (HTML is available)", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([makeDocRow({ status: "needs_review" })])
    );

    const [doc] = await listDocuments("session-1");

    expect(doc.status).toBe("success");
  });

  it("maps queued and processing to their respective statuses", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([makeDocRow({ status: "queued" })]))
      .mockReturnValueOnce(makeChain([makeDocRow({ status: "processing" })]));

    const [queued] = await listDocuments("session-1");
    const [processing] = await listDocuments("session-1");

    expect(queued.status).toBe("queued");
    expect(processing.status).toBe("processing");
  });

  it("returns an empty array when the session has no documents", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([]));

    expect(await listDocuments("session-1")).toEqual([]);
  });

  it("omits errorMessage when it is null", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([makeDocRow({ errorMessage: null })])
    );

    const [doc] = await listDocuments("session-1");

    expect(doc.errorMessage).toBeUndefined();
  });

  it("verifies instructor or admin role", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([]));

    await listDocuments("session-1");

    expect(verifyRoleOrRedirect).toHaveBeenCalledWith(["instructor", "admin"]);
  });

  it("propagates a redirect thrown by the auth check", async () => {
    vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
      new Error("NEXT_REDIRECT")
    );

    await expect(listDocuments("session-1")).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("getDocumentHtml", () => {
  beforeEach(() => vi.clearAllMocks());

  it("downloads and returns HTML for a document the caller owns", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ storageKey: "session-1/doc-1/output.html" }])
    );
    vi.mocked(downloadObject).mockResolvedValue(Buffer.from("<p>Hello</p>"));

    const html = await getDocumentHtml("doc-1");

    expect(html).toBe("<p>Hello</p>");
    expect(downloadObject).toHaveBeenCalledWith("session-1/doc-1/output.html");
  });

  it("returns null when no matching artifact row is found (ownership mismatch or missing)", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([]));

    const html = await getDocumentHtml("doc-1");

    expect(html).toBeNull();
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it("propagates errors thrown by the storage layer", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ storageKey: "session-1/doc-1/output.html" }])
    );
    vi.mocked(downloadObject).mockRejectedValue(new Error("storage 503"));

    await expect(getDocumentHtml("doc-1")).rejects.toThrow("storage 503");
  });
});

describe("deleteDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("soft-deletes the document row and cleans PDF, legacy Word, and HTML blobs", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ id: "doc-1", sessionId: "session-1" }])
    );
    vi.mocked(db.update).mockReturnValue(makeChain(undefined));
    vi.mocked(removeObjects).mockResolvedValue(undefined);

    await deleteDocument("doc-1");

    expect(db.update).toHaveBeenCalled();
    expect(removeObjects).toHaveBeenCalledWith([
      "session-1/doc-1/source.pdf",
      "session-1/doc-1/source.docx",
      "session-1/doc-1/output.html",
    ]);
  });

  it("sets deletedAt on the soft-deleted row", async () => {
    const updateChain = makeChain(undefined);
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ id: "doc-1", sessionId: "session-1" }])
    );
    vi.mocked(db.update).mockReturnValue(updateChain);
    vi.mocked(removeObjects).mockResolvedValue(undefined);

    await deleteDocument("doc-1");

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(String) })
    );
  });

  it("returns without error when the document is not found (no-op)", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([]));

    await expect(deleteDocument("doc-1")).resolves.toBeUndefined();
    expect(db.update).not.toHaveBeenCalled();
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("still resolves when storage cleanup throws after the row is tombstoned", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ id: "doc-1", sessionId: "session-1" }])
    );
    vi.mocked(db.update).mockReturnValue(makeChain(undefined));
    vi.mocked(removeObjects).mockRejectedValue(new Error("bucket unreachable"));

    // The row is already soft-deleted; a storage error should not surface to the caller.
    await expect(deleteDocument("doc-1")).resolves.toBeUndefined();
  });

  it("does not delete blobs when the document belongs to a different user", async () => {
    // The select query joins sessions and constrains owner_user_id, so a
    // document owned by another user returns no rows.
    vi.mocked(db.select).mockReturnValue(makeChain([]));

    await deleteDocument("other-users-doc");

    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("does not log private provider details when cleanup fails", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ id: "doc-1", sessionId: "session-1" }])
    );
    vi.mocked(db.update).mockReturnValue(makeChain(undefined));
    vi.mocked(removeObjects).mockRejectedValue(
      new Error("Authorization: test-service-role-key; private PDF contents")
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deleteDocument("doc-1");
      expect(log).toHaveBeenCalledWith(
        "[documents] blob cleanup failed for doc-1"
      );
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
