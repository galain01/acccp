import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

vi.mock("@/lib/document-retention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-retention")>()),
  withRetainedDocument: vi.fn(),
  deleteOwnedDocument: vi.fn(),
}));

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
import { downloadObject } from "@/lib/storage";
import {
  deleteOwnedDocument,
  DocumentUnavailableError,
  withRetainedDocument,
} from "@/lib/document-retention";
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-20T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

function sqlCondition(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

function expectRetainedScope(condition: SQL) {
  const query = sqlCondition(condition);
  expect(query.sql).toContain('"documents"."deleted_at" is null');
  expect(query.sql).toContain('"documents"."created_at"');
  expect(query.sql).toContain("clock_timestamp()");
  expect(query.sql).toContain("interval '336 hours'");
  expect(query.sql).toMatch(/>/);
  return query;
}

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
    expect(db.select).not.toHaveBeenCalled();
  });

  it("scopes document metadata and findings to owner, session, and unexpired undeleted rows", async () => {
    const documentQuery = makeChain([makeDocRow({ jobId: "job-1" })]);
    const findingsQuery = makeChain([
      {
        jobId: "job-1",
        severity: "warning",
        ruleCode: "other",
        message: "Review heading",
        suggestion: "Check the original",
        wcag: null,
        location: null,
      },
    ]);
    vi.mocked(db.select)
      .mockReturnValueOnce(documentQuery)
      .mockReturnValueOnce(findingsQuery);

    const [result] = await listDocuments("session-1");

    expect(result.errors?.[0].message).toBe("Review heading");
    for (const query of [documentQuery, findingsQuery]) {
      const condition = expectRetainedScope(query.where.mock.calls[0][0]);
      expect(condition.sql).toContain('"sessions"."owner_user_id" =');
      expect(condition.sql).toContain('"documents"."session_id" =');
      expect(condition.params).toContain("user-1");
      expect(condition.params).toContain("session-1");
    }
    expect(findingsQuery.innerJoin).toHaveBeenCalledTimes(3);
    expect(sqlCondition(findingsQuery.where.mock.calls[0][0]).params).toContain(
      "job-1"
    );
  });

  it("does not return a filename or findings when it reaches the exact 14-day boundary", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        makeChain([
          makeDocRow({
            id: "expired",
            jobId: "old-job",
            uploadedAt: "2026-01-06T10:00:00.000Z",
          }),
          makeDocRow({
            id: "retained",
            uploadedAt: "2026-01-06T10:00:00.001Z",
          }),
        ])
      )
      .mockReturnValueOnce(makeChain([]));

    expect((await listDocuments("session-1")).map((doc) => doc.id)).toEqual([
      "retained",
    ]);
  });

  it("restores faculty wording and source locations from the saved finding", async () => {
    const savedLocation = {
      scope: "element",
      sourcePages: [5],
      printedPageLabel: "3",
      section: "Course schedule",
      locator: "First row of the table",
      quote: "Due date",
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([makeDocRow({ jobId: "job-1" })]))
      .mockReturnValueOnce(
        makeChain([
          {
            jobId: "job-1",
            severity: "error",
            ruleCode: "no-table-headers",
            title: "Identify the labels at the top of this table",
            category: "accessibility",
            message: "The labels are not connected to their columns.",
            suggestion:
              "In Canvas, identify Week and Due date as column headings.",
            wcag: "WCAG 1.3.1",
            location: { ...savedLocation, element: "<td>Due date</td>" },
            pageCount: 8,
          },
        ])
      );

    const [document] = await listDocuments("session-1");

    expect(document.errors?.[0]).toEqual({
      type: "no-table-headers",
      severity: "error",
      title: "Identify the labels at the top of this table",
      category: "accessibility",
      message: "The labels are not connected to their columns.",
      suggestion: "In Canvas, identify Week and Due date as column headings.",
      wcag: "WCAG 1.3.1",
      element: "<td>Due date</td>",
      location: savedLocation,
    });
    expect(vi.mocked(db.select).mock.calls[1][0]).toHaveProperty("title");
    expect(vi.mocked(db.select).mock.calls[1][0]).toHaveProperty("category");
    expect(vi.mocked(db.select).mock.calls[1][0]).toHaveProperty("pageCount");
  });

  it("preserves a finding and nearby text when its stored source page is invalid", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([makeDocRow({ jobId: "job-1" })]))
      .mockReturnValueOnce(
        makeChain([
          {
            jobId: "job-1",
            severity: "warning",
            ruleCode: "missing-image",
            title: "Add the missing chart",
            category: "source-review",
            message: "The chart has not been added to the converted page.",
            suggestion: "Add the chart below Results in Canvas.",
            wcag: null,
            pageCount: 8,
            location: {
              scope: "element",
              sourcePages: [99],
              printedPageLabel: null,
              section: "Results",
              locator: "Below the first paragraph",
              quote: null,
              element: { invalid: true },
            },
          },
        ])
      );

    const [document] = await listDocuments("session-1");
    expect(document.errors).toHaveLength(1);
    expect(document.errors?.[0].location?.sourcePages).toBeNull();
    expect(document.errors?.[0].location?.section).toBe("Results");
    expect(document.errors?.[0].element).toBeUndefined();
  });

  it("keeps legacy findings with only an HTML excerpt readable after reload", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([makeDocRow({ jobId: "job-1" })]))
      .mockReturnValueOnce(
        makeChain([
          {
            jobId: "job-1",
            severity: "info",
            ruleCode: "heading-skip",
            title: "heading-skip",
            category: "historical-category",
            message: "Review this heading.",
            suggestion: "Check which section it belongs to.",
            wcag: null,
            location: { element: "<h4>Readings</h4>" },
            pageCount: null,
          },
        ])
      );

    const [document] = await listDocuments("session-1");
    expect(document.errors?.[0]).toMatchObject({
      severity: "warning",
      element: "<h4>Readings</h4>",
      message: "Review this heading.",
    });
    expect(document.errors?.[0].category).toBeUndefined();
    expect(document.errors?.[0].location).toBeUndefined();
  });
});

