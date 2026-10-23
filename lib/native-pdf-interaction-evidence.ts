import "server-only";
import {
  objectRecord,
  pdfSha256,
  type NativePdfFinding,
  type NativePdfState,
} from "./native-pdf-worker";
import type { PdfInteractionTestSummary } from "./pdf-interaction-summary";

export const FORM_INTERACTION_ACTIONS = [
  "field-announcement",
  "keyboard-navigation",
  "checkbox-operation",
  "text-entry",
  "save-reopen",
  "signing",
  "dating",
  "certification-crossout",
] as const;
export type FormInteractionAction = (typeof FORM_INTERACTION_ACTIONS)[number];
/** A request to test an interaction, never an observed failure. */
export interface FormInteractionReview {
  basis: "not-tested";
  action: FormInteractionAction;
  fieldIds: string[];
}
interface TestCoverage {
  action: FormInteractionAction;
  fieldNames: string[];
  observation: string;
}
interface RemainingReviewCoverage {
  reviewCode: string;
  pageNumber: number;
  action: FormInteractionAction;
  fieldNames: string[];
}
interface InteractionTestRecord {
  schemaVersion: 1;
  evidenceId: string;
  sourceSha256: string;
  testedPdfSha256: string;
  savedTestCopySha256: string;
  interactionFingerprint: { schemaVersion: 1; sha256: string };
  testedAt: string;
  environment: string;
  pageCount: number;
  fieldCount: number;
  coverage: TestCoverage[];
  remainingReviews: NativePdfFinding[];
  remainingReviewCoverage: RemainingReviewCoverage[];
}
const prefix = "topmostSubform[0].Page1[0].";
const name = prefix + "f1_01[0]";
const business = prefix + "f1_02[0]";
const choice = (index: number) =>
  prefix + `Boxes3a-b_ReadOrder[0].c1_1[${index}]`;
const segment = (number: number) => prefix + `f1_${number}[0]`;
const line3b = prefix + "Boxes3a-b_ReadOrder[0].c1_2[0]";
const textFields = [
  name,
  business,
  prefix + "Boxes3a-b_ReadOrder[0].f1_03[0]",
  prefix + "Boxes3a-b_ReadOrder[0].f1_04[0]",
  prefix + "f1_05[0]",
  prefix + "f1_06[0]",
  prefix + "Address_ReadOrder[0].f1_07[0]",
  prefix + "Address_ReadOrder[0].f1_08[0]",
  prefix + "f1_09[0]",
  prefix + "f1_10[0]",
  ...[11, 12, 13, 14, 15].map(segment),
];
const checkboxes = [...[0, 1, 2, 3, 4, 5, 6].map(choice), line3b];
const allFields = [...textFields, ...checkboxes];

/** Reviewed application evidence, not a ledger supplied by a PDF or a model.
 * See docs/pdf-form-interaction-evidence.md before adding or broadening a record.
 * Raw test logs, entered values and personal document contents stay out of Git.
 */
export const NATIVE_PDF_INTERACTION_TESTS: readonly InteractionTestRecord[] = [
  {
    schemaVersion: 1,
    evidenceId: "w9-2024-acrobat-nvda-2026-10-23-v3",
    sourceSha256:
      "2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53",
    testedPdfSha256:
      "bb6be908a6e9cc4ef3ee4cf880c4d001b9915cb0901e500c069614dabd164756",
    savedTestCopySha256:
      "7799295f8852a4dc5a3bb18702808999cdc724fa5e8d05077b33e9adfeb89bcc",
    interactionFingerprint: {
      schemaVersion: 1,
      sha256:
        "d07869c8d2186e5d545b4ec8adfc2b777c022c141643bd9140c1031d79837ced",
    },
    testedAt: "2026-10-23",
    environment: "Adobe Acrobat 64-bit on Windows with NVDA 2026.2",
    pageCount: 6,
    fieldCount: 23,
    coverage: [
      {
        action: "field-announcement",
        fieldNames: allFields,
        observation:
          "Heard NVDA announce the descriptions of all 23 form controls, including the name requirement, all classification choices, and every SSN/EIN segment.",
      },
      {
        action: "keyboard-navigation",
        fieldNames: allFields,
        observation:
          "Reached all 23 form controls with the Tab key while NVDA announced each control.",
      },
      {
        action: "checkbox-operation",
        fieldNames: checkboxes,
        observation:
          "Used the keyboard to exercise all seven classification choices and the separate line 3b checkbox; choosing another classification cleared the previous choice.",
      },
      {
        action: "text-entry",
        fieldNames: textFields,
        observation:
          "Entered fictional values in all 15 text fields, including business details, exemption codes, addresses, account numbers and all SSN/EIN segments.",
      },
      {
        action: "save-reopen",
        fieldNames: allFields,
        observation:
          "Across the October 22–23 tests, saved and reopened all 15 entered text values and all eight checkbox choices. NVDA announced the five classification selections reopened on October 23, along with the saved business value, LLC code and SSN middle-segment value in the recorded tests.",
      },
    ],
    remainingReviews: [
      {
        code: "form-signing-method",
        severity: "warning",
        pageNumber: 1,
        location: "Part II, Certification: signature",
        message:
          "Acrobat saved the test signature as a graphic and locked the form fields after signing. Placing and verifying that signature using only a keyboard and screen reader has not been established.",
        suggestion:
          "Confirm that a person using a keyboard and screen reader can place and verify the signature, using a signing method accepted by the recipient.",
      },
      {
        code: "form-dating-method",
        severity: "warning",
        pageNumber: 1,
        location: "Part II, Certification: date beside the signature",
        message:
          "Acrobat's Add text tool was unavailable in the tested unsigned form, so adding and verifying the date using a keyboard and screen reader remains unresolved.",
        suggestion:
          "Check that the person completing the form can enter the date in the correct place, hear it with a screen reader and find it after reopening the saved form.",
      },
      {
        code: "form-certification-crossout-method",
        severity: "warning",
        pageNumber: 1,
        location: "Part II, Certification: item 2",
        message:
          "Acrobat's line tools were unavailable and its Comments panel did not allow changes in the tested unsigned form. A keyboard and screen reader method for crossing out item 2 remains unresolved.",
        suggestion:
          "When item 2 needs to be crossed out, check that the person can mark the correct text using a keyboard and identify the change with a screen reader after saving and reopening.",
      },
    ],
    remainingReviewCoverage: [
      ...([
        ["signing", "form-signing-method"],
        ["dating", "form-dating-method"],
        ["certification-crossout", "form-certification-crossout-method"],
      ] as const).map(
        ([action, reviewCode]) => ({
          reviewCode,
          pageNumber: 1,
          action,
          fieldNames: [],
        })
      ),
    ],
  },
];

