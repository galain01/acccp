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
