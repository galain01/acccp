import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  sign: vi.fn(),
  download: vi.fn(),
  retained: vi.fn(),
  db: { select: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrRedirect: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/storage", () => ({
  createSignedUrl: mocks.sign,
  downloadObject: mocks.download,
}));
vi.mock("@/lib/document-retention", async () => {
  const { sql } = await import("drizzle-orm");
  return {
    withRetainedDocument: mocks.retained,
    deleteOwnedDocument: vi.fn(),
    retainedDocumentCondition: () =>
      sql`"documents"."deleted_at" is null and "documents"."created_at" > clock_timestamp() - interval '336 hours'`,
    DocumentUnavailableError: class extends Error {},
  };
});

import {
  getDocumentHtml,
  getDocumentOutputDownload,
  listDocuments,
} from "@/lib/actions/documents";
import { DocumentUnavailableError } from "@/lib/document-retention";
import { DOCUMENT_RETENTION_MS } from "@/lib/retention";

function chain(value: unknown[]) {
  const result = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    then: Promise.resolve(value).then.bind(Promise.resolve(value)),
  };
  for (const method of [
    result.from,
    result.innerJoin,
    result.leftJoin,
    result.where,
    result.orderBy,
  ])
    method.mockReturnValue(result);
  return result;
}

const now = new Date("2026-09-24T12:00:00Z");
let createdAt: string;
const query = (where: SQL) => new PgDialect().sqlToQuery(where);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  createdAt = new Date(now.getTime() - 60_000).toISOString();
  mocks.auth.mockResolvedValue({ user: { id: "owner-1" } });
  mocks.sign.mockResolvedValue(
    "https://storage.example.test/owned-signed-download"
  );
  mocks.download.mockResolvedValue(Buffer.from("<h2>Original HTML</h2>"));
  mocks.db.select.mockReset().mockReturnValue(chain([]));
  mocks.retained
    .mockReset()
    .mockImplementation((_documentId, action) =>
      action(mocks.db, { createdAt })
    );
});
afterEach(() => vi.useRealTimers());

describe("owned output downloads", () => {
  it("signs only the owned target artifact and requests a PPTX attachment filename", async () => {
    const builder = chain([
      { storageKey: "session/doc/job/output.pptx", filename: "Lecture.PPTX" },
    ]);
    mocks.db.select.mockReturnValueOnce(builder);
    expect(await getDocumentOutputDownload("doc-1", "accessible_pptx")).toEqual(
      {
        url: "https://storage.example.test/owned-signed-download",
        filename: "Lecture-accessible.pptx",
      }
    );
    const compiled = query(builder.where.mock.calls[0][0]);
    expect(compiled.sql).toContain('"sessions"."owner_user_id"');
    expect(compiled.sql).toContain('"conversion_jobs"."output_target"');
    expect(compiled.sql).toContain("clock_timestamp()");
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        "doc-1",
        "owner-1",
        "accessible_pptx",
        "pptx_output",
        "available",
      ])
    );
    expect(mocks.sign).toHaveBeenCalledWith(
      "session/doc/job/output.pptx",
      60,
      "Lecture-accessible.pptx"
    );
    expect(mocks.retained).toHaveBeenCalledWith("doc-1", expect.any(Function));
  });

  it("returns nothing for another owner or a missing result", async () => {
    expect(
      await getDocumentOutputDownload("another-owner-doc", "accessible_pptx")
    ).toBeNull();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not issue a URL when the retention lock rejects the document", async () => {
    mocks.retained.mockRejectedValueOnce(new DocumentUnavailableError());
    expect(
      await getDocumentOutputDownload("expired-doc", "accessible_pptx")
    ).toBeNull();
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("shortens the URL's life to the remaining original retention period", async () => {
    createdAt = new Date(
      now.getTime() - DOCUMENT_RETENTION_MS + 12_000
    ).toISOString();
    mocks.db.select.mockReturnValueOnce(
      chain([{ storageKey: "owned", filename: "Lecture.pptx" }])
    );
    expect(
      await getDocumentOutputDownload("doc", "accessible_pptx")
    ).not.toBeNull();
    expect(mocks.sign).toHaveBeenCalledWith(
      "owned",
      11,
      "Lecture-accessible.pptx"
    );
  });

  it("withholds the result if expiry passes during signing", async () => {
    createdAt = new Date(
      now.getTime() - DOCUMENT_RETENTION_MS + 12_000
    ).toISOString();
    mocks.db.select.mockReturnValueOnce(
      chain([{ storageKey: "owned", filename: "Lecture.pptx" }])
    );
    mocks.sign.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 13_000));
      return "https://storage.example.test/expired-link";
    });
    expect(
      await getDocumentOutputDownload("doc", "accessible_pptx")
    ).toBeNull();
  });

  it("withholds a late signed response that would otherwise outlive retention", async () => {
    createdAt = new Date(
      now.getTime() - DOCUMENT_RETENTION_MS + 12_000
    ).toISOString();
    mocks.db.select.mockReturnValueOnce(
      chain([{ storageKey: "owned", filename: "Lecture.pptx" }])
    );
    mocks.sign.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 2_000));
      return "https://storage.example.test/late-link";
    });
    expect(
      await getDocumentOutputDownload("doc", "accessible_pptx")
    ).toBeNull();
  });

  it("keeps legacy HTML retrieval explicitly within the Canvas target", async () => {
    const builder = chain([{ storageKey: "session/doc/output.html" }]);
    mocks.db.select.mockReturnValueOnce(builder);
    expect(await getDocumentHtml("doc-1")).toBe("<h2>Original HTML</h2>");
    const compiled = query(builder.where.mock.calls[0][0]);
    expect(compiled.params).toEqual(
      expect.arrayContaining(["canvas_html", "html_output", "owner-1"])
    );
    expect(mocks.download).toHaveBeenCalledWith("session/doc/output.html");
  });
});

