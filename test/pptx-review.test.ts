import { describe, expect, it } from "vitest";
import {
  buildPowerPointReview,
  resolvePowerPointReviews,
  type PowerPointReviewConcern,
} from "../lib/pptx-review";
import type {
  PptxFinding,
  PptxInspection,
  PptxObject,
} from "../lib/pptx-types";

function object(
  id: string,
  kind: PptxObject["kind"],
  description = ""
): PptxObject {
  return {
    id,
    name: `${kind} ${id}`,
    kind,
    text: "",
    description,
    title: "",
    decorative: false,
    isTitle: false,
    hidden: false,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    grouped: false,
    parentId: null,
    language: null,
  };
}

function inspection(): PptxInspection {
  return {
    slideCount: 1,
    width: 1000,
    height: 750,
    findings: [],
    slides: [
      {
        slideNumber: 1,
        partName: "ppt/slides/slide1.xml",
        hidden: false,
        hasTiming: false,
        hasExternalContent: false,
        objects: [
          object("chart", "chart", "Enrollment grows from 10 to 20 students."),
          object(
            "diagram",
            "smartart",
            "Plan, prepare, and deliver in that order."
          ),
          object("group", "group"),
          object("table", "table"),
          object("media", "media", "A narrated demonstration."),
          object("opaque", "unsupported", "An embedded object."),
          object("image", "image"),
        ],
      },
    ],
  };
}

function finding(code: string, extra: Partial<PptxFinding> = {}): PptxFinding {
  return {
    code,
    severity: "warning",
    slideNumber: 1,
    objectId: "chart",
    message: `Check ${code}.`,
    suggestion: `Review the ${code} on this slide.`,
    ...extra,
  };
}

const resolved = (
  id = "review-1",
  reason = "The actual output has accurate labels and reading order."
) => ({
  id,
  status: "resolved",
  reason,
});

function concerns(): PowerPointReviewConcern[] {
  return buildPowerPointReview(
    inspection(),
    [finding("complex-object-review")],
    [],
    []
  ).concerns;
}

