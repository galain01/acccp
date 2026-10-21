import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import type { DocxInspection, DocxRepairResult } from "../lib/docx-types";
import type { PdfTextRegion, RenderedPdf } from "../lib/pdf-rendering";
import {
  matchWordTextRegion,
  verifyWordLayout,
} from "../lib/word-layout-verification";

const region = (
  text: string,
  x: number,
  y: number,
  width = 40,
  height = 10
): PdfTextRegion => ({ text, x, y, width, height });
function pages(
  regions: PdfTextRegion[],
  changes: [number, number][] = [],
  border = true
): RenderedPdf {
  const canvas = createCanvas(1000, 1000);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = "black";
  if (border) ctx.fillRect(50, 139, 340, 1);
  for (const [x, y] of changes) ctx.fillRect(x, y, 2, 2);
  return {
    pageCount: 1,
    pages: [
      {
        pageNumber: 1,
        width: 1000,
        height: 1000,
        png: canvas.toBuffer("image/png"),
        text: regions.map((r) => r.text).join(" "),
        textRegions: regions,
        imageAlternatives: { status: "complete", figures: [] },
      },
    ],
  };
}
const cells = [
  ["Homework", "Exams"],
  ["", "1", "Final"],
  ["15%", "35%", "50%"],
];
const table = {
  id: "t1",
  partName: "word/document.xml",
  index: 1,
  location: "Table 1",
  cells,
  firstRowHeader: false,
  complex: true,
  editable: true,
  headerCandidate: {
    headerRows: 2 as const,
    labels: ["Homework", "Exams 1", "Exams Final"],
    sourceCells: cells,
    headerParagraphIds: ["p1", "p2", "p3", "p4"],
    gridWidthsTwips: [2000, 2000, 2000],
    headerHeightsTwips: [null, null],
    indentTwips: null,
    alignment: "center",
  },
};
const source: DocxInspection = {
  paragraphs: [],
  images: [],
  findings: [],
  tables: [table],
};
const repaired: DocxRepairResult = {
  buffer: Buffer.from("saved"),
  inspection: {
    ...source,
    tables: [
      {
        ...table,
        cells: [["Homework", "Exams\n1", "Exams\nFinal"], cells[2]],
        firstRowHeader: true,
        complex: false,
        headerCandidate: undefined,
      },
    ],
  },
  changes: [
    {
      type: "simplifyTableHeaders",
      id: "t1",
      location: "Table 1",
      message: "Header repaired",
      before: "merged",
      after: "individual",
      paragraphIds: table.headerCandidate.headerParagraphIds,
    },
  ],
  findings: [],
};
const original = [
  region("Homework", 100, 100, 60),
  region("Exams", 200, 100),
  region("1", 200, 120),
  region("Final", 300, 120),
  region("15%", 100, 140),
  region("35%", 200, 140),
  region("50%", 300, 140),
  region("Neighbor paragraph", 100, 180, 200),
];
const saved = [
  region("Homework", 100, 100, 60),
  region("Exams", 200, 100),
  region("Exams", 300, 100),
  region("1", 200, 120),
  region("Final", 300, 120),
  ...original.slice(4),
];