export interface MatchedNativePdfInteractionTests {
  schemaVersion: 1;
  evidenceId: string;
  testedAt: string;
  environment: string;
  testedPdfSha256: string;
  savedTestCopySha256: string;
  sourceSha256: string;
  matchedCandidateSha256: string;
  interactionFingerprint: { schemaVersion: 1; sha256: string };
  coverage: {
    action: FormInteractionAction;
    fieldIds: string[];
    observation: string;
  }[];
  remainingReviews: NativePdfFinding[];
  remainingReviewCoverage: {
    reviewCode: string;
    pageNumber: number;
    action: FormInteractionAction;
    fieldIds: string[];
  }[];
  scope: "prior-tests-of-matching-form";
  testsRunDuringThisConversion: false;
}

export function getNativePdfInteractionTests(
  state: NativePdfState,
  originalSourceSha256: string
): MatchedNativePdfInteractionTests | undefined {
  const forms = state.inventory.forms;
  if (
    state.sourceSha256 !== originalSourceSha256 ||
    pdfSha256(state.pdf) !== state.candidateSha256 ||
    state.machineChecks.preservationPassed !== true ||
    state.machineChecks.pixelsIdentical !== true ||
    state.machineChecks.inspectionComplete !== true ||
    !objectRecord(forms) ||
    !objectRecord(forms.hybrid) ||
    forms.hybrid.type !== "static-xfa-with-acroform" ||
    forms.hybrid.formLogicPreserved !== true ||
    !objectRecord(forms.hybrid.verification) ||
    forms.hybrid.verification.passed !== true ||
    !objectRecord(forms.interactionFingerprint) ||
    forms.interactionFingerprint.schemaVersion !== 1 ||
    !Array.isArray(forms.fields)
  )
    return;
  const fingerprint = forms.interactionFingerprint.sha256;
  const record = NATIVE_PDF_INTERACTION_TESTS.find(
    (record) =>
      /^[a-f0-9]{64}$/.test(record.interactionFingerprint.sha256) &&
      record.sourceSha256 === originalSourceSha256 &&
      record.interactionFingerprint.sha256 === fingerprint &&
      record.pageCount === state.pageCount &&
      record.fieldCount === forms.field_count &&
      record.fieldCount === forms.widget_count &&
      record.fieldCount === (forms.fields as unknown[]).length
  );
  if (!record) return;
  const fieldIds = new Map<string, string>();
  const seen = new Set<string>();
  for (const field of forms.fields) {
    if (
      !objectRecord(field) ||
      typeof field.name !== "string" ||
      typeof field.fieldId !== "string" ||
      !/^field-[a-f0-9]{64}$/.test(field.fieldId) ||
      fieldIds.has(field.name) ||
      seen.has(field.fieldId)
    )
      return;
    fieldIds.set(field.name, field.fieldId);
    seen.add(field.fieldId);
  }
  if (
    [...record.coverage, ...record.remainingReviewCoverage].some((test) =>
      test.fieldNames.some((name) => !fieldIds.has(name))
    )
  )
    return;
  return {
    schemaVersion: 1,
    evidenceId: record.evidenceId,
    testedAt: record.testedAt,
    environment: record.environment,
    testedPdfSha256: record.testedPdfSha256,
    savedTestCopySha256: record.savedTestCopySha256,
    sourceSha256: originalSourceSha256,
    matchedCandidateSha256: state.candidateSha256,
    interactionFingerprint: { ...record.interactionFingerprint },
    coverage: record.coverage.map((test) => ({
      action: test.action,
      fieldIds: test.fieldNames.map((name) => fieldIds.get(name)!),
      observation: test.observation,
    })),
    remainingReviews: record.remainingReviews.map((finding) => ({
      ...finding,
    })),
    remainingReviewCoverage: record.remainingReviewCoverage.map((review) => ({
      reviewCode: review.reviewCode,
      pageNumber: review.pageNumber,
      action: review.action,
      fieldIds: review.fieldNames.map((name) => fieldIds.get(name)!),
    })),
    scope: "prior-tests-of-matching-form",
    testsRunDuringThisConversion: false,
  };
}

