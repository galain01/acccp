import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  type PDFArray,
  type PDFRef,
} from "pdf-lib";

export interface TaggedFigure {
  /** Undefined omits /Alt; an empty string is an explicit authored alternative. */
  alt?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind?: "image" | "vector";
  /** Reuse a single image XObject without merging its distinct occurrences. */
  imageKey?: string;
  /** Exercise an unlocatable MCID without inventing another visual association. */
  drawnMcid?: number;
}

export interface TaggedPage {
  figures: TaggedFigure[];
  /** Structure order need not equal drawing order or top-to-bottom position. */
  structureOrder?: number[];
}

/** All fixture bytes are synthetic and remain in memory; no committed PDFs. */
export async function taggedPdf(
  specifications: TaggedPage[],
  options: { tagged?: boolean; size?: [number, number] } = {}
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const name = PDFName.of;
  const tagged = options.tagged ?? true;
  const size = options.size ?? [200, 200];
  const root = pdf.context.obj({ Type: name("StructTreeRoot") });
  const rootRef = pdf.context.register(root);
  const document = pdf.context.obj({
    Type: name("StructElem"),
    S: name("Document"),
    P: rootRef,
  });
  const documentRef = pdf.context.register(document);
  const documentChildren: PDFRef[] = [];
  const parentNumbers: Array<number | PDFArray> = [];
  const images = new Map<string, PDFRef>();

  for (const [pageIndex, specification] of specifications.entries()) {
    const page = pdf.addPage(size);
    const operators: string[] = [];
    const resources: Record<string, PDFRef> = {};
    const figureRefs: PDFRef[] = [];
    for (const [index, figure] of specification.figures.entries()) {
      const resourceName = `Image${index}`;
      if (figure.kind !== "vector") {
        const key = figure.imageKey ?? `${pageIndex}-${index}`;
        let image = images.get(key);
        if (!image) {
          image = pdf.context.register(
            pdf.context.flateStream(new Uint8Array([20, 90, 210]), {
              Type: name("XObject"),
              Subtype: name("Image"),
              Width: 1,
              Height: 1,
              BitsPerComponent: 8,
              ColorSpace: name("DeviceRGB"),
            })
          );
          images.set(key, image);
        }
        resources[resourceName] = image;
      }
      if (tagged)
        operators.push(`/Figure << /MCID ${figure.drawnMcid ?? index} >> BDC`);
      operators.push("q");
      if (figure.kind === "vector") {
        operators.push(
          "0.1 0.6 0.2 rg",
          `${figure.x} ${figure.y} ${figure.width} ${figure.height} re f`
        );
      } else {
        operators.push(
          `${figure.width} 0 0 ${figure.height} ${figure.x} ${figure.y} cm`,
          `/${resourceName} Do`
        );
      }
      operators.push("Q");
      if (tagged) operators.push("EMC");
      const structure = pdf.context.obj({
        Type: name("StructElem"),
        S: name("Figure"),
        P: documentRef,
        Pg: page.ref,
        K: index,
      });
      if (figure.alt !== undefined)
        structure.set(name("Alt"), PDFHexString.fromText(figure.alt));
      figureRefs.push(pdf.context.register(structure));
    }
    page.node.set(name("Resources"), pdf.context.obj({ XObject: resources }));
    page.node.set(
      name("Contents"),
      pdf.context.register(pdf.context.flateStream(operators.join("\n")))
    );
    if (tagged) {
      page.node.set(name("StructParents"), pdf.context.obj(pageIndex));
      parentNumbers.push(
        pageIndex,
        pdf.context.obj(figureRefs.length ? figureRefs : [PDFNull])
      );
      const order =
        specification.structureOrder ?? figureRefs.map((_, index) => index);
      for (const index of order) documentChildren.push(figureRefs[index]);
    }
  }
  if (tagged) {
    document.set(name("K"), pdf.context.obj(documentChildren));
    root.set(name("K"), documentRef);
    root.set(
      name("ParentTree"),
      pdf.context.register(pdf.context.obj({ Nums: parentNumbers }))
    );
    root.set(name("ParentTreeNextKey"), pdf.context.obj(specifications.length));
    pdf.catalog.set(name("StructTreeRoot"), rootRef);
    pdf.catalog.set(name("MarkInfo"), pdf.context.obj({ Marked: true }));
    pdf.catalog.set(name("Lang"), PDFHexString.fromText("en-US"));
  }
  return Buffer.from(await pdf.save());
}