const listWords = [
  "First course objective",
  "Second course objective",
  "Third course objective",
];
const listSource: DocxInspection = {
  tables: [],
  images: [],
  findings: [],
  paragraphs: listWords.map((text, index) => ({
    id: `p${index + 1}`,
    partName: "word/document.xml",
    index: index + 1,
    location: `Paragraph ${index + 1}`,
    text: `● ${text}`,
    styleId: null,
    styleName: null,
    headingLevel: null,
    language: "en-US",
    inTable: false,
    editable: true,
    list: null,
    formatting: { bold: false, fontSizePt: 11 },
  })),
  listCandidates: [
    {
      id: "p1",
      paragraphIds: ["p1", "p2", "p3"],
      sourceTexts: listWords.map((text) => `● ${text}`),
      prefixes: ["● ", "● ", "● "],
      kind: "bullet",
      marker: "●",
      start: null,
    },
  ],
};
const listOutput: DocxRepairResult = {
  buffer: Buffer.from("native list"),
  findings: [],
  inspection: {
    ...listSource,
    paragraphs: listSource.paragraphs.map((p, index) => ({
      ...p,
      text: listWords[index],
      list: { numId: "1", level: 0, format: "bullet", markerText: "●" },
    })),
    listCandidates: [],
  },
  changes: [
    {
      type: "convertTypedList",
      id: "p1",
      paragraphIds: ["p1", "p2", "p3"],
      location: "Course objectives",
      message: "Converted to native list.",
      before: "Typed markers",
      after: "Native markers",
    },
  ],
};
const listRegions = listWords.flatMap((text, index) => [
  region("●", 100, 100 + index * 32.4, 15, 35),
  region(text, 125, 100 + index * 32.4, 300, 35),
]);

describe("hosted native list marker verification", () => {
  it("allows native-marker font differences while conservative boxes overlap adjacent list lines", async () => {
    expect(
      await verifyWordLayout(
        pages(listRegions, [], false),
        pages(
          listRegions,
          [
            [105, 110],
            [105, 142],
            [105, 175],
          ],
          false
        ),
        listSource,
        listOutput
      )
    ).toBe(true);
  });
  it("keeps every item-body pixel protected", async () => {
    expect(
      await verifyWordLayout(
        pages(listRegions, [], false),
        pages(
          listRegions,
          [
            [105, 110],
            [150, 110],
          ],
          false
        ),
        listSource,
        listOutput
      )
    ).toBe(false);
  });
  it("rejects unrelated neighboring text even when its box overlaps the marker strip", async () => {
    const withNeighbor = [...listRegions, region("Aside", 100, 95, 18, 10)];
    expect(
      await verifyWordLayout(
        pages(withNeighbor, [], false),
        pages(withNeighbor, [[103, 100]], false),
        listSource,
        listOutput
      )
    ).toBe(false);
  });
  it("checks both marker rectangles against both renders before permitting their union", async () => {
    const original = [...listRegions, region("Aside", 80, 110, 12, 10)];
    const shifted = listRegions.map((item, index) =>
      index === 0 ? { ...item, x: 80 } : item
    );
    shifted.push(region("Aside", 100, 110, 12, 10));
    expect(
      await verifyWordLayout(
        pages(original, [], false),
        pages(
          shifted,
          [
            [82, 110],
            [102, 110],
          ],
          false
        ),
        listSource,
        listOutput
      )
    ).toBe(false);
  });
  it("rejects ambiguous body matching and changed item-body positions", async () => {
    const ambiguous = [...listRegions, region(listWords[0], 500, 500, 300, 35)];
    expect(
      await verifyWordLayout(
        pages(ambiguous, [], false),
        pages(ambiguous, [[105, 110]], false),
        listSource,
        listOutput
      )
    ).toBe(false);
    const moved = listRegions.map((item, index) =>
      index === 1 ? { ...item, x: item.x + 1 } : item
    );
    expect(
      await verifyWordLayout(
        pages(listRegions, [], false),
        pages(moved, [[105, 110]], false),
        listSource,
        listOutput
      )
    ).toBe(false);
  });
  it("withholds marker changes when prefix and body share one indivisible PDF item", async () => {
    const combined = listWords.map((text, index) =>
      region(`● ${text}`, 100, 100 + index * 32.4, 325, 35)
    );
    expect(
      await verifyWordLayout(
        pages(combined, [], false),
        pages(combined, [[105, 110]], false),
        listSource,
        listOutput
      )
    ).toBe(false);
  });
  it("does not extend a marker mask down the left edge of wrapped item text", async () => {
    const wrapped = listRegions.map((item, index) =>
      index >= 2 ? { ...item, y: item.y + 200 } : item
    );
    wrapped[1] = { ...wrapped[1], height: 75 };
    expect(
      await verifyWordLayout(
        pages(wrapped, [], false),
        pages(wrapped, [[105, 140]], false),
        listSource,
        listOutput
      )
    ).toBe(false);
  });
});

