import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  convert: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ verifyRoleOrUnauthorized: mocks.auth }));
vi.mock("@/lib/convert", () => ({ convertPdf: mocks.convert }));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/storage", () => ({
  downloadObject: mocks.download,
  uploadObject: mocks.upload,
  sourcePdfKey: (sessionId: string, documentId: string) =>
    `${sessionId}/${documentId}/source.pdf`,
  htmlOutputKey: (sessionId: string, documentId: string) =>
    `${sessionId}/${documentId}/output.html`,
}));

import { POST } from "@/app/api/convert/route";
import {
  artifacts,
  conversionJobs,
  documents,
  modelCalls,
  validationFindings,
} from "@/lib/db/schema";
import { MAX_FILE_SIZE_BYTES } from "@/lib/document-input";

const PDF = "%PDF-1.7\nsynthetic test content\n%%EOF";
const usage = {
  stage: "convert" as const,
  model: "test-vision-model",
  promptTokens: 100,
  completionTokens: 50,
  costUsd: 0.001,
};

function chain(value: unknown = []) {
  const builder = {
    from: vi.fn(),
    where: vi.fn(),
    values: vi.fn(),
    set: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    returning: vi.fn().mockResolvedValue(value),
    then: Promise.resolve(value).then.bind(Promise.resolve(value)),
  };
  for (const method of [
    builder.from,
    builder.where,
    builder.values,
    builder.set,
    builder.onConflictDoUpdate,
  ]) {
    method.mockReturnValue(builder);
  }
  return builder;
}

function request(
  options: {
    name?: string;
    contents?: string;
    documentId?: string;
  } = {}
) {
  const form = new FormData();
  form.set("sessionId", "session-1");
  if (options.documentId) {
    form.set("documentId", options.documentId);
  } else {
    form.set(
      "file",
      new File([options.contents ?? PDF], options.name ?? "course.pdf", {
        type: "application/pdf",
      })
    );
  }
  return new NextRequest("https://example.test/api/convert", {
    method: "POST",
    body: form,
  });
}

function ownedDocument(filename = "course.pdf") {
  const sessionQuery = chain([{ id: "session-1" }]);
  const documentQuery = chain([{ id: "doc-1", originalFilename: filename }]);
  mocks.db.select
    .mockReturnValueOnce(sessionQuery)
    .mockReturnValueOnce(documentQuery);
  return { sessionQuery, documentQuery };
}

