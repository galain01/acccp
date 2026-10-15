import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as pdfLib from "pdf-lib";
import { createPdfImageUsageInspector } from "../lib/pdf-image-usage.mjs";

const { PDFDocument, PDFName, PDFRawStream } = pdfLib;
const name = (key: string) => PDFName.of(key);

async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  const image = () =>
    pdf.context.stream(new Uint8Array(), {
      Type: "XObject",
      Subtype: "Image",
      Width: 4000,
      Height: 5000,
      BitsPerComponent: 1,
      ColorSpace: "DeviceGray",
    });
  const used = image();
  const unused = image();
  const resources = pdf.context.obj({
    XObject: {
      Image: pdf.context.register(used),
      Unused: pdf.context.register(unused),
    },
  });
  page.node.set(name("Resources"), resources);
  const content = (text: string) =>
    pdf.context.stream(Buffer.from(text, "latin1"));
  const setContent = (...texts: string[]) => {
    page.node.set(
      name("Contents"),
      pdf.context.obj(texts.map((text) => pdf.context.register(content(text))))
    );
  };
  setContent("/Image Do");
  const inspect = (options = {}) =>
    createPdfImageUsageInspector(pdf, pdfLib, options).inspectPage(page);
  const form = (text: string, ownResources?: pdfLib.PDFDict) => {
    const stream = pdf.context.stream(Buffer.from(text, "latin1"), {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 100, 100],
    });
    if (ownResources) stream.dict.set(name("Resources"), ownResources);
    return pdf.context.register(stream);
  };
  return {
    pdf,
    page,
    image,
    used,
    unused,
    resources,
    content,
    setContent,
    inspect,
    form,
  };
}

