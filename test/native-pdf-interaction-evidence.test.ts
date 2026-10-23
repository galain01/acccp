import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  getNativePdfInteractionTests,
  nativePdfInteractionSummary,
  reconcileNativePdfInteractionFindings,
  validFormInteractionReview,
  NATIVE_PDF_INTERACTION_TESTS,
} from "../lib/native-pdf-interaction-evidence";
import {
  pdfSha256,
  type NativePdfState,
  type NativePdfFinding,
} from "../lib/native-pdf-worker";

const record = NATIVE_PDF_INTERACTION_TESTS[0];
function fixture() {
  const pdf = Buffer.from("%PDF-1.7 unit-test worker result");
  const names = [
    ...new Set(
      [...record.coverage, ...record.remainingReviewCoverage].flatMap(
        (check) => check.fieldNames
      )
    ),
  ];
  while (names.length < 23) names.push(`other-field-${names.length}`);
  const fields = names.map((name, index) => ({
    name,
    fieldId: `field-${String(index).padStart(64, "0")}`,
    pageNumbers: [1],
  }));
  const forms = {
    fields,
    field_count: 23,
    widget_count: 23,
    hybrid: {
      type: "static-xfa-with-acroform",
      formLogicPreserved: true,
      verification: { passed: true },
    },
    interactionFingerprint: { ...record.interactionFingerprint },
  };
  const state: NativePdfState = {
    schemaVersion: 1,
    sourceSha256: record.sourceSha256,
    candidateSha256: pdfSha256(pdf),
    pdf,
    pageCount: 6,
    inventory: { tags: [], page_content: [], forms },
    findings: [],
    changes: [],
    machineChecks: {
      preservationPassed: true,
      pixelsIdentical: true,
      inspectionComplete: true,
      structurePassed: true,
      targetStandard: "PDF/UA-1",
      conformanceClaim: false,
      veraPdf: {
        completed: true,
        compliant: false,
        failedRules: 2,
        failedChecks: 3,
      },
    },
  };
  return { state, forms, fields };
}
const generic: NativePdfFinding = {
  code: "legacy_form_interaction_review",
  severity: "warning",
  message: "Check form operation.",
};
const font: NativePdfFinding = {
  code: "font-missing",
  severity: "error",
  message: "A font mapping is missing.",
};
function request(fieldId: string): NativePdfFinding {
  return {
    code: "form-interaction-review",
    severity: "warning",
    pageNumber: 1,
    location: "Name field",
    message: "Check the announcement.",
    suggestion: "Listen to the field name.",
    interactionReview: {
      basis: "not-tested",
      action: "field-announcement",
      fieldIds: [fieldId],
    },
  };
}
describe("reviewed PDF form interaction evidence", () => {
  it("matches the source and saved form to the expanded, action-specific control tests", () => {
    const { state, fields } = fixture();
    const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
    expect(tests).toMatchObject({
      evidenceId: record.evidenceId,
      scope: "prior-tests-of-matching-form",
      testsRunDuringThisConversion: false,
    });
    expect(
      tests.coverage.find((check) => check.action === "field-announcement")
        ?.fieldIds
    ).toHaveLength(23);
    expect(
      tests.coverage.find((check) => check.action === "keyboard-navigation")
        ?.fieldIds
    ).toHaveLength(23);
    expect(
      tests.coverage.find((check) => check.action === "checkbox-operation")
        ?.fieldIds
    ).toHaveLength(8);
    expect(
      tests.coverage.find((check) => check.action === "text-entry")?.fieldIds
    ).toHaveLength(15);
    expect(
      tests.coverage.find((check) => check.action === "save-reopen")?.fieldIds
    ).toHaveLength(23);
    expect(
      tests.coverage.every((check) =>
        check.fieldIds.every((id) =>
          fields.some((field) => field.fieldId === id)
        )
      )
    ).toBe(true);
    expect(tests.remainingReviews.map((review) => review.code)).toEqual([
      "form-signing-method",
      "form-dating-method",
      "form-certification-crossout-method",
    ]);
    const summary = nativePdfInteractionSummary(tests);
    expect(summary.scopeNote).toContain("not rerun");
    expect(summary.scopeNote).toContain("listed actions");
    expect(summary.scopeNote).not.toContain("do not cover every control");
    expect(tests.coverage.some((check) => check.action === "signing")).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("ACCESSIBILITY TEST ONLY");
  });
  it.each([
    "different source",
    "different form",
    "missing fingerprint",
    "old fingerprint schema",
    "different pages",
    "different field count",
    "corrupt candidate",
    "missing preservation",
    "duplicate field names",
    "missing tested field",
  ])("does not transfer test evidence for %s", (change) => {
    const { state, forms, fields } = fixture();
    if (change === "different source") state.sourceSha256 = "b".repeat(64);
    if (change === "different form")
      forms.interactionFingerprint.sha256 = "b".repeat(64);
    if (change === "missing fingerprint")
      delete (state.inventory.forms as Record<string, unknown>)
        .interactionFingerprint;
    if (change === "old fingerprint schema")
      (
        forms.interactionFingerprint as { schemaVersion: number }
      ).schemaVersion = 2;
    if (change === "different pages") state.pageCount = 5;
    if (change === "different field count") forms.field_count = 22;
    if (change === "corrupt candidate") state.pdf = Buffer.from("%PDF changed");
    if (change === "missing preservation")
      (
        state.machineChecks as unknown as Record<string, unknown>
      ).preservationPassed = false;
    if (change === "duplicate field names") fields[1].name = fields[0].name;
    if (change === "missing tested field") fields[0].name = "unrelated";
    expect(
      getNativePdfInteractionTests(state, record.sourceSha256)
    ).toBeUndefined();
  });
  it("cannot use a caller's different source or a PDF inventory's claimed test record", () => {
    const { state } = fixture();
    state.inventory.priorMatchingInteractionTests = { allPassed: true };
    expect(getNativePdfInteractionTests(state, "f".repeat(64))).toBeUndefined();
    (state.inventory.forms as Record<string, unknown>).interactionFingerprint =
      undefined;
    expect(
      getNativePdfInteractionTests(state, record.sourceSha256)
    ).toBeUndefined();
  });
  it("replaces the blanket reminder and consolidates typed requests while retaining actual and mixed concerns", () => {
    const { state, fields } = fixture();
    const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
    const newDefect: NativePdfFinding = {
      code: "form-label-defect",
      severity: "warning",
      pageNumber: 1,
      message:
        "The label contradicts the printed instruction; also check keyboard operation.",
    };
    const reminder = request(fields[0].fieldId);
    const unsupported = {
      ...reminder,
      code: "other-form-concern",
      interactionReview: undefined,
    };
    const result = reconcileNativePdfInteractionFindings(
      [generic, font],
      [reminder, reminder, newDefect, unsupported],
      state,
      tests
    );
    expect(result).toEqual([
      font,
      ...tests.remainingReviews,
      newDefect,
      unsupported,
    ]);
    expect(result.some((finding) => finding.code === "form-remaining-controls")).toBe(false);
  });
  it("retains an error even if it uses the legacy reminder code", () => {
    const { state } = fixture();
    const failure = { ...generic, severity: "error" as const };
    const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
    expect(
      reconcileNativePdfInteractionFindings([failure, font], [], state, tests)
    ).toContain(failure);
  });
  it("consolidates only action/field pairs explicitly covered by tests or a displayed remaining review", () => {
    const { state, fields } = fixture();
    const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
    const name = fields.find((field) => field.name.endsWith(".f1_01[0]"))!;
    const firstSegment = fields.find((field) =>
      field.name.endsWith(".f1_11[0]")
    )!;
    const firstChoice = fields.find((field) =>
      field.name.endsWith(".c1_1[0]")
    )!;
    const navigation: NativePdfFinding = {
      ...request(firstSegment.fieldId),
      interactionReview: {
        basis: "not-tested",
        action: "keyboard-navigation",
        fieldIds: [firstSegment.fieldId],
      },
    };
    const saving: NativePdfFinding = {
      ...request(firstChoice.fieldId),
      interactionReview: {
        basis: "not-tested",
        action: "save-reopen",
        fieldIds: [firstChoice.fieldId],
      },
    };
    expect(
      reconcileNativePdfInteractionFindings(
        [generic],
        [navigation, saving],
        state,
        tests
      )
    ).toEqual(tests.remainingReviews);
    const narrower = {
      ...tests,
      coverage: tests.coverage.map((check) => ({
        ...check,
        fieldIds: check.fieldIds.filter((id) =>
          !(check.action === "keyboard-navigation" && id === firstSegment.fieldId) &&
          !(check.action === "save-reopen" && id === firstChoice.fieldId)
        ),
      })),
      remainingReviewCoverage: [],
    };
    expect(
      reconcileNativePdfInteractionFindings(
        [generic],
        [navigation, saving],
        state,
        narrower
      )
    ).toEqual([...tests.remainingReviews, navigation, saving]);
    const absentReview = {
      ...tests,
      coverage: narrower.coverage,
      remainingReviews: [],
    };
    expect(
      reconcileNativePdfInteractionFindings(
        [generic],
        [navigation],
        state,
        absentReview
      )
    ).toEqual([navigation]);
    const mixed: NativePdfFinding = {
      ...navigation,
      interactionReview: {
        ...navigation.interactionReview!,
        fieldIds: [name.fieldId, firstSegment.fieldId],
      },
    };
    expect(
      reconcileNativePdfInteractionFindings([], [mixed], state, narrower)
    ).toContainEqual(mixed);
    const sign: NativePdfFinding = {
      ...navigation,
      interactionReview: {
        basis: "not-tested",
        action: "signing",
        fieldIds: [],
      },
    };
    expect(
      reconcileNativePdfInteractionFindings([], [sign], state, tests)
    ).toEqual(tests.remainingReviews);
    expect(
      reconcileNativePdfInteractionFindings([], [sign], state, narrower)
    ).toContainEqual(sign);
  });
  it("clears repeated all-control requests while preserving a concrete defect on a tested control", () => {
    const { state, fields } = fixture();
    const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
    const allControls: NativePdfFinding = {
      ...request(fields[0].fieldId),
      interactionReview: {
        basis: "not-tested",
        action: "field-announcement",
        fieldIds: fields.map((field) => field.fieldId),
      },
    };
    const defect: NativePdfFinding = {
      ...allControls,
      code: "form-instruction-contradiction",
      interactionReview: undefined,
      message: "The field description conflicts with the nearby instruction.",
    };
    expect(
      reconcileNativePdfInteractionFindings([generic, font], [allControls, defect], state, tests)
    ).toEqual([font, ...tests.remainingReviews, defect]);
  });
  it("describes test scope honestly when no registered reminders remain", () => {
    const { state } = fixture();
    const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
    const summary = nativePdfInteractionSummary({ ...tests, remainingReviews: [] });
    expect(summary.scopeNote).toContain("not rerun");
    expect(summary.scopeNote).toContain("Other PDF readers and unlisted actions");
    expect(summary.scopeNote).not.toContain("listed below");
  });
  it.each(["signing", "dating", "certification-crossout"] as const)(
    "keeps the specific unpassed %s action visible after all-control testing",
    (action) => {
      const { state, fields } = fixture();
      const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
      const reminder: NativePdfFinding = {
        ...request(fields[0].fieldId),
        interactionReview: { basis: "not-tested", action, fieldIds: [] },
      };
      expect(tests.coverage.some((check) => check.action === action)).toBe(false);
      const remaining = tests.remainingReviewCoverage.filter(
        (check) => check.action === action
      );
      expect(remaining).toHaveLength(1);
      expect(tests.remainingReviews.some((review) => review.code === remaining[0].reviewCode)).toBe(true);
      expect(
        reconcileNativePdfInteractionFindings([], [reminder], state, tests)
      ).toEqual(tests.remainingReviews);
      expect(
        reconcileNativePdfInteractionFindings([], [reminder], state, {
          ...tests,
          remainingReviewCoverage: tests.remainingReviewCoverage.filter(
            (check) => check.action !== action
          ),
        })
      ).toContainEqual(reminder);
    }
  );
  it("keeps untested-form guidance on a mismatch and collapses only duplicate test requests", () => {
    const { state, fields } = fixture();
    const reminder = request(fields[0].fieldId);
    const sign: NativePdfFinding = {
      ...reminder,
      interactionReview: {
        basis: "not-tested",
        action: "signing",
        fieldIds: [],
      },
    };
    expect(
      reconcileNativePdfInteractionFindings(
        [generic, generic, font],
        [reminder, reminder, sign, sign],
        state
      )
    ).toEqual([font, generic, sign]);
    expect(
      reconcileNativePdfInteractionFindings([], [reminder, reminder], state)
    ).toEqual([reminder]);
  });
  it("does not interpret arbitrary field IDs, malformed claims or failures as tested reminders", () => {
    const { state, fields } = fixture();
    const tests = getNativePdfInteractionTests(state, record.sourceSha256)!;
    const known = request(fields[0].fieldId);
    expect(validFormInteractionReview(known.interactionReview, state, 1)).toBe(
      true
    );
    expect(validFormInteractionReview(known.interactionReview, state, 2)).toBe(
      false
    );
    expect(
      validFormInteractionReview(
        { ...known.interactionReview, basis: "observed-failure" },
        state,
        1
      )
    ).toBe(false);
    expect(
      validFormInteractionReview(
        { ...known.interactionReview, fieldIds: ["field-" + "f".repeat(64)] },
        state,
        1
      )
    ).toBe(false);
    expect(
      validFormInteractionReview(
        { ...known.interactionReview, fieldIds: [] },
        state,
        1
      )
    ).toBe(false);
    const forged = { ...known, severity: "error" as const };
    expect(
      reconcileNativePdfInteractionFindings([], [forged], state, tests)
    ).toContain(forged);
  });
});
