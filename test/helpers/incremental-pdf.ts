import { deflateSync } from "node:zlib";

/** Tiny, valid synthetic PDFs with explicit incremental xrefs. No user files. */
export type PdfObject = { id: number; body: string | Buffer };
export interface IncrementalPdf {
  bytes: Buffer;
  lastXref: number;
  size: number;
  offsets: Map<number, number>;
}

function latin(value: string | Buffer): Buffer {
  return typeof value === "string" ? Buffer.from(value, "latin1") : value;
}

export function pdfStream(contents: string | Buffer, dictionary = ""): Buffer {
  const bytes = latin(contents);
  return Buffer.concat([
    latin(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    latin("\nendstream"),
  ]);
}

function physicalObjects(prefix: Buffer, objects: PdfObject[]) {
  const parts = [prefix];
  const offsets = new Map<number, number>();
  let position = prefix.length;
  for (const { id, body } of objects) {
    offsets.set(id, position);
    const bytes = Buffer.concat([
      latin(`${id} 0 obj\n`),
      latin(body),
      latin("\nendobj\n"),
    ]);
    parts.push(bytes);
    position += bytes.length;
  }
  return { bytes: Buffer.concat(parts), offsets };
}

export function initialPdf(objects: PdfObject[]): IncrementalPdf {
  const physical = physicalObjects(
    latin("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"),
    objects
  );
  const size = Math.max(...objects.map(({ id }) => id)) + 1;
  const lastXref = physical.bytes.length;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) {
    const offset = physical.offsets.get(id);
    table +=
      offset === undefined
        ? "0000000000 00000 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  return {
    bytes: Buffer.concat([
      physical.bytes,
      latin(
        `${table}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${lastXref}\n%%EOF\n`
      ),
    ]),
    lastXref,
    size,
    offsets: physical.offsets,
  };
}

/** selectedOffsets can select an earlier definition; null creates a free entry. */
export function appendRevision(
  previous: IncrementalPdf,
  objects: PdfObject[],
  selectedOffsets: Map<number, number | null> = new Map()
): IncrementalPdf {
  const physical = physicalObjects(previous.bytes, objects);
  const entries = new Map<number, number | null>(physical.offsets);
  for (const [id, offset] of selectedOffsets) entries.set(id, offset);
  const size = Math.max(
    previous.size,
    ...[...entries.keys()].map((id) => id + 1)
  );
  const lastXref = physical.bytes.length;
  let table = "xref\n";
  for (const [id, offset] of [...entries].sort(([a], [b]) => a - b)) {
    table += `${id} 1\n${offset === null ? "0000000000 00001 f " : `${String(offset).padStart(10, "0")} 00000 n `}\n`;
  }
  const offsets = new Map(previous.offsets);
  for (const [id, offset] of entries) {
    if (offset === null) offsets.delete(id);
    else offsets.set(id, offset);
  }
  return {
    bytes: Buffer.concat([
      physical.bytes,
      latin(
        `${table}trailer\n<< /Size ${size} /Root 1 0 R /Prev ${previous.lastXref} >>\nstartxref\n${lastXref}\n%%EOF\n`
      ),
    ]),
    lastXref,
    size,
    offsets,
  };
}

/** Add compressed objects selected by type-2 entries in a real xref stream. */
export function appendObjectStreamRevision(
  previous: IncrementalPdf,
  compressed: Array<{ id: number; body: string }>,
  direct: PdfObject[] = []
): IncrementalPdf {
  const objectStreamId = Math.max(
    previous.size,
    ...direct.map(({ id }) => id + 1)
  );
  const xrefId = objectStreamId + 1;
  let body = "";
  let header = "";
  for (const object of compressed) {
    header += `${object.id} ${Buffer.byteLength(body, "latin1")} `;
    body += `${object.body}\n`;
  }
  const physical = physicalObjects(previous.bytes, [
    ...direct,
    {
      id: objectStreamId,
      body: pdfStream(
        deflateSync(latin(header + body)),
        `/Type /ObjStm /Filter /FlateDecode /N ${compressed.length} /First ${Buffer.byteLength(header, "latin1")}`
      ),
    },
  ]);
  const lastXref = physical.bytes.length;
  const records = new Map<number, [number, number, number]>([
    ...[...physical.offsets].map(
      ([id, offset]): [number, [number, number, number]] => [id, [1, offset, 0]]
    ),
    ...compressed.map(({ id }, index): [number, [number, number, number]] => [
      id,
      [2, objectStreamId, index],
    ]),
    [xrefId, [1, lastXref, 0]],
  ]);
  const sorted = [...records].sort(([a], [b]) => a - b);
  const index = sorted.map(([id]) => `${id} 1`).join(" ");
  const entries = Buffer.alloc(sorted.length * 7);
  for (const [index, [, [type, field2, field3]]] of sorted.entries()) {
    entries[index * 7] = type;
    entries.writeUInt32BE(field2, index * 7 + 1);
    entries.writeUInt16BE(field3, index * 7 + 5);
  }
  // PNG Up predictor, used by PDFs that compress saved-update xref streams.
  const predicted = Buffer.alloc(sorted.length * 8);
  for (let row = 0; row < sorted.length; row++) {
    predicted[row * 8] = 2;
    for (let column = 0; column < 7; column++) {
      const previous = row === 0 ? 0 : entries[(row - 1) * 7 + column];
      predicted[row * 8 + column + 1] = entries[row * 7 + column] - previous;
    }
  }
  const size = xrefId + 1;
  const xrefStream = physicalObjects(physical.bytes, [
    {
      id: xrefId,
      body: pdfStream(
        deflateSync(predicted),
        `/Type /XRef /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Size ${size} /Root 1 0 R /Prev ${previous.lastXref} /W [1 4 2] /Index [${index}]`
      ),
    },
  ]);
  return {
    bytes: Buffer.concat([
      xrefStream.bytes,
      latin(`startxref\n${lastXref}\n%%EOF\n`),
    ]),
    size,
    lastXref,
    offsets: new Map([
      ...previous.offsets,
      ...physical.offsets,
      [xrefId, lastXref],
    ]),
  };
}
