import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type {
  AccessibilityError,
  FindingLocation,
} from "./accessibility-findings";
import type { PdfImageAlternative, RenderedPdf } from "./pdf-rendering";

type Node = DefaultTreeAdapterTypes.Node;
type Image = { id: string; alt: string | null; element: string };
const MAX_HTML = 2 * 1024 * 1024;

function imageInventory(html: string): Image[] | null {
  if (html.length > MAX_HTML) return null;
  const root = parseFragment(html, { sourceCodeLocationInfo: true });
  const pending: Node[] = [...root.childNodes];
  const images: Image[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) {
      if (
        node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
        ["template", "script", "style", "noscript"].includes(node.tagName)
      )
        continue;
      if (
        node.attrs.some(
          ({ name, value }) =>
            name === "hidden" ||
            (name === "aria-hidden" && value.trim().toLowerCase() === "true") ||
            (name === "style" &&
              /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
                value
              ))
        )
      )
        continue;
      if (node.tagName === "img") {
        const id = node.attrs.find(
          (attr) => attr.name === "data-source-image-id"
        )?.value;
        if (id) {
          const location = node.sourceCodeLocation;
          images.push({
            id,
            alt: node.attrs.find((attr) => attr.name === "alt")?.value ?? null,
            element: location
              ? html
                  .slice(location.startOffset, location.endOffset)
                  .slice(0, 240)
              : "",
          });
        }
      }
    }
    if ("childNodes" in node) pending.push(...node.childNodes);
  }
  return images;
}

function location(page: number, figure?: PdfImageAlternative): FindingLocation {
  const box = figure?.bounds;
  return {
    scope: "element",
    sourcePages: [page],
    printedPageLabel: null,
    section: null,
    locator: box
      ? `Image area ${Math.round(box.x * 100)}% from the left and ${Math.round(box.y * 100)}% from the top of the PDF page`
      : "Image descriptions on this PDF page",
    quote: figure?.alt.trim().slice(0, 240) || null,
  };
}

/** Checks preservation without rewriting HTML or treating model image IDs as proof of a visual match. */
export function pdfImageReviewFindings(
  html: string,
  rendered: RenderedPdf
): AccessibilityError[] {
  const findings: AccessibilityError[] = [];
  const images = imageInventory(html);
  const sourceIds = new Set<string>();
  for (const page of rendered.pages) {
    const source = page.imageAlternatives;
    if (source.status === "unavailable") {
      findings.push({
        type: "other",
        category: "source-review",
        severity: "warning",
        title: "Check this page's existing image descriptions",
        message: `The existing image descriptions on PDF page ${page.pageNumber} could not be read completely. The converter may have written new descriptions from the pictures instead.`,
        suggestion:
          "If this page contains images, compare their descriptions in the converted Canvas page with the descriptions in your original document. Keep useful information the author supplied.",
        location: location(page.pageNumber),
      });
    }
    for (const figure of source.figures) {
      sourceIds.add(figure.id);
      const matched = images?.filter((image) => image.id === figure.id) ?? [];
      if (figure.bounds === null || !images || matched.length !== 1) {
        findings.push({
          type: "other",
          category: "source-review",
          severity: "warning",
          title: "Match the original description to its image",
          message: `An existing image description on PDF page ${page.pageNumber} could not be reliably matched to one image in the converted page.`,
          suggestion: figure.alt.trim()
            ? "Find the image described by the quoted text in your original document. In Canvas, make sure that description belongs to the same image; do not assign it to another picture just because it appears next."
            : "Check the images on the indicated PDF page against Canvas. The original includes an empty image description; confirm whether its image is only decoration or needs a written explanation.",
          location: location(page.pageNumber, figure),
          ...(matched.length === 1 && matched[0].element
            ? { element: matched[0].element }
            : {}),
        });
        continue;
      }
      const image = matched[0];
      // HTML parsing normalizes literal CR/CRLF. Character-reference escaping is
      // decoded by parse5; all other authored wording/spacing must be preserved.
      const original = figure.alt.replace(/\r\n?/g, "\n");
      if (
        figure.alt !== "" &&
        image.alt?.replace(/\r\n?/g, "\n") !== original
      ) {
        findings.push({
          type: "other",
          category: "content-fidelity",
          severity: "warning",
          title: "Restore the original image description",
          message: `The image matched on PDF page ${page.pageNumber} has a description that differs from the author's original, or its description is missing.`,
          suggestion:
            "Confirm this is the same image, then restore its original description in Canvas. Keep any teaching context in the original; ask the author to clarify wording that seems incorrect.",
          location: location(page.pageNumber, figure),
          ...(image.element ? { element: image.element } : {}),
        });
      }
    }
  }
  for (const image of images ?? []) {
    if (sourceIds.has(image.id)) continue;
    findings.push({
      type: "other",
      category: "source-review",
      severity: "warning",
      title: "Check this image's description",
      message:
        "This image refers to an original description that could not be verified in the PDF.",
      suggestion:
        "Compare this picture and its description with the original document. Keep the description that belongs to this image.",
      ...(image.element ? { element: image.element } : {}),
    });
  }
  return findings;
}