describe("bounded native Word structural layout verification", () => {
  it("accepts derived headers in row-wise PDF order and only their local visual changes", async () => {
    expect(
      await verifyWordLayout(
        pages(original),
        pages(saved, [[250, 105]]),
        source,
        repaired
      )
    ).toBe(true);
  });
  it("rejects even a tiny change outside the measured table", async () => {
    expect(
      await verifyWordLayout(
        pages(original),
        pages(saved, [
          [250, 105],
          [500, 500],
        ]),
        source,
        repaired
      )
    ).toBe(false);
  });
  it("keeps original data-row pixels protected even inside the measured table", async () => {
    expect(
      await verifyWordLayout(
        pages(original),
        pages(saved, [
          [250, 105],
          [110, 144],
        ]),
        source,
        repaired
      )
    ).toBe(false);
  });
  it("withholds structural table changes when the data-row boundary cannot be measured", async () => {
    expect(
      await verifyWordLayout(
        pages(original, [], false),
        pages(saved, [[250, 105]], false),
        source,
        repaired
      )
    ).toBe(false);
  });
  it("rejects table movement, altered data, missing labels and changed page dimensions", async () => {
    const moved = saved.map((r) =>
      r.text.endsWith("%") ? { ...r, y: r.y + 3 } : r
    );
    expect(
      await verifyWordLayout(pages(original), pages(moved), source, repaired)
    ).toBe(false);
    const dataChanged = structuredClone(repaired);
    dataChanged.inspection.tables[0].cells[1][0] = "99%";
    expect(
      await verifyWordLayout(pages(original), pages(saved), source, dataChanged)
    ).toBe(false);
    expect(
      await verifyWordLayout(
        pages(original),
        pages(saved.filter((r) => r.text !== "Final")),
        source,
        repaired
      )
    ).toBe(false);
    const different = pages(saved);
    different.pages[0].width = 999;
    expect(
      await verifyWordLayout(pages(original), different, source, repaired)
    ).toBe(false);
  });
  it("refuses to absorb an unrelated text box into the table's expanded margin", async () => {
    const neighbor = region("Unrelated", 55, 105, 40);
    expect(
      await verifyWordLayout(
        pages([...original, neighbor]),
        pages([...saved, neighbor], [[65, 106]]),
        source,
        repaired
      )
    ).toBe(false);
  });
  it("never relaxes checks for a no-op or a merely proposed operation", async () => {
    expect(
      await verifyWordLayout(
        pages(original),
        pages(saved, [[250, 105]]),
        source,
        { ...repaired, changes: [] }
      )
    ).toBe(false);
    expect(
      await verifyWordLayout(
        pages(original),
        pages(saved, [[250, 105]]),
        source,
        {
          ...repaired,
          changes: repaired.changes.map((c) => ({ ...c, after: c.before })),
        }
      )
    ).toBe(false);
  });
  it("requires unique complete text items and complete geometry coverage", () => {
    expect(
      matchWordTextRegion(
        pages([region("Full paragraph", 10, 10)]),
        "paragraph"
      )
    ).toBeNull();
    expect(
      matchWordTextRegion(
        pages([region("Repeated", 10, 10), region("Repeated", 10, 30)]),
        "Repeated"
      )
    ).toBeNull();
    const incomplete = pages([region("Heading", 10, 10)]);
    incomplete.pages.push({
      ...incomplete.pages[0],
      pageNumber: 2,
      textRegions: null,
    });
    incomplete.pageCount = 2;
    expect(matchWordTextRegion(incomplete, "Heading")).toBeNull();
  });
});
