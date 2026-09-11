import { describe, expect, it } from "vitest";
import { renderPdfPages } from "../lib/pdf-rendering";
import { taggedPdf, type TaggedFigure } from "./helpers/tagged-pdf";

const upper: TaggedFigure = {
  x: 20,
  y: 120,
  width: 60,
  height: 40,
  alt: 'Three arrows mean “continue”, not "stop".\nRésumé — café → β.',
};
const lower: TaggedFigure = {
  x: 100,
  y: 20,
  width: 80,
  height: 60,
  alt: 'A quoted instruction: "Compare the two groups." Its teaching purpose is hidden in /Alt.',
};

function expectBounds(
  actual: unknown,
  expected: { x: number; y: number; width: number; height: number }
) {
  expect(actual).toEqual(
    expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    })
  );
  const bounds = actual as typeof expected;
  const edges = [
    bounds.x,
    bounds.y,
    bounds.x + bounds.width,
    bounds.y + bounds.height,
  ];
  const expectedEdges = [
    expected.x,
    expected.y,
    expected.x + expected.width,
    expected.y + expected.height,
  ];
  // PDF.js floors minimum edges, ceils maximum edges, then adds one bin when
  // reading the maxima. Check its conservative location against the drawing.
  for (const [index, edge] of edges.entries())
    expect(Math.abs(edge - expectedEdges[index])).toBeLessThanOrEqual(
      (index < 2 ? 1 : 2) / 256 + Number.EPSILON
    );
}

