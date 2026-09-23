import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { loadPdfWithRevisions } from "../lib/pdf-revisions.mjs";
import {
  appendObjectStreamRevision,
  appendRevision,
  initialPdf,
  pdfStream,
  type IncrementalPdf,
} from "./helpers/incremental-pdf";

const pdfLib = createRequire(import.meta.url)("pdf-lib/dist/pdf-lib.min.js");
const load = (bytes: Uint8Array, maxObjects = 100_000) =>
  loadPdfWithRevisions(bytes, pdfLib, { maxObjects });
const lookup = (doc: ReturnType<typeof load>, id: number) =>
  doc.context.lookup(pdfLib.PDFRef.of(id));
const base = () =>
  initialPdf([
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    { id: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>" },
    { id: 4, body: "42" },
  ]);
const pad = (value: number) => String(value).padStart(10, "0");
function finishWithXrefStream(
  original: IncrementalPdf,
  data: Buffer,
  dictionary: string
) {
  const position = original.bytes.length;
  return Buffer.concat([
    original.bytes,
    Buffer.from(`10 0 obj\n`, "latin1"),
    pdfStream(
      data,
      `/Type /XRef /Size 11 /Root 1 0 R /Prev ${original.lastXref} ${dictionary}`
    ),
    Buffer.from(`\nendobj\nstartxref\n${position}\n%%EOF\n`, "latin1"),
  ]);
}

function linearized(numberOfPages = 1, firstPage = 3) {
  // Front xref selects value 42; final xref alone would select value 7. PDF.js
  // chooses the front xref when the first dictionary's /L matches actual bytes.
  const prefix = `%PDF-1.7\n10 0 obj\n<< /Linearized 1 /L LLLLLLLLLL /H [1 1] /O ${firstPage} /E 1 /N ${numberOfPages} /T 1 >>\nendobj\n`;
  const front =
    "xref\n1 4\n" +
    [1, 2, 3, 4].map((id) => `${String(id).repeat(10)} 00000 n \n`).join("") +
    "trailer\n<< /Size 11 /Root 1 0 R /Prev PPPPPPPPPP >>\n";
  let body = prefix + front;
  const offsets = new Map<number, number>();
  for (const [id, contents] of [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"],
    [4, "42"],
  ] as const) {
    offsets.set(id, body.length);
    body += `${id} 0 obj\n${contents}\nendobj\n`;
  }
  const alternate = body.length;
  body += "4 0 obj\n7\nendobj\n";
  const lastXref = body.length;
  body += `xref\n4 1\n${pad(alternate)} 00000 n \ntrailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n${lastXref}\n%%EOF\n`;
  body = body
    .replace("LLLLLLLLLL", pad(body.length))
    .replace("PPPPPPPPPP", pad(lastXref));
  for (const [id, position] of offsets)
    body = body.replace(String(id).repeat(10), pad(position));
  return Buffer.from(body, "latin1");
}

describe("xref-selected PDF object loading", () => {
  it("selects the newest revision without modifying the source bytes", () => {
    const original = base();
    const updated = appendRevision(original, [{ id: 4, body: "84" }]);
    const unchanged = Buffer.from(updated.bytes);
    expect(lookup(load(updated.bytes), 4).asNumber()).toBe(84);
    expect(updated.bytes).toEqual(unchanged);
  });

  it("ignores a later physical object when xref selects the older definition", () => {
    const original = base();
    const updated = appendRevision(
      original,
      [{ id: 4, body: "7" }],
      new Map([[4, original.offsets.get(4)!]])
    );
    expect(lookup(load(updated.bytes), 4).asNumber()).toBe(42);
  });

  it("does not resurrect a free object from an older revision", () => {
    const updated = appendRevision(base(), [], new Map([[4, null]]));
    expect(lookup(load(updated.bytes), 4)).toBeUndefined();
  });

  it("resolves type-2 entries by object-stream index and applies PNG predictors", () => {
    const updated = appendObjectStreamRevision(base(), [{ id: 4, body: "91" }]);
    expect(lookup(load(updated.bytes), 4).asNumber()).toBe(91);
  });

  it("does not assign unselected embedded objects over a newer direct definition", () => {
    const compressed = appendObjectStreamRevision(base(), [
      { id: 4, body: "91" },
    ]);
    const updated = appendRevision(compressed, [{ id: 4, body: "123" }]);
    expect(lookup(load(updated.bytes), 4).asNumber()).toBe(123);
  });

  it("uses the front directory for valid linearized PDFs, matching PDF.js", () => {
    expect(lookup(load(linearized()), 4).asNumber()).toBe(42);
  });

  it("rejects unsafe recognized linearization values instead of choosing a different directory", () => {
    let text = linearized()
      .toString("latin1")
      .replace("/H [1 1]", "/H [9007199254740992 1]");
    text = text.replace(/\/L \d{10}/, `/L ${pad(text.length)}`);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => load(Buffer.from(text, "latin1"))).toThrow(
        expect.objectContaining({ code: "pdf_invalid" })
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("processes hybrid and previous section links in the same FIFO order as PDF.js", () => {
    const original = base();
    const newer = appendRevision(original, [{ id: 4, body: "99" }]);
    const supplementalOffset = newer.bytes.length;
    const supplemental = Buffer.concat([
      Buffer.from("5 0 obj\n", "latin1"),
      pdfStream(
        Buffer.from([0, 0, 1]),
        `/Type /XRef /Size 7 /Index [6 1] /W [1 1 1] /Prev ${original.lastXref}`
      ),
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    const lastXref = supplementalOffset + supplemental.length;
    const bytes = Buffer.concat([
      newer.bytes,
      supplemental,
      Buffer.from(
        `xref\n5 1\n${pad(supplementalOffset)} 00000 n \ntrailer\n<< /Size 7 /Root 1 0 R /XRefStm ${supplementalOffset} /Prev ${newer.lastXref} >>\nstartxref\n${lastXref}\n%%EOF\n`,
        "latin1"
      ),
    ]);
    expect(lookup(load(bytes), 4).asNumber()).toBe(99);
  });

  it.each([
    [2, 3],
    [1, 9],
  ])(
    "rejects a linearized page count or first-page reference outside the selected tree (%i, %i)",
    (count, first) => {
      expect(() => load(linearized(count, first))).toThrow(
        expect.objectContaining({ code: "pdf_invalid" })
      );
    }
  );

  it("uses the latest directory after a save makes /L outdated", () => {
    const bytes = linearized();
    const amended = appendRevision(
      {
        bytes,
        lastXref: bytes.indexOf(Buffer.from("xref\n")),
        size: 11,
        offsets: new Map(),
      },
      [{ id: 4, body: "7" }]
    );
    expect(lookup(load(amended.bytes), 4).asNumber()).toBe(7);
  });

  it("requires selected object headers to match their xref number and generation", () => {
    const original = base();
    const wrong = appendRevision(
      original,
      [],
      new Map([[4, original.offsets.get(3)!]])
    );
    expect(() => load(wrong.bytes)).toThrow(
      expect.objectContaining({ code: "pdf_invalid" })
    );
    const badGeneration = Buffer.from(
      original.bytes.toString("latin1").replace("4 0 obj", "4 1 obj"),
      "latin1"
    );
    expect(() => load(badGeneration)).toThrow(
      expect.objectContaining({ code: "pdf_invalid" })
    );
  });

  it("rejects truncated and unknown xref-stream entries", () => {
    expect(() =>
      load(
        finishWithXrefStream(
          base(),
          Buffer.from([1, 0]),
          "/W [1 4 2] /Index [4 1]"
        )
      )
    ).toThrow(expect.objectContaining({ code: "pdf_invalid" }));
    expect(() =>
      load(
        finishWithXrefStream(
          base(),
          Buffer.from([3, 0, 0]),
          "/W [1 1 1] /Index [4 1]"
        )
      )
    ).toThrow(expect.objectContaining({ code: "pdf_invalid" }));
  });

  it("accepts an explicit null filter as unfiltered", () => {
    const original = base();
    const entry = Buffer.alloc(7);
    entry[0] = 1;
    entry.writeUInt32BE(original.offsets.get(4)!, 1);
    const bytes = finishWithXrefStream(
      original,
      entry,
      "/W [1 4 2] /Index [4 1] /Filter null"
    );
    expect(lookup(load(bytes), 4).asNumber()).toBe(42);
  });

  it("applies TIFF component differences before reading xref fields", () => {
    const original = base();
    const plain = Buffer.alloc(7);
    plain[0] = 1;
    plain.writeUInt32BE(original.offsets.get(4)!, 1);
    const encoded = Buffer.from(
      plain.map((value, index) =>
        index ? (value - plain[index - 1]) & 255 : value
      )
    );
    const bytes = finishWithXrefStream(
      original,
      deflateSync(encoded),
      "/W [1 4 2] /Index [4 1] /Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 7 >>"
    );
    expect(lookup(load(bytes), 4).asNumber()).toBe(42);
  });

  it("resolves indirect stream lengths instead of searching binary content", () => {
    const original = base();
    const text = "abc endstream xyz";
    const updated = appendRevision(original, [
      { id: 5, body: `<< /Length 6 0 R >>\nstream\n${text}\nendstream` },
      { id: 6, body: String(text.length) },
    ]);
    expect(
      Buffer.from(lookup(load(updated.bytes), 5).contents).toString()
    ).toBe(text);
    const malformed = Buffer.from(
      updated.bytes
        .toString("latin1")
        .replace(String(text.length) + "\nendobj", "01\nendobj"),
      "latin1"
    );
    expect(() => load(malformed)).toThrow(
      expect.objectContaining({ code: "pdf_invalid" })
    );
  });

  it("classifies encryption before decoding protected objects", () => {
    const original = base();
    const bytes = Buffer.from(
      original.bytes
        .toString("latin1")
        .replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 5 0 R"),
      "latin1"
    );
    expect(() => load(bytes)).toThrow(
      expect.objectContaining({ code: "pdf_password" })
    );
  });

  it("rejects cyclic revision links and missing final directories", () => {
    const original = base();
    const updated = appendRevision(original, []);
    const cyclic = Buffer.from(
      updated.bytes
        .toString("latin1")
        .replace(`/Prev ${original.lastXref}`, `/Prev ${updated.lastXref}`),
      "latin1"
    );
    expect(() => load(cyclic)).toThrow(
      expect.objectContaining({ code: "pdf_invalid" })
    );
    expect(() => load(original.bytes.subarray(0, original.lastXref))).toThrow(
      expect.objectContaining({ code: "pdf_invalid" })
    );
  });

  it("bounds selected entries and decompressed structural streams", () => {
    expect(() => load(base().bytes, 3)).toThrow(
      expect.objectContaining({ code: "pdf_complexity_limit" })
    );
    const bomb = deflateSync(Buffer.alloc(16 * 1024 * 1024 + 1));
    const bytes = finishWithXrefStream(
      base(),
      bomb,
      "/W [1 1 1] /Index [4 1] /Filter /FlateDecode"
    );
    expect(() => load(bytes)).toThrow(
      expect.objectContaining({ code: "pdf_complexity_limit" })
    );
  });
});
