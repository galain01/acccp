import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  convert: vi.fn(),
  renderWord: vi.fn(),
  countPages: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  withRetainedDocument: vi.fn(),
  purgeDocumentIfEligible: vi.fn(),
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
vi.mock("@/lib/pdf-page-count", () => ({ countPdfPages: mocks.countPages }));
vi.mock("@/lib/word-to-pdf", () => ({
  renderWordToPdf: mocks.renderWord,
  WordToPdfError: class extends Error {
    constructor(
      message: string,
      public readonly status: number
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/document-retention", async () => {
  const { sql } = await import("drizzle-orm");
  return {
    withRetainedDocument: mocks.withRetainedDocument,
    purgeDocumentIfEligible: mocks.purgeDocumentIfEligible,
    retainedDocumentCondition: () =>
      sql`"documents"."deleted_at" is null and "documents"."created_at" > clock_timestamp() - interval '336 hours'`,
    DocumentUnavailableError: class extends Error {},
  };
});
vi.mock("@/lib/storage", () => ({
  downloadObject: mocks.download,
  uploadObject: mocks.upload,
  removeObjects: mocks.remove,
  sourceDocxKey: (sessionId: string, documentId: string) =>
    `${sessionId}/${documentId}/source.docx`,
  sourcePdfKey: (sessionId: string, documentId: string) =>
    `${sessionId}/${documentId}/source.pdf`,
  htmlOutputKey: (sessionId: string, documentId: string) =>
    `${sessionId}/${documentId}/output.html`,
}));

import { POST } from "@/app/api/convert/route";
import { DocumentUnavailableError } from "@/lib/document-retention";
import { WordToPdfError } from "@/lib/word-to-pdf";
import { WORD_RENDERING_REVIEW_MESSAGE } from "@/lib/word-rendering-review";
import {
  artifacts,
  conversionJobs,
  documents,
  jobEvents,
  modelCalls,
  validationFindings,
} from "@/lib/db/schema";
import { DOCX_MIME_TYPE, MAX_FILE_SIZE_BYTES } from "@/lib/document-input";

const PDF = "%PDF-1.7\nsynthetic test content\n%%EOF";
// Route validation checks the ZIP envelope; the mocked worker owns parsing.
const DOCX = "PK\x03\x04synthetic Word source with distinct bytes";
const usage = {
  stage: "convert" as const,
  model: "test-vision-model",
  promptTokens: 100,
  completionTokens: 50,
  cachedPromptTokens: 20,
  cacheCreationPromptTokens: 10,
  costSource: "gateway" as const,
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

function artifactValues() {
  return mocks.db.insert.mock.results
    .filter((_, index) => mocks.db.insert.mock.calls[index][0] === artifacts)
    .map((result) => result.value.values.mock.calls[0][0]);
}

describe("document conversion route", () => {
  const inserted = new Map<unknown, ReturnType<typeof chain>>();
  const updated = chain();
  afterEach(() => {
    if (vi.isMockFunction(performance.now))
      vi.mocked(performance.now).mockRestore();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    inserted.clear();
    mocks.withRetainedDocument
      .mockReset()
      .mockImplementation(
        (
          _id: string,
          action: (
            tx: typeof mocks.db,
            document: { createdAt: string }
          ) => unknown
        ) => action(mocks.db, { createdAt: "2026-09-01T00:00:00.000Z" })
      );
    mocks.purgeDocumentIfEligible.mockResolvedValue("purged");
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
    mocks.remove.mockResolvedValue(undefined);
    mocks.download.mockResolvedValue(Buffer.from(PDF));
    mocks.renderWord.mockResolvedValue(Buffer.from(PDF));
    mocks.countPages.mockResolvedValue(8);
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
    expect(mocks.renderWord).not.toHaveBeenCalled();
    expect(inserted.get(documents)?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFilename: "course.PDF",
        mimeType: "application/pdf",
        fileSizeBytes: Buffer.byteLength(PDF),
        uploadedByUserId: "user-1",
        checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(artifactValues()).toEqual([
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

  it("counts the exact rendered PDF and records metrics without changing the Word source", async () => {
    const rendered = Buffer.from("%PDF-1.7\ndistinct rendered PDF");
    mocks.renderWord.mockResolvedValueOnce(rendered);
    mocks.countPages.mockResolvedValueOnce(9);
    expect(
      (await POST(request({ name: "course.docx", contents: DOCX }))).status
    ).toBe(200);
    expect(mocks.countPages).toHaveBeenCalledExactlyOnceWith(rendered);
    expect(mocks.convert).toHaveBeenCalledWith(rendered, "course.pdf");
    expect(inserted.get(conversionJobs)?.values).toHaveBeenCalledWith(
      expect.objectContaining({ pageCount: 9, processingDurationMs: null })
    );
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        pageCount: 9,
        processingDurationMs: expect.any(Number),
      })
    );
  });

  it("keeps an unknown page count null while conversion succeeds", async () => {
    mocks.countPages.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(200);
    expect(inserted.get(conversionJobs)?.values).toHaveBeenCalledWith(
      expect.objectContaining({ pageCount: null })
    );
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", pageCount: null })
    );
  });

  it("measures from before Word rendering through the last successful metadata write", async () => {
    let clock = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    mocks.renderWord.mockImplementationOnce(async () => {
      clock += 100;
      return Buffer.from(PDF);
    });
    mocks.countPages.mockImplementationOnce(async () => {
      clock += 20;
      return 8;
    });
    mocks.upload.mockImplementation(async () => {
      clock += 30;
    });
    mocks.convert.mockImplementationOnce(async () => {
      clock += 200;
      return {
        html: "<h2>Course</h2>",
        errors: [],
        model: usage.model,
        tokensUsed: 150,
        extractionWarnings: [],
        calls: [usage],
      };
    });
    const insert = mocks.db.insert.getMockImplementation()!;
    mocks.db.insert.mockImplementation((table: unknown) => {
      const builder = insert(table);
      if (
        [artifacts, validationFindings, jobEvents, modelCalls].includes(
          table as typeof artifacts
        )
      ) {
        const completion = Promise.resolve([]).then(() => {
          clock += 10;
          return [];
        });
        builder.then = completion.then.bind(completion);
      }
      return builder;
    });
    expect(
      (await POST(request({ name: "course.docx", contents: DOCX }))).status
    ).toBe(200);
    // 100 rendering + 20 parsing + 90 storage + 200 model + 60 metadata.
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        processingDurationMs: 470,
      })
    );
    expect(now.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.renderWord.mock.invocationCallOrder[0]
    );
    expect(updated.set.mock.invocationCallOrder[0]).toBeGreaterThan(
      inserted.get(modelCalls)!.values.mock.invocationCallOrder[0]
    );
  });

  it("resets the previous successful duration on retry and leaves failed attempts null", async () => {
    ownedDocument();
    mocks.convert.mockResolvedValueOnce({
      error: "Conversion failed",
      calls: [usage],
    });
    expect((await POST(request({ documentId: "doc-1" }))).status).toBe(500);
    expect(
      inserted.get(conversionJobs)?.onConflictDoUpdate
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          processingDurationMs: null,
          pageCount: 8,
        }),
      })
    );
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", processingDurationMs: null })
    );
    expect(
      updated.set.mock.calls.some(([value]) => value.status === "completed")
    ).toBe(false);
  });

  it("stores absent cache and cost-source metadata as unknown, preserving confirmed zeroes", async () => {
    mocks.convert.mockResolvedValueOnce({
      html: "<h2>Course</h2>",
      errors: [],
      model: usage.model,
      tokensUsed: 150,
      extractionWarnings: [],
      calls: [
        {
          stage: usage.stage,
          model: usage.model,
          promptTokens: 100,
          completionTokens: 50,
          costUsd: null,
          cachedPromptTokens: 0,
        },
      ],
    });
    expect((await POST(request())).status).toBe(200);
    expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
      expect.objectContaining({
        cachedPromptTokens: 0,
        cacheCreationPromptTokens: null,
        costSource: null,
        costUsd: null,
      }),
    ]);
  });

  it("reconverts a stored PDF without creating another document or source blob", async () => {
    ownedDocument();

    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(200);
    expect(mocks.download).toHaveBeenCalledWith("session-1/doc-1/source.pdf");
    expect(mocks.renderWord).not.toHaveBeenCalled();
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

  it("renders Word before persistence, preserving source metadata and the exact PDF used by the model", async () => {
    const response = await POST(
      request({ name: "course.DOCX", contents: DOCX })
    );

    expect(response.status).toBe(200);
    expect(mocks.renderWord).toHaveBeenCalledWith(
      Buffer.from(DOCX),
      "course.DOCX"
    );
    expect(mocks.renderWord.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.db.insert.mock.invocationCallOrder[0]
    );
    expect(mocks.convert).toHaveBeenCalledWith(Buffer.from(PDF), "course.pdf");
    expect(inserted.get(documents)?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFilename: "course.DOCX",
        mimeType: DOCX_MIME_TYPE,
        fileSizeBytes: Buffer.byteLength(DOCX),
        checksumSha256: createHash("sha256").update(DOCX).digest("hex"),
      })
    );
    expect(mocks.upload).toHaveBeenNthCalledWith(
      1,
      "session-1/doc-1/source.docx",
      Buffer.from(DOCX),
      DOCX_MIME_TYPE
    );
    expect(mocks.upload).toHaveBeenNthCalledWith(
      2,
      "session-1/doc-1/source.pdf",
      Buffer.from(PDF),
      "application/pdf"
    );
    expect(artifactValues()).toEqual([
      expect.objectContaining({
        artifactType: "source_docx",
        filename: "course.DOCX",
        mimeType: DOCX_MIME_TYPE,
        storageKey: "session-1/doc-1/source.docx",
        fileSizeBytes: Buffer.byteLength(DOCX),
      }),
      expect.objectContaining({
        artifactType: "source_pdf",
        filename: "course.pdf",
        mimeType: "application/pdf",
        storageKey: "session-1/doc-1/source.pdf",
        fileSizeBytes: Buffer.byteLength(PDF),
      }),
      expect.objectContaining({
        artifactType: "html_output",
        filename: "course.html",
      }),
    ]);
  });

  it("reconverts a saved Word original without duplicating or overwriting that original", async () => {
    ownedDocument("course.docx");
    mocks.download.mockResolvedValueOnce(Buffer.from(DOCX));

    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(200);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledWith("session-1/doc-1/source.docx");
    expect(mocks.renderWord).toHaveBeenCalledWith(
      Buffer.from(DOCX),
      "course.docx"
    );
    expect(mocks.convert).toHaveBeenCalledWith(Buffer.from(PDF), "course.pdf");
    expect(mocks.db.insert).not.toHaveBeenCalledWith(documents);
    expect(mocks.upload.mock.calls.map(([key]) => key)).toEqual([
      "session-1/doc-1/source.pdf",
      "session-1/doc-1/output.html",
    ]);
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.convert.mock.invocationCallOrder[0]
    );
    expect(artifactValues().map((artifact) => artifact.artifactType)).toEqual([
      "source_docx",
      "source_pdf",
      "html_output",
    ]);
  });

  it("persists and returns the Word rendering warning alongside model findings", async () => {
    const modelFinding = {
      type: "missing-alt",
      severity: "warning",
      message: "Review this image description.",
      suggestion: "Compare the description to the image.",
    };
    mocks.convert.mockResolvedValueOnce({
      html: "<h2>Course</h2>",
      errors: [modelFinding],
      model: usage.model,
      tokensUsed: 150,
      extractionWarnings: ["Existing source review warning."],
      calls: [usage],
    });
    const response = await POST(
      request({ name: "course.docx", contents: DOCX })
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.errors).toEqual([
      modelFinding,
      expect.objectContaining({
        type: "other",
        severity: "warning",
        message: WORD_RENDERING_REVIEW_MESSAGE,
      }),
    ]);
    expect(result.extractionWarnings).toEqual([
      "Existing source review warning.",
      WORD_RENDERING_REVIEW_MESSAGE,
    ]);
    expect(inserted.get(validationFindings)?.values).toHaveBeenCalledWith([
      expect.objectContaining({ ruleCode: "missing-alt" }),
      expect.objectContaining({
        ruleCode: "other",
        severity: "warning",
        message: WORD_RENDERING_REVIEW_MESSAGE,
      }),
    ]);
    expect(inserted.get(jobEvents)?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          findingCount: 2,
          extractionWarnings: [
            "Existing source review warning.",
            WORD_RENDERING_REVIEW_MESSAGE,
          ],
        }),
      })
    );
  });

  it("keeps a stored Word PDF and HTML untouched when the model fails after rendering", async () => {
    ownedDocument("course.docx");
    mocks.download.mockResolvedValueOnce(Buffer.from(DOCX));
    mocks.convert.mockResolvedValueOnce({
      error: "Conversion failed",
      calls: [usage],
    });
    const response = await POST(request({ documentId: "doc-1" }));
    expect(response.status).toBe(500);
    expect(mocks.renderWord).toHaveBeenCalled();
    expect(mocks.convert).toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(artifactValues()).toEqual([]);
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "conversion_failed",
      })
    );
    expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
      { jobId: "job-1", ...usage, costUsd: "0.001" },
    ]);
  });

  it.each([422, 503, 504])(
    "returns controlled renderer status %s before creating a new document or calling the model",
    async (status) => {
      mocks.renderWord.mockRejectedValueOnce(
        new WordToPdfError("Word rendering unavailable.", status)
      );
      const response = await POST(
        request({ name: "course.docx", contents: DOCX })
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: "Word rendering unavailable.",
      });
      expect(mocks.db.insert).not.toHaveBeenCalled();
      expect(mocks.db.update).not.toHaveBeenCalled();
      expect(mocks.db.delete).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.convert).not.toHaveBeenCalled();
    }
  );

  it("keeps a saved Word conversion intact when rendering its original fails", async () => {
    ownedDocument("course.docx");
    mocks.download.mockResolvedValueOnce(Buffer.from(DOCX));
    mocks.renderWord.mockRejectedValueOnce(
      new WordToPdfError("Word rendering unavailable.", 503)
    );
    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(503);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("keeps the saved Word original and records usage when storing its new PDF fails after model success", async () => {
    ownedDocument("course.docx");
    mocks.download.mockResolvedValueOnce(Buffer.from(DOCX));
    mocks.upload.mockRejectedValueOnce(new Error("private storage details"));

    const response = await POST(request({ documentId: "doc-1" }));

    expect(response.status).toBe(500);
    expect(mocks.db.insert).not.toHaveBeenCalledWith(documents);
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "output_storage_failed",
      })
    );
    expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
      { jobId: "job-1", ...usage, costUsd: "0.001" },
    ]);
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(mocks.upload.mock.calls.map(([key]) => key)).toEqual([
      "session-1/doc-1/source.pdf",
    ]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.convert).toHaveBeenCalled();
    expect(artifactValues()).toEqual([]);
    expect(
      JSON.stringify([
        await response.json(),
        vi.mocked(console.error).mock.calls,
      ])
    ).not.toContain("private storage details");
  });

  it.each([
    { name: "course.pdf", contents: PDF },
    { name: "course.docx", contents: DOCX },
  ])(
    "marks the job failed and retains billing when $name HTML storage fails",
    async (input) => {
      mocks.upload.mockImplementation(async (key: string) => {
        if (key.endsWith("output.html"))
          throw new Error("private worker credentials and document text");
      });
      const response = await POST(request(input));
      expect(response.status).toBe(500);
      expect(updated.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          errorCode: "output_storage_failed",
          completedAt: expect.any(String),
        })
      );
      expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
        { jobId: "job-1", ...usage, costUsd: "0.001" },
      ]);
      expect(inserted.get(jobEvents)?.values).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "output_storage_failed" })
      );
      expect(artifactValues()).toEqual([]);
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(
        JSON.stringify([
          await response.json(),
          vi.mocked(console.error).mock.calls,
        ])
      ).not.toContain("private worker credentials");
    }
  );

  it("queues the new document for retryable cleanup if storing the rendered PDF fails", async () => {
    mocks.upload
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage details must stay private"));
    const response = await POST(
      request({ name: "course.docx", contents: DOCX })
    );

    expect(response.status).toBe(500);
    expect(mocks.db.delete).not.toHaveBeenCalledWith(documents);
    expect(mocks.db.update).toHaveBeenCalledWith(documents);
    expect(updated.set).toHaveBeenCalledWith({ deletedAt: expect.any(String) });
    expect(mocks.purgeDocumentIfEligible).toHaveBeenCalledWith("doc-1");
    expect(mocks.db.insert).not.toHaveBeenCalledWith(conversionJobs);
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("does not render or access the database for an unauthorized Word upload", async () => {
    mocks.auth.mockResolvedValueOnce({
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = await POST(
      request({ name: "course.docx", contents: DOCX })
    );

    expect(response.status).toBe(401);
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.renderWord).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects unsupported saved formats before downloading a source", async () => {
    ownedDocument("course.doc");
    const response = await POST(request({ documentId: "doc-1" }));
    expect(response.status).toBe(415);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.renderWord).not.toHaveBeenCalled();
  });

  it("does not expose unexpected renderer diagnostics", async () => {
    mocks.renderWord.mockRejectedValueOnce(
      new Error("private-document-text; renderer-password")
    );
    const response = await POST(
      request({ name: "course.docx", contents: DOCX })
    );
    expect(response.status).toBe(500);
    expect(
      JSON.stringify([
        await response.json(),
        vi.mocked(console.error).mock.calls,
      ])
    ).not.toMatch(/private-document-text|renderer-password/);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it.each([
    { name: "course.docx", contents: PDF },
    { name: "empty.docx", contents: "" },
    { name: "course.doc", contents: DOCX },
    { name: "course", contents: DOCX },
    { name: "partial.docx", contents: "PK\x03" },
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
      expect(mocks.renderWord).not.toHaveBeenCalled();
    }
  );

  it("rejects uploads over the shared size limit before persistence", async () => {
    const response = await POST(
      request({ contents: PDF + "x".repeat(MAX_FILE_SIZE_BYTES) })
    );

    expect(response.status).toBe(413);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.renderWord).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each(["course.pdf", "course.docx"])(
    "rejects corrupt stored %s before mutating the existing job",
    async (filename) => {
      ownedDocument(filename);
      mocks.download.mockResolvedValueOnce(Buffer.from("not a document"));

      const response = await POST(request({ documentId: "doc-1" }));

      expect(response.status).toBe(415);
      expect(mocks.db.insert).not.toHaveBeenCalled();
      expect(mocks.db.update).not.toHaveBeenCalled();
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.renderWord).not.toHaveBeenCalled();
      expect(mocks.convert).not.toHaveBeenCalled();
    }
  );

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
    expect(mocks.renderWord).not.toHaveBeenCalled();
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
    expect(mocks.renderWord).not.toHaveBeenCalled();
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

  it("anchors both job and artifact expiry to the original document, including reconversion", async () => {
    ownedDocument();
    expect((await POST(request({ documentId: "doc-1" }))).status).toBe(200);
    expect(inserted.get(conversionJobs)?.values).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: "2026-09-15T00:00:00.000Z" })
    );
    expect(
      inserted.get(conversionJobs)?.onConflictDoUpdate
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ expiresAt: "2026-09-15T00:00:00.000Z" }),
      })
    );
    for (const artifact of artifactValues()) {
      expect(artifact.expiresAt).toBe("2026-09-15T00:00:00.000Z");
    }
  });

  it("rejects a saved document that expires before its source is read", async () => {
    ownedDocument();
    mocks.withRetainedDocument.mockRejectedValueOnce(
      new DocumentUnavailableError()
    );
    expect((await POST(request({ documentId: "doc-1" }))).status).toBe(410);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.renderWord).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not recreate expired/deleted content after the model returns (failed=%s)",
    async (failed) => {
      mocks.convert.mockImplementationOnce(async () => {
        mocks.withRetainedDocument.mockRejectedValueOnce(
          new DocumentUnavailableError()
        );
        return failed
          ? { error: "Conversion failed", calls: [usage] }
          : {
              html: "<h2>Late output</h2>",
              errors: [],
              model: usage.model,
              tokensUsed: 150,
              calls: [usage],
              extractionWarnings: [],
            };
      });
      const response = await POST(request());
      expect(response.status).toBe(410);
      expect(mocks.upload).toHaveBeenCalledTimes(1); // Original upload only.
      expect(artifactValues()).toEqual([]);
      expect(inserted.get(jobEvents)).toBeUndefined();
      expect(inserted.get(modelCalls)).toBeUndefined();
    }
  );

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