describe("buildPowerPointReview", () => {
  it("requires an explicit decision before clearing a described static chart", () => {
    const original = finding("complex-object-review");
    const review = buildPowerPointReview(inspection(), [original], [], []);
    expect(review).toEqual({
      fixed: [],
      concerns: [{ id: "review-1", finding: original }],
    });
    expect(resolvePowerPointReviews([], review.concerns)).toBeNull();
    expect(resolvePowerPointReviews([resolved()], review.concerns)).toEqual([]);
  });

  it("allows explicit review of a static SmartArt description and a known group's order", () => {
    const findings = [
      finding("complex-object-review", { objectId: "diagram" }),
      finding("group-review", { objectId: "group" }),
    ];
    const review = buildPowerPointReview(inspection(), findings, [], []);
    expect(review.fixed).toEqual([]);
    expect(review.concerns).toEqual([
      { id: "review-1", finding: findings[0] },
      { id: "review-2", finding: findings[1] },
    ]);
  });

  it("uses a nonempty authored title as description evidence without treating it as approval", () => {
    const output = inspection();
    output.slides[0].objects[0].description = "  ";
    output.slides[0].objects[0].title =
      "Enrollment doubles from 10 to 20 students.";
    expect(
      buildPowerPointReview(output, [finding("complex-object-review")], [], [])
        .concerns
    ).toHaveLength(1);
  });

  it("keeps a missing description and its generic object check outside audit resolution", () => {
    const output = inspection();
    output.slides[0].objects[0].description = "  ";
    const findings = [
      finding("complex-object-review"),
      finding("missing-description", { severity: "error" }),
    ];
    expect(buildPowerPointReview(output, findings, [], [])).toEqual({
      fixed: findings,
      concerns: [],
    });
  });

  it.each([
    finding("complex-object-review"),
    finding("group-review", { objectId: "group" }),
  ])("keeps animated-object coverage fixed for $code", (original) => {
    const output = inspection();
    output.slides[0].hasTiming = true;
    expect(buildPowerPointReview(output, [original], [], [])).toEqual({
      fixed: [original],
      concerns: [],
    });
  });

  it.each(["image", "chart", "smartart"] as const)(
    "requires an explicit audit decision on a preserved authored description for a visible static %s",
    (kind) => {
      const output = inspection();
      const target = output.slides[0].objects[0];
      target.kind = kind;
      const original = finding("authored-description-preserved");
      const review = buildPowerPointReview(output, [original], [], []);
      expect(review).toEqual({
        fixed: [],
        concerns: [{ id: "review-1", finding: original }],
      });
      expect(resolvePowerPointReviews([], review.concerns)).toBeNull();
      expect(resolvePowerPointReviews([resolved()], review.concerns)).toEqual(
        []
      );
    }
  );

  it("accepts a preserved authored title for review while retaining a separate hard defect", () => {
    const output = inspection();
    output.slides[0].objects[0].description = " ";
    output.slides[0].objects[0].title =
      "Enrollment doubles from 10 to 20 students.";
    const original = finding("authored-description-preserved");
    const defect = finding("missing-description", {
      severity: "error",
      objectId: "image",
    });
    const review = buildPowerPointReview(output, [original, defect], [], []);
    expect(review.fixed).toEqual([defect]);
    expect(review.concerns).toEqual([{ id: "review-1", finding: original }]);
  });

  it.each<Partial<PptxObject>>([
    { hidden: true },
    { rect: null },
    { rect: { x: 0, y: 0, width: 0, height: 100 } },
    { rect: { x: 0, y: 0, width: 100, height: -1 } },
    { rect: { x: Number.NaN, y: 0, width: 100, height: 100 } },
    { rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 } },
    { grouped: true, parentId: "group" },
    { parentId: "not-present" },
    { description: " \n ", title: " " },
    { description: "", title: "", decorative: true },
    { kind: "media" },
    { kind: "unsupported" },
    { kind: "shape" },
    { kind: "text" },
  ])(
    "protects authored descriptions when the visible object cannot be assessed: %j",
    (patch) => {
      const output = inspection();
      Object.assign(output.slides[0].objects[0], patch);
      const original = finding("authored-description-preserved");
      expect(buildPowerPointReview(output, [original], [], [])).toEqual({
        fixed: [original],
        concerns: [],
      });
    }
  );

  it.each(["authored-description-preserved", "complex-object-review"])(
    "protects %s when slide timing prevents assessing a static preview",
    (code) => {
      const output = inspection();
      output.slides[0].hasTiming = true;
      const original = finding(code);
      expect(buildPowerPointReview(output, [original], [], [])).toEqual({
        fixed: [original],
        concerns: [],
      });
    }
  );

  it.each(["authored-description-preserved", "complex-object-review"])(
    "allows explicit assessment of %s on a rendered hidden slide while preserving its coverage warning",
    (code) => {
      const output = inspection();
      output.slides[0].hidden = true;
      const coverage = finding("hidden-slide", { objectId: undefined });
      const original = finding(code);
      expect(
        buildPowerPointReview(output, [coverage, original], [], [])
      ).toEqual({
        fixed: [coverage],
        concerns: [{ id: "review-1", finding: original }],
      });
    }
  );

  it.each<Partial<PptxObject>>([
    { hidden: true },
    { rect: null },
    { rect: { x: 0, y: 0, width: 0, height: 100 } },
    { rect: { x: Number.NaN, y: 0, width: 100, height: 100 } },
    { grouped: true, parentId: "group" },
    { parentId: "not-present" },
  ])(
    "protects chart and SmartArt reviews when their visible identity cannot be assessed: %j",
    (patch) => {
      for (const kind of ["chart", "smartart"] as const) {
        const output = inspection();
        Object.assign(output.slides[0].objects[0], { kind, ...patch });
        const original = finding("complex-object-review");
        expect(buildPowerPointReview(output, [original], [], [])).toEqual({
          fixed: [original],
          concerns: [],
        });
      }
    }
  );

  it("protects a hidden group's order because its objects are absent from the preview", () => {
    const output = inspection();
    output.slides[0].objects.find((item) => item.id === "group")!.hidden = true;
    const original = finding("group-review", { objectId: "group" });
    expect(buildPowerPointReview(output, [original], [], [])).toEqual({
      fixed: [original],
      concerns: [],
    });
  });

  it.each([
    { objectId: "not-present" },
    { slideNumber: 2 },
    { severity: "error" as const },
  ])("protects unknown or error authored-description findings: %j", (patch) => {
    const original = finding("authored-description-preserved", patch);
    expect(buildPowerPointReview(inspection(), [original], [], [])).toEqual({
      fixed: [original],
      concerns: [],
    });
  });

  it.each([
    finding("complex-table-review", { objectId: "table" }),
    finding("complex-object-review", { objectId: "media" }),
    finding("complex-object-review", { objectId: "opaque" }),
    finding("complex-object-review", { objectId: "image" }),
    finding("external-content", {
      slideNumber: undefined,
      objectId: undefined,
    }),
    finding("embedded-object", { slideNumber: undefined, objectId: undefined }),
    finding("unsupported-object", { objectId: undefined }),
    finding("hidden-slide", { objectId: undefined }),
    finding("hidden-object", { objectId: undefined }),
    finding("duplicate-title", { objectId: undefined }),
    finding("unexpected-engine-warning"),
    finding("group-review", { objectId: "table" }),
    finding("complex-object-review", { severity: "error" }),
    finding("group-review", { objectId: "group", severity: "error" }),
  ])("protects output/coverage finding $code at $objectId", (original) => {
    expect(buildPowerPointReview(inspection(), [original], [], [])).toEqual({
      fixed: [original],
      concerns: [],
    });
  });

  it("can resolve a source table concern after repair while retaining an actual output defect", () => {
    const stale = finding("missing-table-headers", {
      objectId: "table",
      severity: "error",
      message: "The source has no column labels.",
    });
    const actual = finding("missing-description", {
      objectId: "image",
      severity: "error",
    });
    const review = buildPowerPointReview(inspection(), [actual], [stale], []);
    expect(review.fixed).toEqual([actual]);
    expect(review.concerns).toEqual([{ id: "review-1", finding: stale }]);
    const remaining = resolvePowerPointReviews(
      [
        resolved(
          "review-1",
          "The repaired table has the correct Pair and Discussion task headers."
        ),
      ],
      review.concerns
    );
    expect([...review.fixed, ...remaining!]).toEqual([actual]);
  });

  it("does not let a proposed finding make the same deterministic output defect resolvable", () => {
    const actual = finding("missing-table-headers", {
      objectId: "table",
      severity: "error",
    });
    expect(
      buildPowerPointReview(inspection(), [actual], [{ ...actual }], [])
    ).toEqual({ fixed: [actual], concerns: [] });
  });

  it("always protects reverted operations, even when another source proposes the same concern", () => {
    const reverted = finding("group-review", { objectId: "group" });
    const skipped = finding("visual-change-skipped", { objectId: undefined });
    expect(
      buildPowerPointReview(
        inspection(),
        [reverted],
        [reverted],
        [reverted, skipped]
      )
    ).toEqual({ fixed: [reverted, skipped], concerns: [] });
  });

  it("deduplicates exact findings without collapsing distinct claims at one object", () => {
    const first = finding("complex-object-review");
    const second = {
      ...first,
      message: "Check whether the chart omits an important relationship.",
    };
    const review = buildPowerPointReview(
      inspection(),
      [first, { ...first }],
      [first, second, second],
      []
    );
    expect(review.concerns).toEqual([
      { id: "review-1", finding: first },
      { id: "review-2", finding: second },
    ]);
  });

  it.each([
    { slideNumber: 2, objectId: "chart" },
    { slideNumber: 1, objectId: "not-present" },
    { slideNumber: undefined, objectId: "chart" },
    { slideNumber: 1.5, objectId: undefined },
  ])(
    "protects unknown locations in both engine and proposed findings: %j",
    (location) => {
      const original = finding("complex-object-review", location);
      expect(
        buildPowerPointReview(inspection(), [original], [original], [])
      ).toEqual({ fixed: [original], concerns: [] });
    }
  );

  it("allows slide-wide and document-wide source concerns without fabricating an object", () => {
    const proposed = [
      finding("source-contrast", { objectId: undefined }),
      finding("source-language", {
        slideNumber: undefined,
        objectId: undefined,
      }),
    ];
    expect(
      buildPowerPointReview(inspection(), [], proposed, []).concerns.map(
        (item) => item.finding
      )
    ).toEqual(proposed);
  });

  it("never adds a blanket manual-review finding", () => {
    expect(buildPowerPointReview(inspection(), [], [], [])).toEqual({
      fixed: [],
      concerns: [],
    });
  });

  it("copies finding records and leaves every input unchanged", () => {
    const output = inspection();
    const engine = [
      finding("complex-object-review"),
      finding("missing-description", { severity: "error", objectId: "image" }),
    ];
    const proposed = [finding("source-contrast", { objectId: "table" })];
    const reverted = [
      finding("visual-change-skipped", { objectId: undefined }),
    ];
    const before = structuredClone({ output, engine, proposed, reverted });
    const review = buildPowerPointReview(output, engine, proposed, reverted);
    review.fixed[0].message = "Changed copy";
    review.concerns[0].finding.suggestion = "Changed copy";
    expect({ output, engine, proposed, reverted }).toEqual(before);
  });
});