export function nativePdfInteractionSummary(
  tests: MatchedNativePdfInteractionTests
): PdfInteractionTestSummary {
  return {
    evidenceId: tests.evidenceId,
    testedAt: tests.testedAt,
    environment: tests.environment,
    passedChecks: tests.coverage.map((test) => test.observation),
    scopeNote:
      "This PDF's form controls and settings match the previously tested form. The recorded checks apply to the listed actions in the named PDF reader and screen reader; they were not rerun during this conversion." +
      (tests.remainingReviews.length
        ? " Specific remaining interactions are listed below."
        : " Other PDF readers and unlisted actions have not been tested."),
  };
}

export function validFormInteractionReview(
  value: unknown,
  state?: NativePdfState,
  page?: number
): value is FormInteractionReview {
  if (
    !objectRecord(value) ||
    value.basis !== "not-tested" ||
    Object.keys(value).some(
      (key) => !["basis", "action", "fieldIds"].includes(key)
    ) ||
    !FORM_INTERACTION_ACTIONS.includes(value.action as FormInteractionAction) ||
    !Array.isArray(value.fieldIds) ||
    value.fieldIds.length > 200 ||
    new Set(value.fieldIds).size !== value.fieldIds.length ||
    !state ||
    !page
  )
    return false;
  const documentAction = [
    "signing",
    "dating",
    "certification-crossout",
  ].includes(String(value.action));
  if (documentAction) return value.fieldIds.length === 0;
  if (
    !value.fieldIds.length ||
    !objectRecord(state.inventory.forms) ||
    !Array.isArray(state.inventory.forms.fields)
  )
    return false;
  const fields = state.inventory.forms.fields;
  return value.fieldIds.every(
    (id) =>
      typeof id === "string" &&
      /^field-[a-f0-9]{64}$/.test(id) &&
      fields.some(
        (field) =>
          objectRecord(field) &&
          field.fieldId === id &&
          Array.isArray(field.pageNumbers) &&
          field.pageNumbers.includes(page)
      )
  );
}

/** Preserve real defects. Only the reserved, explicitly typed test-request
 * channel can be consolidated; free-text/unknown/mixed findings stay visible.
 * Each suppressed action/field must be covered by a recorded test or by the
 * explicit scope of a remaining review that is still displayed.
 */
export function reconcileNativePdfInteractionFindings(
  workerFindings: NativePdfFinding[],
  modelFindings: NativePdfFinding[],
  state: NativePdfState,
  tests?: MatchedNativePdfInteractionTests
): NativePdfFinding[] {
  const isGeneric = (f: NativePdfFinding) =>
    f.code === "legacy_form_interaction_review" && f.severity === "warning";
  const generic = workerFindings.find(isGeneric);
  const result = workerFindings.filter((f) => !isGeneric(f));
  if (tests) result.push(...tests.remainingReviews);
  else if (generic) result.push(generic);
  const seen = new Set<string>();
  for (const finding of modelFindings) {
    if (
      finding.code !== "form-interaction-review" ||
      finding.severity !== "warning" ||
      !validFormInteractionReview(
        finding.interactionReview,
        state,
        finding.pageNumber
      )
    ) {
      result.push(finding);
      continue;
    }
    const { action, fieldIds } = finding.interactionReview;
    if (tests) {
      const remaining = tests.remainingReviewCoverage.filter(
        (coverage) =>
          coverage.action === action &&
          coverage.pageNumber === finding.pageNumber &&
          tests.remainingReviews.some(
            (review) =>
              review.code === coverage.reviewCode &&
              review.pageNumber === coverage.pageNumber
          )
      );
      if (fieldIds.length) {
        const covered = new Set([
          ...tests.coverage
            .filter((coverage) => coverage.action === action)
            .flatMap((coverage) => coverage.fieldIds),
          ...remaining.flatMap((coverage) => coverage.fieldIds),
        ]);
        if (fieldIds.every((id) => covered.has(id))) continue;
      } else if (remaining.some((coverage) => coverage.fieldIds.length === 0)) {
        continue;
      }
    }
    // The unchanged worker reminder already asks for these field checks.
    if (!tests && generic && fieldIds.length) continue;
    const key = JSON.stringify([
      finding.pageNumber,
      action,
      [...fieldIds].sort(),
    ]);
    if (!seen.has(key)) {
      result.push(finding);
      seen.add(key);
    }
  }
  return result;
}
