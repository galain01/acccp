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
const entered = [name, ...[11, 12, 13, 14, 15].map(segment)];
const untestedChoices = [2, 3, 4, 5, 6].map(choice);
const line3b = prefix + "Boxes3a-b_ReadOrder[0].c1_2[0]";
const unenteredText = [
  business,
  prefix + "Boxes3a-b_ReadOrder[0].f1_03[0]",
  prefix + "Boxes3a-b_ReadOrder[0].f1_04[0]",
  prefix + "f1_05[0]",
  prefix + "f1_06[0]",
  prefix + "Address_ReadOrder[0].f1_07[0]",
  prefix + "Address_ReadOrder[0].f1_08[0]",
  prefix + "f1_09[0]",
  prefix + "f1_10[0]",
];
const remainingControls = "form-remaining-controls";

/** Reviewed application evidence, not a ledger supplied by a PDF or a model.
 * See docs/pdf-form-interaction-evidence.md before adding or broadening a record.
 * Raw test logs, entered values and personal document contents stay out of Git.
 */
export const NATIVE_PDF_INTERACTION_TESTS: readonly InteractionTestRecord[] = [
  {
    schemaVersion: 1,
    evidenceId: "w9-2024-acrobat-nvda-2026-10-22-v1",
    sourceSha256:
      "2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53",
    testedPdfSha256:
      "7a7b66d35e57fe29513880b3e2c6775099a610b6d7beb24c5b31f74cbffa58f7",
    savedTestCopySha256:
      "56c07bb2bce1d21a9fdb95c50c341c7c530acdca7a67530ed5bb95f8d6e9d56c",
    interactionFingerprint: {
      schemaVersion: 1,
      sha256:
        "d07869c8d2186e5d545b4ec8adfc2b777c022c141643bd9140c1031d79837ced",
    },
    testedAt: "2026-10-22",
    environment: "Adobe Acrobat 64-bit on Windows with NVDA 2026.2",
    pageCount: 6,
    fieldCount: 23,
    coverage: [
      {
        action: "field-announcement",
        fieldNames: [
          name,
          choice(0),
          choice(1),
          segment(12),
          segment(13),
          segment(15),
        ],
        observation:
          "Heard the required-name instructions, the first two classification choices, and the improved SSN middle/last and EIN last-segment descriptions.",
      },
      {
        action: "keyboard-navigation",
        fieldNames: [name, business, choice(0), choice(1)],
        observation:
          "Moved by keyboard through the name, business name and first two classification choices.",
      },
      {
        action: "checkbox-operation",
        fieldNames: [choice(0), choice(1)],
        observation:
          "Used Space to select Individual/sole proprietor, then C corporation; the first choice cleared.",
      },
      {
        action: "text-entry",
        fieldNames: entered,
        observation:
          "Entered fictional data in the name and all five SSN/EIN segments.",
      },
      {
        action: "save-reopen",
        fieldNames: [...entered, choice(1)],
        observation:
          "Saved, closed and reopened the test copy; the entered values persisted and the SSN middle segment's label and value were announced.",
      },
    ],
    remainingReviews: [
      {
        code: remainingControls,
        severity: "warning",
        pageNumber: 1,
        location: "Lines 2–7 and the first SSN/EIN segments",
        message:
          "The previous Acrobat/NVDA tests covered selected controls. The other classification choices (S corporation, Partnership, Trust/estate, LLC and Other), line 3b, and the remaining text fields have not been exercised individually. The first SSN/EIN segments accepted and saved text, but their full spoken descriptions were not recorded.",
        suggestion:
          "For business name, check its spoken description, text entry, and saving; keyboard navigation to it already passed. Check announcements and keyboard operation for the other classification choices, line 3b, LLC/Other details, exemption codes, address, requester and account fields. Check keyboard navigation through all SSN/EIN segments and the first segments' announcements. Use fictional values to check saving and reopening the untouched fields and a selected Individual/sole proprietor choice.",
      },
      {
        code: "form-certification-method",
        severity: "warning",
        pageNumber: 1,
        location: "Part II, Certification: signature, date and item 2",
        message:
          "The previous tests did not cover signing, adding the date, or crossing out certification item 2 when applicable. These actions may use PDF-reader tools rather than fillable fields.",
        suggestion:
          "Confirm that the accepted way to complete those actions works with a keyboard and screen reader. Do not substitute a typed name for a signature without confirming the recipient accepts it.",
      },
    ],
    remainingReviewCoverage: [
      {
        reviewCode: remainingControls,
        pageNumber: 1,
        action: "field-announcement",
        fieldNames: [
          ...unenteredText,
          ...untestedChoices,
          line3b,
          segment(11),
          segment(14),
        ],
      },
      {
        reviewCode: remainingControls,
        pageNumber: 1,
        action: "keyboard-navigation",
        fieldNames: [
          ...unenteredText.filter((field) => field !== business),
          ...untestedChoices,
          line3b,
          ...[11, 12, 13, 14, 15].map(segment),
        ],
      },
      {
        reviewCode: remainingControls,
        pageNumber: 1,
        action: "checkbox-operation",
        fieldNames: [...untestedChoices, line3b],
      },
      {
        reviewCode: remainingControls,
        pageNumber: 1,
        action: "text-entry",
        fieldNames: unenteredText,
      },
      {
        reviewCode: remainingControls,
        pageNumber: 1,
        action: "save-reopen",
        fieldNames: [...unenteredText, choice(0), ...untestedChoices, line3b],
      },
      ...(["signing", "dating", "certification-crossout"] as const).map(
        (action) => ({
          reviewCode: "form-certification-method",
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
      "This PDF's form controls and settings match the previously tested form. These checks were not rerun during this conversion and do not cover every control or other PDF readers. Specific remaining checks are listed below.",
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