describe("resolvePowerPointReviews", () => {
  it("retains original identity and location while using the audit's faculty wording and severity", () => {
    const input = concerns();
    const result = resolvePowerPointReviews(
      [
        {
          id: "review-1",
          status: "needs_fix",
          message: "  The chart description reverses the trend.  ",
          suggestion: "  Describe the increase from 10 to 20 students.  ",
        },
      ],
      input
    );
    expect(result).toEqual([
      {
        ...input[0].finding,
        severity: "error",
        message: "The chart description reverses the trend.",
        suggestion: "Describe the increase from 10 to 20 students.",
      },
    ]);
  });

  it("returns unresolved findings in original concern order and leaves inputs unchanged", () => {
    const input = buildPowerPointReview(
      inspection(),
      [],
      [
        finding("first", { severity: "error" }),
        finding("second", { objectId: "table" }),
        finding("third", { objectId: undefined }),
      ],
      []
    ).concerns;
    const decisions = [
      {
        id: "review-3",
        status: "needs_fix",
        message: "Third remains.",
        suggestion: "Fix the third item.",
      },
      resolved("review-2"),
      {
        id: "review-1",
        status: "needs_review",
        message: "First needs a decision.",
        suggestion: "Decide whether this is the intended meaning.",
      },
    ];
    const before = structuredClone({ input, decisions });
    const result = resolvePowerPointReviews(decisions, input)!;
    expect(result.map((item) => [item.code, item.severity])).toEqual([
      ["first", "warning"],
      ["third", "error"],
    ]);
    result[0].message = "Changed returned record";
    expect({ input, decisions }).toEqual(before);
  });

  it("accepts only an empty array when there are no concerns", () => {
    expect(resolvePowerPointReviews([], [])).toEqual([]);
    for (const value of [undefined, null, {}, "[]", [resolved()]]) {
      expect(resolvePowerPointReviews(value, [])).toBeNull();
    }
  });

  it.each([
    undefined,
    null,
    {},
    "[]",
    [],
    [null],
    [[]],
    [
      {
        status: "resolved",
        reason: "The output has the right labels and order.",
      },
    ],
    [resolved("unknown")],
    [resolved(" review-1 ")],
    [{ ...resolved(), id: 1 }],
    [{ ...resolved(), status: "approved" }],
    [{ ...resolved(), reason: undefined }],
    [{ ...resolved(), reason: 123 }],
    [resolved("review-1", " ")],
    [resolved("review-1", "x".repeat(19))],
    [resolved("review-1", "x".repeat(1201))],
    [{ ...resolved(), extra: true }],
    [{ ...resolved(), message: "This additional key is forbidden." }],
    [
      {
        id: "review-1",
        status: "needs_review",
        message: "A question remains.",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_fix",
        message: "",
        suggestion: "Fix it.",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_fix",
        message: "Fix this.",
        suggestion: " \n ",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_review",
        message: "x".repeat(2001),
        suggestion: "Check it.",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_review",
        message: "Check this.",
        suggestion: "x".repeat(2001),
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_review",
        message: 123,
        suggestion: "Check it.",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_fix",
        message: "Fix it.",
        suggestion: "Check it.",
        severity: "warning",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_fix",
        message: "Fix it.",
        suggestion: "Check it.",
        objectId: "table",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_fix",
        message: "Fix it.",
        suggestion: "Check it.",
        slideNumber: 2,
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_fix",
        message: "Fix it.",
        suggestion: "Check it.",
        code: "different-code",
      },
    ],
    [
      {
        id: "review-1",
        status: "needs_fix",
        message: "Fix it.",
        suggestion: "Check it.",
        reason: "Extra field is forbidden.",
      },
    ],
  ])("rejects malformed or incomplete review array %#", (value) => {
    expect(resolvePowerPointReviews(value, concerns())).toBeNull();
  });

  it("rejects duplicate IDs even when their array length matches the concern count", () => {
    const input = buildPowerPointReview(
      inspection(),
      [],
      [finding("first"), finding("second")],
      []
    ).concerns;
    expect(
      resolvePowerPointReviews([resolved(), resolved()], input)
    ).toBeNull();
    expect(resolvePowerPointReviews([resolved()], input)).toBeNull();
    expect(
      resolvePowerPointReviews([resolved(), resolved("unknown")], input)
    ).toBeNull();
  });

  it("rejects invalid internal concern identifiers instead of silently losing concerns", () => {
    const [first] = concerns();
    expect(
      resolvePowerPointReviews([resolved(), resolved()], [first, first])
    ).toBeNull();
    expect(
      resolvePowerPointReviews([resolved(" ")], [{ ...first, id: " " }])
    ).toBeNull();
  });

  it.each([20, 1200])(
    "accepts a resolved reason at the exact %i-character boundary",
    (length) => {
      expect(
        resolvePowerPointReviews(
          [resolved("review-1", `  ${"x".repeat(length)}  `)],
          concerns()
        )
      ).toEqual([]);
    }
  );

  it.each([1, 2000])(
    "accepts unresolved faculty text at the exact %i-character boundary",
    (length) => {
      const text = "x".repeat(length);
      expect(
        resolvePowerPointReviews(
          [
            {
              id: "review-1",
              status: "needs_review",
              message: text,
              suggestion: text,
            },
          ],
          concerns()
        )
      ).toHaveLength(1);
    }
  );
});