describe("saved destination and change summaries", () => {
  it("keeps an uploaded PPTX retryable when creating its first job failed", async () => {
    mocks.db.select.mockReturnValueOnce(
      chain([
        {
          id: "pptx-without-job",
          name: "Lecture.PPTX",
          size: 42,
          uploadedAt: createdAt,
          jobId: null,
          status: null,
          errorMessage: null,
          outputTarget: null,
          changes: null,
        },
        {
          id: "pdf-without-job",
          name: "Reading.pdf",
          size: 42,
          uploadedAt: createdAt,
          jobId: null,
          status: null,
          errorMessage: null,
          outputTarget: null,
          changes: null,
        },
      ])
    );
    const rows = await listDocuments("session-1");
    expect(rows[0]).toMatchObject({
      documentId: "pptx-without-job",
      outputTarget: "accessible_pptx",
      status: "idle",
      changes: [],
    });
    expect(rows[0].jobId).toBeUndefined();
    expect(rows[1].outputTarget).toBe("canvas_html");
    expect(mocks.db.select).toHaveBeenCalledTimes(1);
  });

  it("returns each result's destination, job identity and bounded changes without fetching blobs", async () => {
    mocks.db.select.mockReturnValueOnce(
      chain([
        {
          id: "doc-1",
          name: "Lecture.pptx",
          size: 42,
          uploadedAt: createdAt,
          jobId: "pptx-job",
          status: "completed",
          errorMessage: null,
          outputTarget: "accessible_pptx",
          changes: ["Slide 2: added a title.", 5],
        },
      ])
    );
    mocks.db.select.mockReturnValueOnce(
      chain([
        {
          jobId: "pptx-job",
          severity: "warning",
          ruleCode: "other",
          title: "Check chart",
          category: "source-review",
          message: "Chart needs review.",
          suggestion: "Check the chart on slide 3.",
          location: {
            scope: "element",
            sourcePages: [3],
            sourceKind: "slide",
            locator: "Chart 1",
          },
          pageCount: 4,
        },
      ])
    );
    const rows = await listDocuments("session-1");
    expect(rows[0]).toMatchObject({
      documentId: "doc-1",
      jobId: "pptx-job",
      outputTarget: "accessible_pptx",
      changes: ["Slide 2: added a title."],
    });
    expect(rows[0].errors?.[0].location).toMatchObject({
      sourceKind: "slide",
      sourcePages: [3],
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(2);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