describe("bounded PDF image usage", () => {
  it("counts only invoked images in a shared resource dictionary", async () => {
    const f = await fixture();
    const second = f.pdf.addPage([300, 300]);
    second.node.set(name("Resources"), f.resources);
    second.node.set(name("Contents"), f.content("/Unused Do"));
    const inspector = createPdfImageUsageInspector(f.pdf, pdfLib);
    expect(inspector.inspectPage(f.page)).toEqual({
      precise: true,
      images: new Set([f.used]),
    });
    expect(inspector.inspectPage(second)).toEqual({
      precise: true,
      images: new Set([f.unused]),
    });
  });

  it("counts repeated names and invocations only once", async () => {
    const f = await fixture();
    f.resources
      .lookup(name("XObject"), pdfLib.PDFDict)
      .set(name("Alias"), f.used);
    f.setContent("/Image Do /Alias Do /Image Do");
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
  });

  it.each([
    "(% /Unused Do is text) Tj /Image Do",
    "(nested ( /Unused Do ) and escaped \\) text) Tj /Image Do",
    "[(text /Unused Do) -12 <2f556e7573656420446f>] TJ /Image Do",
    "% /Unused Do\n/Image Do % ignored /Unused Do",
    "/Span << /ActualText (/Unused Do) /Nested [<< /Value (nested) >>] >> BDC /Image Do EMC",
  ])(
    "does not interpret names/operators inside strings, arrays, dictionaries or comments: %s",
    async (text) => {
      const f = await fixture();
      f.setContent(text);
      expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
    }
  );

  it.each([
    ["/Ima", "ge Do"],
    ["/Image D", "o"],
    ["(a /Unu", "sed Do) Tj /Image Do"],
    ["% /Unused Do", " still a comment\n/Image Do"],
  ])(
    "preserves lexical state across Contents array streams",
    async (...chunks) => {
      const f = await fixture();
      f.setContent(...chunks);
      expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
    }
  );

  it("uses the nearest inherited resources", async () => {
    const f = await fixture();
    f.page.node.Parent()!.set(name("Resources"), f.resources);
    f.page.node.delete(name("Resources"));
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
  });

  it("falls back when empty local resources coexist with inherited categories", async () => {
    const f = await fixture();
    f.page.node.Parent()!.set(name("Resources"), f.resources);
    f.page.node.set(name("Resources"), f.pdf.context.obj({}));
    expect(f.inspect()).toEqual({ precise: false, images: new Set() });
  });

  it("falls back when PDF.js can merge resource categories across page ancestors", async () => {
    const f = await fixture();
    f.page.node.Parent()!.set(name("Resources"), f.resources);
    f.page.node.set(name("Resources"), f.pdf.context.obj({ Font: {} }));
    expect(f.inspect()).toEqual({ precise: false, images: new Set() });
  });

  it("accepts the identical shared resource dictionary repeated on a page and its parent", async () => {
    const f = await fixture();
    const ref = f.pdf.context.register(f.resources);
    f.page.node.set(name("Resources"), ref);
    f.page.node.Parent()!.set(name("Resources"), ref);
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
  });

  it("follows invoked forms but not unused form resources", async () => {
    const f = await fixture();
    const local = f.pdf.context.obj({
      XObject: { Chosen: f.used, Ignored: f.unused },
    });
    f.resources
      .lookup(name("XObject"), pdfLib.PDFDict)
      .set(name("Form"), f.form("/Chosen Do", local));
    f.setContent("/Form Do");
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
  });

  it("memoizes a resource-less form separately for each caller context", async () => {
    const f = await fixture();
    const child = f.form("/Chosen Do");
    const first = f.form(
      "/Child Do",
      f.pdf.context.obj({ XObject: { Child: child, Chosen: f.used } })
    );
    const second = f.form(
      "/Child Do",
      f.pdf.context.obj({ XObject: { Child: child, Chosen: f.unused } })
    );
    const xobjects = f.resources.lookup(name("XObject"), pdfLib.PDFDict);
    xobjects.set(name("First"), first);
    xobjects.set(name("Second"), second);
    f.setContent("/First Do /Second Do");
    expect(f.inspect()).toEqual({
      precise: true,
      images: new Set([f.used, f.unused]),
    });
  });

  it("includes nested explicit and soft masks by original stream identity", async () => {
    const f = await fixture();
    const soft = f.image();
    const explicit = f.image();
    soft.dict.delete(name("Subtype"));
    explicit.dict.delete(name("Subtype"));
    f.used.dict.set(name("SMask"), f.pdf.context.register(soft));
    soft.dict.set(name("Mask"), f.pdf.context.register(explicit));
    expect(f.inspect()).toEqual({
      precise: true,
      images: new Set([f.used, soft, explicit]),
    });
  });

  it("accepts color-key mask arrays without treating them as image streams", async () => {
    const f = await fixture();
    f.used.dict.set(name("Mask"), f.pdf.context.obj([0, 0]));
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
  });

  it("keeps ordinary text fonts and transparency states on the precise path", async () => {
    const f = await fixture();
    f.resources.set(
      name("Font"),
      f.pdf.context.obj({
        F: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" },
      })
    );
    f.resources.set(
      name("ExtGState"),
      f.pdf.context.obj({ S: { ca: 0.5, SMask: "None" } })
    );
    f.setContent("/S gs BT /F 12 Tf 0 0 Td (text) Tj ET /Image Do");
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
  });

  it.each([
    "/Pattern cs /P scn /Image Do",
    "0.1 0.2 0.3 /P SCN /Image Do",
    "BI /W 1 /H 1 ID /Unused Do EI /Image Do",
    "/Image Do unknown-command",
    "/Image 42 q Do",
    "/Image 1 2 3 rg Do",
    "/Image Do 3 q",
    "/Image Do (unterminated",
    "/Image Do << /Bad >> BDC",
    "/Image Do [ (unterminated) TJ",
    "/Image Do /Im#61ge Do",
    "/Image Do /Missing Do",
    "/Image Do 1 0 R Do",
    "/Image Do 0.1.2 w",
    "/Image Do null q",
    "/Image Do (wrong type) Do",
    "/Image Do /Trailing",
  ])(
    "discards all partial precision on ambiguous or unsupported content: %s",
    async (text) => {
      const f = await fixture();
      f.setContent(text);
      expect(f.inspect()).toEqual({ precise: false, images: new Set() });
    }
  );

  it.each([
    "Type3",
    "ordinary-with-resources",
    "gs-font",
    "gs-mask",
    "annotation",
  ])("falls back for complex resource-bearing %s", async (kind) => {
    const f = await fixture();
    if (kind === "annotation") {
      f.page.node.set(
        name("Annots"),
        f.pdf.context.obj([{ AP: { N: f.form("/Image Do") } }])
      );
    } else if (kind.startsWith("gs")) {
      f.resources.set(
        name("ExtGState"),
        f.pdf.context.obj({
          S:
            kind === "gs-font"
              ? { Font: [{ Type: "Font", Subtype: "Type3" }, 12] }
              : { SMask: { S: "Luminosity", G: f.form("/Image Do") } },
        })
      );
      f.setContent("/Image Do /S gs");
    } else {
      f.resources.set(
        name("Font"),
        f.pdf.context.obj({
          F: {
            Type: "Font",
            Subtype: kind === "Type3" ? "Type3" : "Type1",
            Resources: f.resources,
          },
        })
      );
      f.setContent("/Image Do /F 12 Tf");
    }
    expect(f.inspect()).toEqual({ precise: false, images: new Set() });
  });

  it("does not fall back for a plain link annotation without appearances", async () => {
    const f = await fixture();
    f.page.node.set(
      name("Annots"),
      f.pdf.context.obj([{ Type: "Annot", Subtype: "Link" }])
    );
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
  });

  it.each(["Widget", "FreeText", "Stamp", "unknown"])(
    "falls back for %s annotations that may synthesize appearances",
    async (subtype) => {
      const f = await fixture();
      f.page.node.set(
        name("Annots"),
        f.pdf.context.obj([{ Type: "Annot", Subtype: subtype }])
      );
      expect(f.inspect()).toEqual({ precise: false, images: new Set() });
    }
  );

  it("falls back on escaped resource dictionary names", async () => {
    const f = await fixture();
    f.resources
      .lookup(name("XObject"), pdfLib.PDFDict)
      .set(name("name with spaces"), f.unused);
    expect(f.inspect()).toEqual({ precise: false, images: new Set() });
  });

  it("accepts bounded Flate content without decoding image bytes", async () => {
    const f = await fixture();
    f.page.node.set(
      name("Contents"),
      f.pdf.context.flateStream(Buffer.from("/Image Do"))
    );
    expect(f.inspect()).toEqual({ precise: true, images: new Set([f.used]) });
    expect(f.used.contents.length).toBe(0);
  });

  it.each(["unsupported-filter", "predictor", "bad-flate", "filter-chain"])(
    "falls back on %s",
    async (kind) => {
      const f = await fixture();
      const stream = f.pdf.context.flateStream(Buffer.from("/Image Do"));
      if (kind === "unsupported-filter")
        stream.dict.set(name("Filter"), name("LZWDecode"));
      else if (kind === "predictor")
        stream.dict.set(
          name("DecodeParms"),
          f.pdf.context.obj({ Predictor: 12 })
        );
      else if (kind === "filter-chain")
        stream.dict.set(
          name("Filter"),
          f.pdf.context.obj(["FlateDecode", "FlateDecode"])
        );
      f.page.node.set(
        name("Contents"),
        kind === "bad-flate"
          ? PDFRawStream.of(stream.dict, new Uint8Array([1, 2, 3]))
          : stream
      );
      expect(f.inspect()).toEqual({ precise: false, images: new Set() });
    }
  );

  it("bounds Flate expansion before materializing the decompressed stream", async () => {
    const f = await fixture();
    const compressed = deflateSync(
      Buffer.from(`${" ".repeat(10000)}/Image Do`)
    );
    f.page.node.set(
      name("Contents"),
      f.pdf.context.stream(compressed, { Filter: "FlateDecode" })
    );
    expect(f.inspect({ maxStreamBytes: 256 })).toEqual({
      precise: false,
      images: new Set(),
    });
  });

  it("uses a document-wide decoded-byte budget but caches shared streams", async () => {
    const f = await fixture();
    const shared = f.pdf.context.flateStream(Buffer.from("/Image Do"));
    f.page.node.set(name("Contents"), shared);
    const second = f.pdf.addPage([300, 300]);
    second.node.set(name("Resources"), f.resources);
    second.node.set(name("Contents"), shared);
    const inspector = createPdfImageUsageInspector(f.pdf, pdfLib, {
      maxDecodedBytes: 9,
    });
    expect(inspector.inspectPage(f.page).precise).toBe(true);
    expect(inspector.inspectPage(second).precise).toBe(true);
    second.node.set(name("Contents"), f.content("/Image Do"));
    expect(inspector.inspectPage(second)).toEqual({
      precise: false,
      images: new Set(),
    });
  });

  it("bounds combined Contents length even when individual streams fit", async () => {
    const f = await fixture();
    f.setContent("q q q q ", "Q Q Q Q /Image Do");
    expect(f.inspect({ maxStreamBytes: 20 })).toEqual({
      precise: false,
      images: new Set(),
    });
  });

  it("bounds recursion and cyclic forms", async () => {
    const f = await fixture();
    const xobjects = f.resources.lookup(name("XObject"), pdfLib.PDFDict);
    xobjects.set(name("Recursive"), f.form("/Recursive Do"));
    f.setContent("/Image Do /Recursive Do");
    expect(f.inspect()).toEqual({ precise: false, images: new Set() });
    xobjects.set(name("Recursive"), f.form("/Nested Do"));
    xobjects.set(name("Nested"), f.form("/Image Do"));
    expect(f.inspect({ maxDepth: 1 })).toEqual({
      precise: false,
      images: new Set(),
    });
  });

  it.each([{ maxOperations: 1 }, { maxTokens: 3 }, { maxObjects: 1 }])(
    "bounds cumulative work with %j",
    async (options) => {
      const f = await fixture();
      f.setContent("/Image Do /Image Do");
      expect(f.inspect(options)).toEqual({ precise: false, images: new Set() });
    }
  );

  it("allows a blank page with unused image resources", async () => {
    const f = await fixture();
    f.page.node.delete(name("Contents"));
    expect(f.inspect()).toEqual({ precise: true, images: new Set() });
  });
});
