import { describe, expect, it } from "vitest";
import {
  createJobDiagnostic,
  describeJobDiagnostic,
  diagnosticStageLabel,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_STAGES,
  readJobDiagnostic,
  type DiagnosticStage,
} from "@/lib/job-diagnostics";

describe("safe saved job diagnostics", () => {
  it("explains a full or expired PDF queue without document or infrastructure details", () => {
    const diagnostic = createJobDiagnostic({
      stage: "pdf_render",
      code: "pdf_renderer_busy",
      elapsedMs: 30_000,
      message: "private document",
    });
    expect(readJobDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(describeJobDiagnostic(diagnostic)).toBe(
      "PDF page preparation stopped. Several documents are being prepared right now. Please try this document again shortly."
    );
  });

  it("retains only bounded fields and supplies the supported version", () => {
    const safe = {
      version: 1,
      stage: "audit",
      code: "provider_rate_limit",
      pageNumber: 5,
      httpStatus: 429,
      elapsedMs: 1234,
      attemptNumber: 2,
      model: "openai/gpt-5.6-sol",
      retryAfterSeconds: 15,
      providerRequestId: "019b2c4d-e5f6-7890-abcd-ef1234567890",
    };
    expect(
      createJobDiagnostic({
        ...safe,
        version: undefined,
        message: "student record",
        request: { api_key: "secret" },
        source: "data:application/pdf;base64,private",
        stack: "secret stack",
        providerBody: "private body",
      })
    ).toEqual(safe);
    expect(readJobDiagnostic(safe)).toEqual(safe);
  });

  it.each(DIAGNOSTIC_CODES)("reads and explains known code %s", (code) => {
    const diagnostic = createJobDiagnostic({ stage: "conversion", code });
    expect(readJobDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(describeJobDiagnostic(diagnostic)).toMatch(
      /^HTML conversion stopped\. .+/
    );
  });

  it.each(DIAGNOSTIC_STAGES)("has a readable stage label for %s", (stage) => {
    expect(diagnosticStageLabel(stage)).toMatch(/[A-Za-z]/);
    expect(
      readJobDiagnostic({ version: 1, stage, code: "unknown_error" })?.stage
    ).toBe(stage);
  });

  it.each([
    undefined,
    null,
    [],
    "private text",
    {},
    { version: 2, stage: "audit", code: "provider_quota" },
    { version: 1, stage: "private text", code: "provider_quota" },
    { version: 1, stage: "audit", code: "constructor" },
  ])(
    "does not treat unsupported or legacy metadata as a diagnostic: %j",
    (input) => {
      expect(readJobDiagnostic(input)).toBeNull();
    }
  );

  it("drops invalid numeric values instead of retaining or coercing them", () => {
    expect(
      createJobDiagnostic({
        pageNumber: 0,
        httpStatus: 600,
        elapsedMs: Infinity,
        attemptNumber: "2",
        retryAfterSeconds: 86401,
      })
    ).toEqual({ version: 1, stage: "unknown", code: "unknown_error" });
    expect(
      createJobDiagnostic({
        pageNumber: 1.5,
        elapsedMs: -1,
        attemptNumber: NaN,
      })
    ).toEqual({
      version: 1,
      stage: "unknown",
      code: "unknown_error",
    });
    expect(
      createJobDiagnostic({ elapsedMs: 0, retryAfterSeconds: 0 })
    ).toMatchObject({
      elapsedMs: 0,
      retryAfterSeconds: 0,
    });
  });

  it.each([
    "student@example.edu",
    "https://provider.test/key",
    "sk-private-key",
    "Bearer secret",
    "eyJhbGciOiJIUzI1NiJ9.credential",
    "model\nprivate text",
    "x".repeat(129),
    "<script>",
  ])("drops unsafe model text %j", (model) => {
    expect(createJobDiagnostic({ model })).not.toHaveProperty("model");
  });

  it.each([
    "req_private-document",
    "https://provider.test/secret",
    "sk-private-key",
    "private text",
    "019b2c4d-e5f6-7890-abcd-ef1234567890\n",
    "019b2c4d-e5f6-7890-abcd-ef1234567890private",
  ])("drops non-UUID provider request IDs %j", (providerRequestId) => {
    expect(createJobDiagnostic({ providerRequestId })).not.toHaveProperty(
      "providerRequestId"
    );
  });

  it("gives faculty a specific page and next step without administrative identifiers", () => {
    const diagnostic = createJobDiagnostic({
      stage: "pdf_render",
      code: "pdf_password",
      pageNumber: 5,
      model: "private-model",
      providerRequestId: "019b2c4d-e5f6-7890-abcd-ef1234567890",
    });
    expect(describeJobDiagnostic(diagnostic)).toBe(
      "PDF page preparation stopped on PDF page 5. The PDF is encrypted or password-protected. Upload an unprotected copy."
    );
    expect(
      describeJobDiagnostic({
        ...diagnostic,
        code: "provider_rate_limit",
        retryAfterSeconds: 15,
      })
    ).toContain("waiting 15 seconds");
    expect(
      describeJobDiagnostic({
        ...diagnostic,
        code: "provider_budget",
        retryAfterSeconds: 15,
      })
    ).not.toContain("waiting");
  });

  it("does not interpret unexpected properties or unsafe objects as instructions", () => {
    expect(
      createJobDiagnostic({ stage: "constructor", code: "__proto__" })
    ).toEqual({
      version: 1,
      stage: "unknown",
      code: "unknown_error",
    });
    expect(diagnosticStageLabel("constructor" as DiagnosticStage)).toBe(
      "Document processing"
    );
    const unexpected = {
      get version() {
        throw new Error("private text");
      },
    };
    expect(readJobDiagnostic(unexpected)).toBeNull();
    expect(createJobDiagnostic(unexpected)).toEqual({
      version: 1,
      stage: "unknown",
      code: "unknown_error",
    });
  });
});