describe("getDocumentHtml", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withRetainedDocument).mockImplementation(async (_id, action) =>
      action(db as never, { createdAt: "2026-01-15T10:00:00Z" } as never)
    );
  });

  it("downloads and returns HTML for a document the caller owns", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ storageKey: "session-1/doc-1/output.html" }])
    );
    vi.mocked(downloadObject).mockResolvedValue(Buffer.from("<p>Hello</p>"));

    const html = await getDocumentHtml("doc-1");

    expect(html).toBe("<p>Hello</p>");
    expect(downloadObject).toHaveBeenCalledWith("session-1/doc-1/output.html");
    expect(withRetainedDocument).toHaveBeenCalledWith(
      "doc-1",
      expect.any(Function)
    );
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

  it("queries the owned available HTML artifact inside the locked transaction", async () => {
    const artifactQuery = makeChain([
      { storageKey: "session-1/doc-1/output.html" },
    ]);
    const tx = { select: vi.fn().mockReturnValue(artifactQuery) };
    vi.mocked(withRetainedDocument).mockImplementation(async (_id, action) =>
      action(tx as never, { createdAt: "2026-01-15T10:00:00Z" } as never)
    );
    vi.mocked(downloadObject).mockResolvedValue(Buffer.from("<p>Saved</p>"));

    expect(await getDocumentHtml("doc-1")).toBe("<p>Saved</p>");
    expect(db.select).not.toHaveBeenCalled();
    const query = expectRetainedScope(artifactQuery.where.mock.calls[0][0]);
    expect(query.sql).toContain('"sessions"."owner_user_id" =');
    expect(query.params).toEqual(
      expect.arrayContaining(["doc-1", "user-1", "html_output", "available"])
    );
  });

  it("returns null without touching storage when the locked document expired or was removed", async () => {
    vi.mocked(withRetainedDocument).mockRejectedValueOnce(
      new DocumentUnavailableError()
    );

    expect(await getDocumentHtml("doc-1")).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it("rejects HTML if the 14-day limit passes during the locked download", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ storageKey: "output.html" }])
    );
    vi.mocked(withRetainedDocument).mockImplementation(async (_id, action) =>
      action(db as never, { createdAt: "2026-01-06T10:00:00.001Z" } as never)
    );
    vi.mocked(downloadObject).mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-01-20T10:00:00.001Z"));
      return Buffer.from("<p>Expired during download</p>");
    });

    expect(await getDocumentHtml("doc-1")).toBeNull();
  });

  it("authenticates before locking or reading any document", async () => {
    vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
      new Error("NEXT_REDIRECT")
    );
    await expect(getDocumentHtml("doc-1")).rejects.toThrow("NEXT_REDIRECT");
    expect(withRetainedDocument).not.toHaveBeenCalled();
    expect(downloadObject).not.toHaveBeenCalled();
  });
});

describe("deleteDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteOwnedDocument).mockResolvedValue(undefined);
  });

  it("delegates to the shared locked tombstone and retryable cleanup with the authenticated owner", async () => {
    await deleteDocument("doc-1");

    expect(verifyRoleOrRedirect).toHaveBeenCalledWith(["instructor", "admin"]);
    expect(deleteOwnedDocument).toHaveBeenCalledExactlyOnceWith(
      "doc-1",
      "user-1"
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("authenticates before any delete or storage cleanup", async () => {
    vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
      new Error("NEXT_REDIRECT")
    );

    await expect(deleteDocument("doc-1")).rejects.toThrow("NEXT_REDIRECT");
    expect(deleteOwnedDocument).not.toHaveBeenCalled();
  });
});