describe("PDF conversion route", () => {
  const inserted = new Map<unknown, ReturnType<typeof chain>>();
  const updated = chain();

  beforeEach(() => {
    vi.clearAllMocks();
    inserted.clear();
    mocks.auth.mockResolvedValue({ session: { user: { id: "user-1" } } });
    mocks.db.select.mockReturnValue(chain([{ id: "session-1" }]));
    mocks.db.insert.mockImplementation((table: unknown) => {
      const result =
        table === documents
          ? [{ id: "doc-1" }]
          : table === conversionJobs
            ? [{ id: "job-1" }]
            : [];
      const builder = chain(result);
      inserted.set(table, builder);
      return builder;
    });
    mocks.db.update.mockReturnValue(updated);
    mocks.db.delete.mockReturnValue(chain());
    mocks.db.transaction.mockImplementation(
      (callback: (tx: typeof mocks.db) => Promise<unknown>) =>
        callback(mocks.db)
    );
    mocks.upload.mockResolvedValue(undefined);
    mocks.download.mockResolvedValue(Buffer.from(PDF));
    mocks.convert.mockResolvedValue({
      html: "<h2>Course</h2><p>Content</p>",
      errors: [],
      model: usage.model,
      tokensUsed: 150,
      extractionWarnings: [],
      calls: [usage],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stores the PDF, accessible HTML, findings, and billed model usage", async () => {
    const finding = {
      type: "missing-alt",
      severity: "warning",
      message: "An image needs its description reviewed.",
      suggestion: "Review the image description.",
      wcag: "1.1.1",
    };
    mocks.convert.mockResolvedValueOnce({
      html: "<h2>Course</h2>",
      errors: [finding],
      model: usage.model,
      tokensUsed: 150,
      extractionWarnings: [],
      calls: [usage],
    });

    const response = await POST(request({ name: "course.PDF" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      documentId: "doc-1",
      jobId: "job-1",
      errors: [finding],
    });
    expect(mocks.upload).toHaveBeenNthCalledWith(
      1,
      "session-1/doc-1/source.pdf",
      Buffer.from(PDF),
      "application/pdf"
    );
    expect(mocks.convert).toHaveBeenCalledWith(Buffer.from(PDF), "course.PDF");
    expect(inserted.get(documents)?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFilename: "course.PDF",
        mimeType: "application/pdf",
        fileSizeBytes: Buffer.byteLength(PDF),
        uploadedByUserId: "user-1",
        checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    const artifactValues = mocks.db.insert.mock.results
      .filter((_, index) => mocks.db.insert.mock.calls[index][0] === artifacts)
      .map((result) => result.value.values.mock.calls[0][0]);
    expect(artifactValues).toEqual([
      expect.objectContaining({
        artifactType: "source_pdf",
        mimeType: "application/pdf",
        storageKey: "session-1/doc-1/source.pdf",
      }),
      expect.objectContaining({
        artifactType: "html_output",
        filename: "course.html",
      }),
    ]);
    expect(inserted.get(validationFindings)?.values).toHaveBeenCalledWith([
      expect.objectContaining({ ruleCode: "missing-alt", wcag: "1.1.1" }),
    ]);
    expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
      { jobId: "job-1", ...usage, costUsd: "0.001" },
    ]);
  });

  it("reconverts a stored PDF without creating another document or source blob", async () => {
    ownedDocument();

    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(200);
    expect(mocks.download).toHaveBeenCalledWith("session-1/doc-1/source.pdf");
    expect(mocks.db.insert).not.toHaveBeenCalledWith(documents);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls[0][0]).toBe("session-1/doc-1/output.html");
    expect(
      inserted.get(conversionJobs)?.onConflictDoUpdate
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          status: "processing",
          attemptCount: expect.anything(),
        }),
      })
    );
  });

  it("asks legacy Word users to export and reupload without changing their saved job", async () => {
    ownedDocument("course.docx");

    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(415);
    expect((await response.json()).error).toMatch(
      /Export it from Word as a PDF/
    );
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it.each([
    { name: "course.docx", contents: PDF },
    { name: "renamed.pdf", contents: "PK\x03\x04a renamed Word document" },
    { name: "empty.pdf", contents: "" },
  ])(
    "rejects invalid upload $name before persistence or model calls",
    async (input) => {
      const response = await POST(request(input));

      expect(response.status).toBe(415);
      expect(mocks.db.insert).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.convert).not.toHaveBeenCalled();
    }
  );

  it("rejects uploads over the shared size limit before persistence", async () => {
    const response = await POST(
      request({ contents: PDF + "x".repeat(MAX_FILE_SIZE_BYTES) })
    );

    expect(response.status).toBe(413);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects corrupt stored PDFs before mutating the existing job", async () => {
    ownedDocument();
    mocks.download.mockResolvedValueOnce(Buffer.from("not a PDF"));

    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(415);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("checks session ownership and archived state before any storage access", async () => {
    const sessionQuery = chain([]);
    mocks.db.select.mockReturnValueOnce(sessionQuery);

    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(404);
    const where = new PgDialect().sqlToQuery(
      sessionQuery.where.mock.calls[0][0] as SQL
    );
    expect(where.params).toEqual(["session-1", "user-1"]);
    expect(where.sql).toContain('"sessions"."archived_at" is null');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("scopes reconversion to a live document in the owned session", async () => {
    const documentQuery = chain([]);
    mocks.db.select
      .mockReturnValueOnce(chain([{ id: "session-1" }]))
      .mockReturnValueOnce(documentQuery);

    const response = await POST(
      request({ documentId: "another-sessions-doc" })
    );

    expect(response.status).toBe(404);
    const where = new PgDialect().sqlToQuery(
      documentQuery.where.mock.calls[0][0] as SQL
    );
    expect(where.params).toEqual(["another-sessions-doc", "session-1"]);
    expect(where.sql).toContain('"documents"."deleted_at" is null');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it("retains billable model usage and marks the job failed after conversion fails", async () => {
    mocks.convert.mockResolvedValueOnce({
      error: "Conversion failed",
      calls: [usage],
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: "Conversion failed",
      })
    );
    expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
      { jobId: "job-1", ...usage, costUsd: "0.001" },
    ]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("does not log filenames during successful conversions", async () => {
    const response = await POST(request({ name: "confidential-filename.pdf" }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      "confidential-filename.pdf"
    );
  });

  it("keeps storage exception details out of responses and server logs", async () => {
    mocks.upload.mockRejectedValueOnce(
      new Error("private-document-text; storage-secret")
    );
    const response = await POST(request());
    expect(response.status).toBe(500);
    const output = JSON.stringify([
      await response.json(),
      vi.mocked(console.error).mock.calls,
    ]);
    expect(output).not.toContain("private-document-text");
    expect(output).not.toContain("storage-secret");
  });

  it("handles database exceptions without exposing connection or query details", async () => {
    mocks.db.select.mockImplementationOnce(() => {
      throw new Error("postgres://database-secret; private query parameters");
    });
    const response = await POST(request());
    expect(response.status).toBe(500);
    const output = JSON.stringify([
      await response.json(),
      vi.mocked(console.error).mock.calls,
    ]);
    expect(output).not.toContain("database-secret");
    expect(output).not.toContain("private query parameters");
    expect(mocks.convert).not.toHaveBeenCalled();
  });
});