describe("authored PDF figure alternatives from the real renderer", () => {
  it("extracts both exact descriptions, including Unicode and quotes, with normalized top-left bounds", async () => {
    const result = await renderPdfPages(
      await taggedPdf([{ figures: [upper, lower] }])
    );
    const page = result.pages[0];
    expect(page.imageAlternatives.status).toBe("complete");
    expect(
      page.imageAlternatives.figures.map(({ id, alt }) => ({ id, alt }))
    ).toEqual([
      { id: "p1-figure1", alt: upper.alt },
      { id: "p1-figure2", alt: lower.alt },
    ]);
    expectBounds(page.imageAlternatives.figures[0].bounds, {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.2,
    });
    expectBounds(page.imageAlternatives.figures[1].bounds, {
      x: 0.5,
      y: 0.6,
      width: 0.4,
      height: 0.3,
    });
    expect(page.text).not.toContain(upper.alt);
    expect(page.text).not.toContain(lower.alt);
    expect(page.png.length).toBeGreaterThan(24);
  });

  it("does not pair descriptions with graphics by structure order or image-XObject identity", async () => {
    const result = await renderPdfPages(
      await taggedPdf([
        {
          figures: [
            { ...upper, imageKey: "reused" },
            { ...lower, imageKey: "reused" },
          ],
          structureOrder: [1, 0],
        },
      ])
    );
    const alternatives = result.pages[0].imageAlternatives;
    expect(alternatives.status).toBe("complete");
    expect(alternatives.figures).toHaveLength(2);
    const upperFigure = alternatives.figures.find(
      (figure) => figure.alt === upper.alt
    );
    const lowerFigure = alternatives.figures.find(
      (figure) => figure.alt === lower.alt
    );
    expect(upperFigure?.id).not.toBe(lowerFigure?.id);
    expectBounds(upperFigure?.bounds, {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.2,
    });
    expectBounds(lowerFigure?.bounds, {
      x: 0.5,
      y: 0.6,
      width: 0.4,
      height: 0.3,
    });
  });

  it("keeps physical pages and repeated MCIDs distinct when one image is reused across pages", async () => {
    const result = await renderPdfPages(
      await taggedPdf([
        {
          figures: [
            {
              ...upper,
              imageKey: "shared",
              alt: "First physical page description.",
            },
          ],
        },
        {
          figures: [
            {
              ...lower,
              imageKey: "shared",
              alt: "Second physical page description.",
            },
          ],
        },
      ])
    );
    expect(
      result.pages.map((page) => ({
        page: page.pageNumber,
        figures: page.imageAlternatives.figures.map(({ id, alt }) => ({
          id,
          alt,
        })),
      }))
    ).toEqual([
      {
        page: 1,
        figures: [
          { id: "p1-figure1", alt: "First physical page description." },
        ],
      },
      {
        page: 2,
        figures: [
          { id: "p2-figure1", alt: "Second physical page description." },
        ],
      },
    ]);
    expectBounds(result.pages[1].imageAlternatives.figures[0].bounds, {
      x: 0.5,
      y: 0.6,
      width: 0.4,
      height: 0.3,
    });
  });

  it("preserves a tagged vector figure's authored alternative", async () => {
    const result = await renderPdfPages(
      await taggedPdf([
        {
          figures: [
            {
              ...upper,
              kind: "vector",
              alt: "Green rectangle marks the permitted region.",
            },
          ],
        },
      ])
    );
    const alternatives = result.pages[0].imageAlternatives;
    expect(alternatives.status).toBe("complete");
    expect(alternatives.figures).toHaveLength(1);
    expect(alternatives.figures[0].alt).toBe(
      "Green rectangle marks the permitted region."
    );
    expectBounds(alternatives.figures[0].bounds, {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.2,
    });
  });

  it("reports a completed empty inventory for an untagged PDF without manufacturing alternatives", async () => {
    const result = await renderPdfPages(
      await taggedPdf([{ figures: [upper, lower] }], { tagged: false })
    );
    expect(result.pages[0].imageAlternatives).toEqual({
      status: "complete",
      figures: [],
    });
    expect(result.pages[0].png.length).toBeGreaterThan(24);
  });

  it("preserves explicit empty alt while omitting figures with no authored alt", async () => {
    const result = await renderPdfPages(
      await taggedPdf([
        {
          figures: [
            { ...upper, alt: "" },
            { ...lower, alt: undefined },
          ],
        },
      ])
    );
    expect(result.pages[0].imageAlternatives.status).toBe("complete");
    expect(
      result.pages[0].imageAlternatives.figures.map((figure) => figure.alt)
    ).toEqual([""]);
  });

  it("keeps unlocatable authored text without attaching it to another visible figure", async () => {
    const result = await renderPdfPages(
      await taggedPdf([{ figures: [{ ...upper, drawnMcid: 99 }, lower] }])
    );
    const alternatives = result.pages[0].imageAlternatives;
    expect(alternatives.status).toBe("complete");
    const unknown = alternatives.figures.find(
      (figure) => figure.alt === upper.alt
    );
    const located = alternatives.figures.find(
      (figure) => figure.alt === lower.alt
    );
    expect(unknown?.bounds).toBeNull();
    expectBounds(located?.bounds, { x: 0.5, y: 0.6, width: 0.4, height: 0.3 });
  });

  it("leaves duplicate marked-content identifiers unlocated instead of attaching the first image", async () => {
    const result = await renderPdfPages(
      await taggedPdf([{ figures: [upper, { ...lower, drawnMcid: 0 }] }])
    );
    expect(result.pages[0].imageAlternatives).toEqual({
      status: "complete",
      figures: [
        { id: "p1-figure1", alt: upper.alt, bounds: null },
        { id: "p1-figure2", alt: lower.alt, bounds: null },
      ],
    });
  });

  it("enforces the document alternative-text budget across physical pages", async () => {
    const pages = Array.from({ length: 5 }, (_, page) => ({
      figures: Array.from({ length: 4 }, (_, index) => ({
        ...upper,
        alt: `${page}${index}` + "x".repeat(7998),
        imageKey: "shared",
      })),
    }));
    const result = await renderPdfPages(await taggedPdf(pages));
    expect(result.pages).toHaveLength(5);
    expect(
      result.pages
        .slice(0, 4)
        .every(
          (page) =>
            page.imageAlternatives.status === "complete" &&
            page.imageAlternatives.figures.length === 4
        )
    ).toBe(true);
    expect(result.pages[4].imageAlternatives).toEqual({
      status: "unavailable",
      figures: [],
    });
    expect(result.pages.every((page) => page.png.length > 24)).toBe(true);
  });

  it.each([
    ["one excessive description", [{ ...upper, alt: "x".repeat(8001) }]],
    [
      "excessive page text",
      Array.from({ length: 5 }, (_, index) => ({
        ...upper,
        alt: String(index) + "x".repeat(6999),
        imageKey: "shared",
      })),
    ],
    [
      "excessive page figure count",
      Array.from({ length: 101 }, (_, index) => ({
        ...upper,
        alt: `Figure ${index}`,
        imageKey: "shared",
      })),
    ],
  ] as const)(
    "marks metadata unavailable for %s while retaining the rendered page",
    async (_, figures) => {
      const result = await renderPdfPages(
        await taggedPdf([{ figures: [...figures] }])
      );
      expect(result.pages[0].imageAlternatives).toEqual({
        status: "unavailable",
        figures: [],
      });
      expect(result.pages[0].png.length).toBeGreaterThan(24);
    }
  );
});
