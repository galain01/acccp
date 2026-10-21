import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { DocxInspection, DocxRepairResult } from "./docx-types";
import type {
  PdfTextRegion,
  RenderedPdf,
  RenderedPdfPage,
} from "./pdf-rendering";

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface LocatedRegion {
  pageNumber: number;
  region: Region;
}
interface LocatedText extends LocatedRegion {
  items: PdfTextRegion[];
}
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[\uF0B7\u2022\u25CF]/gu, "•")
    .replace(/\s+/gu, "");
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Require a unique exact text sequence and complete boundary items, not a model box. */
function matchWordText(
  rendered: RenderedPdf,
  text: string
): LocatedText | null {
  const needle = normalized(text);
  if (!needle) return null;
  const matches: LocatedText[] = [];
  for (const page of rendered.pages) {
    if (!page.textRegions) return null;
    const entries: { item: PdfTextRegion; start: number; end: number }[] = [];
    let joined = "";
    for (const item of page.textRegions) {
      const start = joined.length;
      joined += normalized(item.text);
      entries.push({ item, start, end: joined.length });
    }
    const start = joined.indexOf(needle);
    if (start < 0) continue;
    if (joined.indexOf(needle, start + 1) >= 0) return null;
    const end = start + needle.length;
    const selected = entries.filter(
      (entry) => entry.end > start && entry.start < end
    );
    if (
      !selected.length ||
      selected[0].start !== start ||
      selected.at(-1)!.end !== end
    )
      return null;
    const x = Math.min(...selected.map(({ item }) => item.x));
    const y = Math.min(...selected.map(({ item }) => item.y));
    const right = Math.max(...selected.map(({ item }) => item.x + item.width));
    const bottom = Math.max(
      ...selected.map(({ item }) => item.y + item.height)
    );
    matches.push({
      pageNumber: page.pageNumber,
      region: { x, y, width: right - x, height: bottom - y },
      items: selected.map(({ item }) => item),
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

export function matchWordTextRegion(
  rendered: RenderedPdf,
  text: string
): LocatedRegion | null {
  const matched = matchWordText(rendered, text);
  return matched
    ? { pageNumber: matched.pageNumber, region: matched.region }
    : null;
}

async function pixels(page: RenderedPdfPage): Promise<Buffer> {
  const image = await loadImage(page.png);
  if (image.width !== page.width || image.height !== page.height)
    throw new Error("Invalid page geometry");
  const canvas = createCanvas(page.width, page.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return Buffer.from(context.getImageData(0, 0, page.width, page.height).data);
}

function expanded(
  region: Region,
  page: RenderedPdfPage,
  padding: number
): Region {
  const x = Math.max(0, Math.floor(region.x - padding));
  const y = Math.max(0, Math.floor(region.y - padding));
  return {
    x,
    y,
    width:
      Math.min(page.width, Math.ceil(region.x + region.width + padding)) - x,
    height:
      Math.min(page.height, Math.ceil(region.y + region.height + padding)) - y,
  };
}

const words = (text: string) =>
  text.normalize("NFKC").trim().split(/\s+/u).filter(Boolean).sort();
const overlaps = (a: Region, b: Region) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

/** Native bullet fonts can have a different fallback on the hosted renderer.
 * Only the measured prefix area may differ; the item words and their geometry
 * stay unchanged and every body pixel remains outside the permitted region. */
function listMarkerRegion(
  rendered: RenderedPdf,
  whole: LocatedText | null,
  body: LocatedText | null,
  prefix: string
): LocatedText | null {
  if (!whole || !body || whole.pageNumber !== body.pageNumber) return null;
  const items = whole.items.filter((item) => !body.items.includes(item));
  if (
    !items.length ||
    normalized(items.map((item) => item.text).join("")) !==
      normalized(prefix) ||
    items.some((item) => item.x + item.width > body.region.x)
  )
    return null;
  const page = rendered.pages.find(
    (item) => item.pageNumber === whole.pageNumber
  )!;
  const left = Math.max(
    0,
    Math.floor(Math.min(...items.map((item) => item.x)) - 2)
  );
  const right = Math.min(
    Math.floor(body.region.x),
    Math.ceil(Math.max(...items.map((item) => item.x + item.width)) + 2)
  );
  if (right <= left || right - left > Math.min(120, page.width * 0.12))
    return null;
  const y = Math.max(
    0,
    Math.floor(Math.min(...items.map((item) => item.y)) - 2)
  );
  const bottom = Math.min(
    page.height,
    Math.ceil(Math.max(...items.map((item) => item.y + item.height)) + 2)
  );
  return {
    pageNumber: whole.pageNumber,
    region: { x: left, y, width: right - left, height: bottom - y },
    items,
  };
}

function sameTextGeometry(
  left: LocatedRegion | null,
  right: LocatedRegion | null
): boolean {
  return (
    !!left &&
    !!right &&
    left.pageNumber === right.pageNumber &&
    (["x", "y", "width", "height"] as const).every(
      (key) =>
        Math.round(left.region[key] * 100) ===
        Math.round(right.region[key] * 100)
    )
  );
}

/** Anchor a table by its exact data row, then verify every visible header word.
 * PDF text order may be row-wise while Word's native inventory is cell-wise. */
async function tableRegions(
  sourcePages: RenderedPdf,
  outputPages: RenderedPdf,
  sourceCells: string[][],
  outputCells: string[][]
): Promise<{ before: LocatedRegion; after: LocatedRegion } | null> {
  const original = matchWordTextRegion(
    sourcePages,
    sourceCells.flat().join(" ")
  );
  const body = sourceCells.slice(2).flat().join(" ");
  const originalBody = matchWordTextRegion(sourcePages, body);
  const outputBody = matchWordTextRegion(outputPages, body);
  if (
    !original ||
    !originalBody ||
    !outputBody ||
    original.pageNumber !== originalBody.pageNumber ||
    original.pageNumber !== outputBody.pageNumber ||
    Math.abs(originalBody.region.y - outputBody.region.y) > 2 ||
    Math.abs(originalBody.region.x - outputBody.region.x) > 2
  )
    return null;
  const page = sourcePages.pages.find(
    (item) => item.pageNumber === original.pageNumber
  )!;
  const output = outputPages.pages.find(
    (item) => item.pageNumber === original.pageNumber
  )!;
  // Native table-cell margins extend beyond text. Expansion is bounded to
  // 5% of page width and four pixels vertically; every neighboring text box
  // remains protected. A full page can never become an allowed region.
  const margin = Math.min(64, page.width * 0.05);
  const region = expanded(original.region, page, 4);
  region.x = Math.max(0, Math.floor(original.region.x - margin));
  region.width =
    Math.min(
      page.width,
      Math.ceil(original.region.x + original.region.width + margin)
    ) - region.x;
  const selected = (items: PdfTextRegion[] | null | undefined) =>
    items?.filter((item) => overlaps(item, region));
  const beforeItems = selected(page.textRegions);
  const afterItems = selected(output.textRegions);
  if (
    !beforeItems ||
    !afterItems ||
    !same(
      words(beforeItems.map((item) => item.text).join(" ")),
      words(sourceCells.flat().join(" "))
    ) ||
    !same(
      words(afterItems.map((item) => item.text).join(" ")),
      words(outputCells.flat().join(" "))
    )
  )
    return null;
  // No text item may cross the permitted region's edge or be partially hidden
  // by the mask. This also rejects expansion into a neighboring paragraph.
  if (
    [...beforeItems, ...afterItems].some(
      (item) =>
        item.x < region.x ||
        item.y < region.y ||
        item.x + item.width > region.x + region.width ||
        item.y + item.height > region.y + region.height
    )
  )
    return null;
  // Only header pixels may change. Data rows, their formatting and contrast
  // stay protected even though the whole table supplied matching evidence.
  const [sourcePixels, outputPixels] = await Promise.all([
    pixels(page),
    pixels(output),
  ]);
  const bodyTop = measuredBodyBorder(
    page,
    sourcePixels,
    outputPixels,
    region,
    originalBody.region
  );
  if (bodyTop === null) return null;
  region.height = bodyTop - region.y;
  if (region.height <= 0) return null;
  return {
    before: { pageNumber: original.pageNumber, region },
    after: { pageNumber: original.pageNumber, region },
  };
}

/** Locate the unchanged full-width rule immediately above the data text.
 * Text extraction boxes overlap neighboring lines, so their top edge cannot
 * safely identify where a header ends. Without a visible proven row boundary
 * we permit no structural table pixel changes. */
function measuredBodyBorder(
  page: RenderedPdfPage,
  before: Buffer,
  after: Buffer,
  table: Region,
  body: Region
): number | null {
  const first = Math.max(2, Math.floor(body.y - body.height * 0.15));
  const last = Math.min(page.height - 3, Math.ceil(body.y + body.height * 0.5));
  const candidates: number[] = [];
  for (let y = first; y <= last; y++) {
    let matched = 0;
    for (let x = table.x; x < table.x + table.width; x++) {
      const at = (y * page.width + x) * 4,
        above = ((y - 2) * page.width + x) * 4,
        below = ((y + 2) * page.width + x) * 4;
      const light = (before[at] + before[at + 1] + before[at + 2]) / 3;
      const lightAbove =
        (before[above] + before[above + 1] + before[above + 2]) / 3;
      const lightBelow =
        (before[below] + before[below + 1] + before[below + 2]) / 3;
      if (
        light < 225 &&
        lightAbove - light > 18 &&
        lightBelow - light > 18 &&
        before[at] === after[at] &&
        before[at + 1] === after[at + 1] &&
        before[at + 2] === after[at + 2] &&
        before[at + 3] === after[at + 3]
      )
        matched++;
    }
    if (matched >= table.width * 0.7) candidates.push(y);
  }
  if (!candidates.length || candidates.at(-1)! - candidates[0] > 2) return null;
  return candidates[0];
}

/** No structural change relaxes page-wide checks or permits neighboring content to move. */
export async function verifyWordLayout(
  sourcePages: RenderedPdf,
  outputPages: RenderedPdf,
  source: DocxInspection,
  repaired: DocxRepairResult
): Promise<boolean> {
  if (
    sourcePages.pageCount !== outputPages.pageCount ||
    sourcePages.pages.length !== outputPages.pages.length
  )
    return false;
  if (
    sourcePages.pages.some(
      (page, index) =>
        page.pageNumber !== outputPages.pages[index].pageNumber ||
        page.width !== outputPages.pages[index].width ||
        page.height !== outputPages.pages[index].height
    )
  )
    return false;
  const allowed = new Map<number, Region[]>();
  const outputId = (id: string) =>
    repaired.identityMap ? (repaired.identityMap[id] ?? null) : id;
  const add = (
    before: LocatedRegion | null,
    after: LocatedRegion | null,
    padding: number
  ) => {
    if (!before || !after || before.pageNumber !== after.pageNumber)
      return false;
    if (
      Math.abs(before.region.y - after.region.y) > 12 ||
      Math.abs(before.region.x - after.region.x) > 24
    )
      return false;
    const page = sourcePages.pages.find(
      (item) => item.pageNumber === before.pageNumber
    )!;
    const regions = [
      expanded(before.region, page, padding),
      expanded(after.region, page, padding),
    ];
    if (
      regions.some(
        (region) =>
          region.width > page.width * 0.95 ||
          region.height > page.height * 0.3 ||
          region.width * region.height > page.width * page.height * 0.2
      )
    )
      return false;
    allowed.set(before.pageNumber, [
      ...(allowed.get(before.pageNumber) ?? []),
      ...regions,
    ]);
    return true;
  };
  for (const change of repaired.changes) {
    if (
      change.type !== "convertTypedList" &&
      change.type !== "simplifyTableHeaders"
    )
      continue;
    if (change.before === change.after) return false;
    if (change.type === "convertTypedList") {
      const candidate = source.listCandidates?.find(
        (list) => list.id === change.id
      );
      if (!candidate || !same(candidate.paragraphIds, change.paragraphIds))
        return false;
      const markers: { before: LocatedText; after: LocatedText }[] = [];
      for (let index = 0; index < candidate.paragraphIds.length; index++) {
        const paragraph = repaired.inspection.paragraphs.find(
          (item) => item.id === outputId(candidate.paragraphIds[index])
        );
        const original = candidate.sourceTexts[index];
        const prefix = candidate.prefixes[index];
        if (
          !paragraph ||
          !original.startsWith(prefix) ||
          paragraph.text !== original.slice(prefix.length) ||
          !paragraph.list ||
          paragraph.list.format !== candidate.kind
        )
          return false;
        // The original visible marker is now supplied by native numbering.
        const bodyText = original.slice(prefix.length);
        const beforeBody = matchWordText(sourcePages, bodyText);
        const afterBody = matchWordText(outputPages, bodyText);
        if (sameTextGeometry(beforeBody, afterBody)) {
          const before = listMarkerRegion(
            sourcePages,
            matchWordText(sourcePages, original),
            beforeBody,
            prefix
          );
          const after = listMarkerRegion(
            outputPages,
            matchWordText(outputPages, original),
            afterBody,
            prefix
          );
          if (before && after) markers.push({ before, after });
        }
        // Missing/ambiguous geometry authorizes no change. Pixel-identical
        // native numbering can still pass the exact unmasked comparison below.
      }
      const originalMarkers = new Set(
        markers.flatMap((marker) => marker.before.items)
      );
      const outputMarkers = new Set(
        markers.flatMap((marker) => marker.after.items)
      );
      const owned = (
        rendered: RenderedPdf,
        located: LocatedText,
        items: Set<PdfTextRegion>
      ) =>
        rendered.pages
          .find((page) => page.pageNumber === located.pageNumber)!
          .textRegions!.filter((item) => overlaps(item, located.region))
          .every((item) => items.has(item));
      for (const marker of markers) {
        // Conservative PDF boxes can overlap adjacent lines. Only prefixes
        // belonging to this verified list may overlap its marker-only strips.
        if (
          !owned(sourcePages, marker.before, originalMarkers) ||
          !owned(outputPages, marker.before, outputMarkers) ||
          !owned(sourcePages, marker.after, originalMarkers) ||
          !owned(outputPages, marker.after, outputMarkers)
        )
          continue;
        if (!add(marker.before, marker.after, 0)) return false;
      }
    } else {
      const table = source.tables.find((item) => item.id === change.id);
      const candidate = table?.headerCandidate;
      const actual = repaired.inspection.tables.find(
        (item) => item.id === outputId(change.id)
      );
      if (
        !table ||
        !candidate ||
        !actual ||
        actual.complex ||
        !actual.firstRowHeader ||
        !same(candidate.headerParagraphIds, change.paragraphIds) ||
        !same(
          actual.cells[0].map(normalized),
          candidate.labels.map(normalized)
        ) ||
        !same(actual.cells.slice(1), candidate.sourceCells.slice(2))
      )
        return false;
      // The engine proves that only derived header labels and the original
      // data rows remain. The region includes this table's borders and cells.
      const measured = await tableRegions(
        sourcePages,
        outputPages,
        candidate.sourceCells,
        actual.cells
      );
      if (!measured || !add(measured.before, measured.after, 0)) return false;
    }
  }
  for (let index = 0; index < sourcePages.pages.length; index++) {
    const before = sourcePages.pages[index];
    const after = outputPages.pages[index];
    const regions = allowed.get(before.pageNumber) ?? [];
    if (!regions.length && before.text !== after.text) return false;
    if (before.png.equals(after.png)) continue;
    const [left, right] = await Promise.all([pixels(before), pixels(after)]);
    if (left.equals(right)) continue;
    if (!regions.length) return false;
    const mask = new Uint8Array(before.width * before.height);
    let covered = 0;
    for (const region of regions)
      for (let y = region.y; y < region.y + region.height; y++)
        for (let x = region.x; x < region.x + region.width; x++) {
          const at = y * before.width + x;
          if (!mask[at]) {
            mask[at] = 1;
            covered++;
          }
        }
    if (covered > mask.length * 0.35) return false;
    for (let pixel = 0; pixel < mask.length; pixel++) {
      if (mask[pixel]) continue;
      const at = pixel * 4;
      if (
        left[at] !== right[at] ||
        left[at + 1] !== right[at + 1] ||
        left[at + 2] !== right[at + 2] ||
        left[at + 3] !== right[at + 3]
      )
        return false;
    }
  }
  return true;
}
