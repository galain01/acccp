import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { renderPdfPages } from "../lib/pdf-rendering";
import { taggedPdf } from "./helpers/tagged-pdf";

const name = PDFName.of;
const authoredAlt = "The source author describes a particular figure here.";

async function fixture() {
  const pdf = await PDFDocument.load(
    await taggedPdf([
      {
        figures: [{ x: 20, y: 120, width: 60, height: 40, alt: authoredAlt }],
      },
    ])
  );
  const root = pdf.catalog.lookup(name("StructTreeRoot"), PDFDict);
  const document = root.lookup(name("K"), PDFDict);
  const figure = document.lookup(name("K"), PDFArray).lookup(0, PDFDict);
  const parentTree = root.lookup(name("ParentTree"), PDFDict);
  return { pdf, root, document, figure, parentTree };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

describe("PDF figure structure scope and completeness", () => {
  it("preserves a stream-scoped description without assigning a colliding page MCID's bounds", async () => {
    const { pdf, figure } = await fixture();
    const page = pdf.getPage(0);
    // This Form is never drawn. The page's visible image also uses MCID 0, so
    // page+MCID alone must not associate its position with this description.
    const unusedForm = pdf.context.register(
      pdf.context.flateStream("0 1 0 rg 0 0 20 20 re f", {
        Type: name("XObject"),
        Subtype: name("Form"),
        BBox: [0, 0, 20, 20],
        Resources: {},
      })
    );
    figure.set(
      name("K"),
      pdf.context.obj({
        Type: name("MCR"),
        Pg: page.ref,
        Stm: unusedForm,
        MCID: 0,
      })
    );

    const result = await renderPdfPages(Buffer.from(await pdf.save()));
    expect(result.pages[0].imageAlternatives).toEqual({
      status: "complete",
      figures: [{ id: "p1-figure1", alt: authoredAlt, bounds: null }],
    });
    expect(result.pages[0].png.length).toBeGreaterThan(24);
  }, 15_000);

  const malformed: Array<{
    description: string;
    mutate: (source: Fixture) => void;
  }> = [
    {
      description: "the ParentTree is absent",
      mutate: ({ root }) => {
        root.delete(name("ParentTree"));
      },
    },
    {
      description: "the ParentTree has no entry for the page",
      mutate: ({ pdf, parentTree }) => {
        parentTree.lookup(name("Nums"), PDFArray).set(0, pdf.context.obj(1));
      },
    },
    {
      description: "the ParentTree page entry is null",
      mutate: ({ parentTree }) => {
        parentTree.lookup(name("Nums"), PDFArray).set(1, PDFNull);
      },
    },
    {
      description: "the ParentTree MCID owner entry is null",
      mutate: ({ parentTree }) => {
        parentTree
          .lookup(name("Nums"), PDFArray)
          .lookup(1, PDFArray)
          .set(0, PDFNull);
      },
    },
    {
      description: "the Figure's parent pointer is absent",
      mutate: ({ figure }) => {
        figure.delete(name("P"));
      },
    },
    {
      description: "the Figure's parent pointer names the wrong ancestor",
      mutate: ({ pdf, figure }) => {
        figure.set(name("P"), pdf.catalog.get(name("StructTreeRoot"))!);
      },
    },
    {
      description: "the authored Figure's content subtree is empty",
      mutate: ({ pdf, figure }) => {
        figure.set(name("K"), pdf.context.obj([]));
      },
    },
    {
      description: "the authored Figure's content subtree is absent",
      mutate: ({ figure }) => {
        figure.delete(name("K"));
      },
    },
  ];

  for (const { description, mutate } of malformed) {
    it(`reports extraction unavailable when ${description}`, async () => {
      const source = await fixture();
      mutate(source);
      const result = await renderPdfPages(Buffer.from(await source.pdf.save()));
      // Rendering can still succeed, but silently returning complete/[] would
      // lose the known authored alternative without a manual-review warning.
      expect(result.pages[0].imageAlternatives).toEqual({
        status: "unavailable",
        figures: [],
      });
      expect(result.pages[0].png.length).toBeGreaterThan(24);
    }, 15_000);
  }
});
