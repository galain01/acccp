import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  createJobDiagnostic,
  describeJobDiagnostic,
} from "@/lib/job-diagnostics";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  convert: vi.fn(),
  convertPowerPoint: vi.fn(),
  convertWord: vi.fn(),
  repairNativePdf: vi.fn(),
  pdfTransport: vi.fn(),
  renderWord: vi.fn(),
  countPages: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  finalizeUpload: vi.fn(),
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
vi.mock("@/lib/document-upload", () => ({
  readAndFinalizePowerPointUpload: mocks.finalizeUpload,
  DocumentUploadError: class extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/convert", () => ({ convertPdf: mocks.convert }));
vi.mock("@/lib/word-convert", () => ({ convertWord: mocks.convertWord }));
vi.mock("@/lib/native-pdf-convert", () => ({
  repairNativePdf: mocks.repairNativePdf,
}));
vi.mock("@/lib/native-pdf-transport-storage", () => ({
  createNativePdfTransport: () => mocks.pdfTransport,
}));
vi.mock("@/lib/powerpoint-convert", () => ({
  convertPowerPoint: mocks.convertPowerPoint,
}));
vi.mock("@/lib/pdf-page-count", () => ({ countPdfPages: mocks.countPages }));
vi.mock("@/lib/word-to-pdf", async () => ({
  ...(await vi.importActual<typeof import("@/lib/word-to-pdf")>(
    "@/lib/word-to-pdf"
  )),
  renderWordToPdf: mocks.renderWord,
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
  sourcePptxKey: (sessionId: string, documentId: string) =>
    `${sessionId}/${documentId}/source.pptx`,
  docxOutputKey: (s: string, d: string, j: string) =>
    `${s}/${d}/${j}/output.docx`,
  pptxOutputKey: (sessionId: string, documentId: string, jobId: string) =>
    `${sessionId}/${documentId}/${jobId}/output.pptx`,
  pdfOutputKey: (s: string, d: string, j: string) =>
    `${s}/${d}/${j}/output.pdf`,
  outputReviewKey: (sessionId: string, documentId: string, jobId: string) =>
    `${sessionId}/${documentId}/${jobId}/review.json`,
}));

import { POST } from "@/app/api/convert/route";
import { DocumentUnavailableError } from "@/lib/document-retention";
import {
  artifacts,
  conversionJobs,
  dailyFailureMetrics,
  documents,
  jobEvents,
  modelCalls,
  validationFindings,
} from "@/lib/db/schema";
import { MAX_FILE_SIZE_BYTES } from "@/lib/document-input";

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
    leftJoin: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    values: vi.fn(),
    set: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn(),
    returning: vi.fn().mockResolvedValue(value),
    then: Promise.resolve(value).then.bind(Promise.resolve(value)),
  };
  for (const method of [
    builder.from,
    builder.leftJoin,
    builder.innerJoin,
    builder.where,
    builder.values,
    builder.set,
    builder.onConflictDoUpdate,
    builder.onConflictDoNothing,
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
    outputTarget?: string;
  } = {}
) {
  const form = new FormData();
  form.set("sessionId", "session-1");
  form.set("outputTarget", options.outputTarget ?? "accessible_pdf");
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

function immutableKey(type: string) {
  return expect.stringMatching(
    new RegExp(`^session-1/doc-1/job-1/publication-[0-9a-f-]+/${type}$`)
  );
}

function expectPendingReceipts(types: string[]) {
  expect(artifactValues()).toEqual(
    types.map((artifactType) =>
      expect.objectContaining({
        artifactType,
        artifactStatus: "expired",
        isUserDownloadable: false,
        storageKey: immutableKey(artifactType),
        checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: "2026-09-15T00:00:00.000Z",
      })
    )
  );
}

function artifactValues() {
  return mocks.db.insert.mock.results
    .filter((_, index) => mocks.db.insert.mock.calls[index][0] === artifacts)
    .map((result) => result.value.values.mock.calls[0][0]);
}

describe("native PDF conversion route", () => {
  const inserted = new Map<unknown, ReturnType<typeof chain>>();
  const updated = chain([{ id: "promoted-receipt" }]);
  afterEach(() => {
    vi.useRealTimers();
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
            document: { createdAt: string; sessionId: string }
          ) => unknown
        ) =>
          action(mocks.db, {
            createdAt: "2026-09-01T00:00:00.000Z",
            sessionId: "session-1",
          })
      );
    mocks.purgeDocumentIfEligible.mockResolvedValue("purged");
    mocks.auth.mockResolvedValue({ session: { user: { id: "user-1" } } });
    mocks.db.select.mockImplementation((fields) =>
      fields?.attemptNumber
        ? chain([{ attemptNumber: 2, status: "processing" }])
        : fields
          ? chain([{ id: "session-1" }])
          : chain([])
    );
    mocks.db.insert.mockImplementation((table: unknown) => {
      const result =
        table === documents
          ? [{ id: "doc-1" }]
          : table === conversionJobs
            ? [{ id: "job-1", attemptNumber: 2 }]
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
    mocks.finalizeUpload
      .mockReset()
      .mockImplementation(
        async ({
          sessionId,
          documentId,
        }: {
          sessionId: string;
          documentId: string;
        }) => ({
          buffer: await mocks.download(
            `${sessionId}/${documentId}/source.pptx`
          ),
          filename: "slides.pptx",
        })
      );
    mocks.renderWord.mockResolvedValue(Buffer.from(PDF));
    mocks.countPages.mockResolvedValue(8);
    mocks.repairNativePdf.mockResolvedValue({
      pdf: Buffer.from("%PDF-1.7\nrepaired test bytes\n%%EOF"),
      errors: [
        {
          type: "other",
          severity: "warning",
          category: "source-review",
          title: "Review PDF page 2",
          message: "Check the chart description.",
          suggestion: "Check the chart on page 2 before sharing the PDF.",
          location: { scope: "element", sourcePages: [2], locator: "Chart" },
        },
      ],
      changes: ["Page 1: identified the document heading."],
      model: usage.model,
      tokensUsed: 300,
      extractionWarnings: [],
      calls: [usage, { ...usage, stage: "validate" }],
      pageCount: 3,
      nativePdfChecks: {
        preservationPassed: true,
        inspectionComplete: true,
        structurePassed: true,
        pixelsIdentical: true,
        targetStandard: "PDF/UA-1 (ISO 14289-1:2014)",
        veraPdf: {
          completed: true,
          compliant: false,
          failedRules: 1,
          failedChecks: 1,
        },
        conformanceClaim: false,
        auditComplete: true,
        screenReaderTestPerformed: false,
      },
    });
    mocks.convert.mockResolvedValue({
      html: "<h2>Course</h2><p>Content</p>",
      errors: [],
      model: usage.model,
      tokensUsed: 150,
      extractionWarnings: [],
      calls: [usage],
    });
    mocks.convertWord.mockResolvedValue({
      docx: Buffer.from("PK\x03\x04repaired Word"),
      errors: [],
      changes: [
        "Course schedule: identified the first row as column headings.",
      ],
      model: usage.model,
      tokensUsed: 300,
      extractionWarnings: [],
      calls: [usage, { ...usage, stage: "validate" }],
      pageCount: 3,
    });
    mocks.convertPowerPoint.mockResolvedValue({
      pptx: Buffer.from("PK\x03\x04remediated presentation"),
      errors: [],
      changes: ["Slide 2: added a title for navigation."],
      model: usage.model,
      tokensUsed: 150,
      extractionWarnings: [],
      calls: [usage],
      pageCount: 6,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([true, false])(
    "persists and returns only a valid interaction summary (valid=%s)",
    async (valid) => {
      const summary = {
        evidenceId: "synthetic-form-test",
        testedAt: "2026-10-22",
        environment: "Acrobat and NVDA",
        passedChecks: ["The name field announced its label."],
        scopeNote:
          "Earlier tests match this form; they were not rerun for this conversion.",
      };
      const repair = mocks.repairNativePdf.getMockImplementation()!;
      mocks.repairNativePdf.mockImplementationOnce(async (...args) => ({
        ...(await repair(...args)),
        interactionTestSummary: valid
          ? summary
          : { ...summary, privateTranscript: "omit" },
      }));
      const response = await POST(request());
      expect(response.status).toBe(200);
      const body = await response.json();
      const review = JSON.parse(mocks.upload.mock.calls[2][1]);
      const event = inserted.get(jobEvents)?.values.mock.calls[0][0];
      expect(event).toMatchObject({
        eventType: "conversion_completed",
        metadata: { attemptNumber: 2 },
      });
      for (const published of [body, review, event.metadata]) {
        if (valid) expect(published.interactionTestSummary).toEqual(summary);
        else expect(published).not.toHaveProperty("interactionTestSummary");
      }
    }
  );

  it("stores separate original and repaired PDF artifacts with checks, findings and both model stages", async () => {
    const response = await POST(request({ name: "Course.PDF" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      documentId: "doc-1",
      jobId: "job-1",
      outputTarget: "accessible_pdf",
      tokensUsed: 300,
    });
    expect(body).not.toHaveProperty("html");
    expect(body).not.toHaveProperty("pdf");
    expect(body).not.toHaveProperty("interactionTestSummary");
    expect(mocks.repairNativePdf).toHaveBeenCalledExactlyOnceWith(
      Buffer.from(PDF),
      "Course.PDF",
      { transport: mocks.pdfTransport }
    );
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(mocks.convertWord).not.toHaveBeenCalled();
    expect(mocks.convertPowerPoint).not.toHaveBeenCalled();
    expect(mocks.renderWord).not.toHaveBeenCalled();
    expect(mocks.countPages).not.toHaveBeenCalled();
    expect(mocks.upload.mock.calls.map(([key]) => key)).toEqual([
      "session-1/doc-1/source.pdf",
      immutableKey("pdf_output"),
      immutableKey("review_metadata"),
    ]);
    expect(mocks.upload.mock.calls[0].slice(1)).toEqual([
      Buffer.from(PDF),
      "application/pdf",
    ]);
    expect(mocks.upload.mock.calls[1].slice(1)).toEqual([
      Buffer.from("%PDF-1.7\nrepaired test bytes\n%%EOF"),
      "application/pdf",
      expect.objectContaining({
        upsert: false,
        signal: expect.any(AbortSignal),
      }),
    ]);
    expect(inserted.get(documents)?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        checksumSha256: createHash("sha256").update(PDF).digest("hex"),
      })
    );
    const review = JSON.parse(mocks.upload.mock.calls[2][1]);
    expect(review).not.toHaveProperty("interactionTestSummary");
    expect(review).toMatchObject({
      outputTarget: "accessible_pdf",
      profileVersion: "pdf-v1",
      changes: body.changes,
      findings: body.errors,
      nativePdfChecks: {
        conformanceClaim: false,
        screenReaderTestPerformed: false,
      },
    });
    expect(artifactValues().map((value) => value.artifactType)).toEqual([
      "pdf_output",
      "review_metadata",
      "source_pdf",
    ]);
    expect(artifactValues()[0]).toMatchObject({
      filename: "Course-repaired.pdf",
      mimeType: "application/pdf",
    });
    expect(
      artifactValues().every((value) => value.previewSnippet == null)
    ).toBe(true);
    expect(inserted.get(conversionJobs)?.values).toHaveBeenCalledWith(
      expect.objectContaining({
        outputTarget: "accessible_pdf",
        profileVersion: "pdf-v1",
        expiresAt: "2026-09-15T00:00:00.000Z",
      })
    );
    expect(updated.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageCount: 3, status: "completed" })
    );
    expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
      expect.objectContaining({
        stage: "convert",
        costUsd: "0.001",
        jobId: "job-1",
      }),
      expect.objectContaining({
        stage: "validate",
        costUsd: "0.001",
        jobId: "job-1",
      }),
    ]);
    expect(inserted.get(validationFindings)?.values).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Review PDF page 2",
        location: expect.objectContaining({ sourcePages: [2] }),
      }),
    ]);
    expect(
      inserted.get(jobEvents)?.values.mock.calls[0][0].metadata.changes
    ).toEqual(body.changes);
  });

  it("retries from the immutable PDF without resaving the source or creating another document", async () => {
    ownedDocument();
    expect((await POST(request({ documentId: "doc-1" }))).status).toBe(200);
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(
      "session-1/doc-1/source.pdf"
    );
    expect(mocks.repairNativePdf).toHaveBeenCalledExactlyOnceWith(
      Buffer.from(PDF),
      "course.pdf",
      { transport: mocks.pdfTransport }
    );
    expect(inserted.has(documents)).toBe(false);
    expect(mocks.upload.mock.calls.map(([key]) => key)).toEqual([
      immutableKey("pdf_output"),
      immutableKey("review_metadata"),
    ]);
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it.each(["canvas_html", "accessible_pdf"])(
    "rejects changing the saved PDF destination from %s",
    async (savedTarget) => {
      mocks.db.select
        .mockReturnValueOnce(chain([{ id: "session-1" }]))
        .mockReturnValueOnce(
          chain([
            {
              id: "doc-1",
              originalFilename: "course.pdf",
              outputTarget: savedTarget,
            },
          ])
        );
      const response = await POST(
        request({
          documentId: "doc-1",
          outputTarget:
            savedTarget === "canvas_html" ? "accessible_pdf" : "canvas_html",
        })
      );
      expect(response.status).toBe(409);
      expect(mocks.download).not.toHaveBeenCalled();
      expect(mocks.repairNativePdf).not.toHaveBeenCalled();
      expect(mocks.convert).not.toHaveBeenCalled();
      expect(mocks.db.insert).not.toHaveBeenCalled();
    }
  );

  it("rejects another owner's source before repair and guards expired content", async () => {
    mocks.db.select
      .mockReturnValueOnce(chain([{ id: "session-1" }]))
      .mockReturnValueOnce(chain([]));
    expect((await POST(request({ documentId: "other-document" }))).status).toBe(
      404
    );
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.repairNativePdf).not.toHaveBeenCalled();
    ownedDocument();
    mocks.withRetainedDocument.mockRejectedValueOnce(
      new DocumentUnavailableError()
    );
    expect((await POST(request({ documentId: "doc-1" }))).status).toBe(410);
    expect(mocks.repairNativePdf).not.toHaveBeenCalled();
  });

  it("returns a conflict for an active native PDF job without a second model call", async () => {
    ownedDocument();
    const active = chain([{ status: "processing" }]);
    mocks.db.select.mockReturnValueOnce(active);
    expect((await POST(request({ documentId: "doc-1" }))).status).toBe(409);
    const predicate = new PgDialect().sqlToQuery(
      active.where.mock.calls[0][0] as SQL
    );
    expect(predicate.params).toEqual(
      expect.arrayContaining(["doc-1", "accessible_pdf", "processing"])
    );
    expect(mocks.repairNativePdf).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("retains charged calls and controlled diagnostics when preservation fails", async () => {
    const diagnostic = createJobDiagnostic({
      stage: "native_pdf_repair",
      code: "native_pdf_preservation",
      pageNumber: 2,
    });
    mocks.repairNativePdf.mockResolvedValueOnce({
      error: "private worker text",
      calls: [usage, { ...usage, stage: "validate" }],
      diagnostic,
    });
    const response = await POST(request());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.detail).toBe(
      describeJobDiagnostic({ ...diagnostic, attemptNumber: 2 })
    );
    expect(JSON.stringify(body)).not.toContain("private worker");
    expect(body.outputTarget).toBe("accessible_pdf");
    expect(mocks.upload.mock.calls.map(([key]) => key)).toEqual([
      "session-1/doc-1/source.pdf",
    ]);
    expect(updated.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "native_pdf_preservation",
      })
    );
    expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
      expect.objectContaining({ stage: "convert", costUsd: "0.001" }),
      expect.objectContaining({ stage: "validate", costUsd: "0.001" }),
    ]);
    expect(inserted.has(dailyFailureMetrics)).toBe(true);
    expect(artifactValues()).toEqual([]);
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "course.pdf",
      contents: PDF,
      outputTarget: "accessible_pdf",
      engine: mocks.repairNativePdf,
    },
    {
      name: "course.docx",
      contents: DOCX,
      outputTarget: "accessible_docx",
      engine: mocks.convertWord,
    },
    {
      name: "course.pptx",
      contents: DOCX,
      outputTarget: "accessible_pptx",
      engine: mocks.convertPowerPoint,
    },
    {
      name: "course.pdf",
      contents: PDF,
      outputTarget: "canvas_html",
      engine: mocks.convert,
    },
  ])(
    "records an unexpected $outputTarget engine rejection and preserves retry identity",
    async (input) => {
      const privateError = Object.assign(
        new Error("private document text; provider-secret"),
        {
          diagnostic: { code: "provider_auth", model: "private-value" },
          calls: [{ ...usage, model: "private-value" }],
        }
      );
      input.engine.mockRejectedValueOnce(privateError);
      const response = await POST(request(input));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({
        documentId: "doc-1",
        jobId: "job-1",
        outputTarget: input.outputTarget,
      });
      expect(updated.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          errorCode: "unknown_error",
          completedAt: expect.any(String),
          processingDurationMs: null,
        })
      );
      expect(inserted.get(jobEvents)?.values).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "conversion_failed",
          metadata: expect.objectContaining({
            diagnostic: expect.objectContaining({
              stage: "conversion",
              code: "unknown_error",
              attemptNumber: 2,
            }),
          }),
        })
      );
      expect(inserted.has(dailyFailureMetrics)).toBe(true);
      expect(inserted.has(modelCalls)).toBe(false);
      expect(artifactValues()).toEqual([]);
      expect(mocks.upload).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify([
          body,
          mocks.db.insert.mock.results.map((r) => r.value.values.mock.calls),
          mocks.db.update.mock.results.map((r) => r.value.set.mock.calls),
          vi.mocked(console.error).mock.calls,
        ])
      ).not.toMatch(/private document|provider-secret|private-value/);
      expect(input.engine).toHaveBeenCalledTimes(1);
    }
  );

  it("does not fail a newer attempt after an older engine unexpectedly rejects", async () => {
    mocks.repairNativePdf.mockImplementationOnce(async () => {
      mocks.db.select.mockReturnValueOnce(chain([{ attemptNumber: 3 }]));
      throw new Error("private worker error");
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      documentId: "doc-1",
      jobId: "job-1",
      outputTarget: "accessible_pdf",
    });
    expect(updated.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
    expect(inserted.has(jobEvents)).toBe(false);
    expect(artifactValues()).toEqual([]);
  });

  it("honors expiry when recording an unexpected engine rejection", async () => {
    mocks.repairNativePdf.mockImplementationOnce(async () => {
      mocks.withRetainedDocument.mockRejectedValueOnce(
        new DocumentUnavailableError()
      );
      throw new Error("private worker error");
    });
    const response = await POST(request());
    expect(response.status).toBe(410);
    expect(updated.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
    expect(inserted.has(jobEvents)).toBe(false);
    expect(artifactValues()).toEqual([]);
  });

  it.each(["pdf_output", "review_metadata"])(
    "retains both model stages if %s cannot be saved",
    async (failedFile) => {
      mocks.upload.mockImplementation(async (key: string) => {
        if (key.endsWith(failedFile))
          throw new Error("private storage failure");
      });
      const response = await POST(request());
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain(
        "private storage"
      );
      expect(updated.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          errorCode: "output_storage_failed",
        })
      );
      expect(inserted.get(modelCalls)?.values).toHaveBeenCalledWith([
        expect.objectContaining({ stage: "convert", costUsd: "0.001" }),
        expect.objectContaining({ stage: "validate", costUsd: "0.001" }),
      ]);
      expectPendingReceipts(["pdf_output", "review_metadata"]);
    }
  );

  it.each(["course.docx", "course.pptx"])(
    "rejects %s as native PDF input before saving",
    async (name) => {
      expect((await POST(request({ name, contents: DOCX }))).status).toBe(415);
      expect(mocks.db.insert).not.toHaveBeenCalled();
      expect(mocks.repairNativePdf).not.toHaveBeenCalled();
      expect(mocks.renderWord).not.toHaveBeenCalled();
      expect(mocks.convert).not.toHaveBeenCalled();
    }
  );

  it("rejects an oversized PDF before repair or persistence", async () => {
    expect(
      (await POST(request({ contents: PDF + "x".repeat(MAX_FILE_SIZE_BYTES) })))
        .status
    ).toBe(413);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.repairNativePdf).not.toHaveBeenCalled();
  });
});
