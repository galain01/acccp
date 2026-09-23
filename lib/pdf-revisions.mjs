import { inflateSync } from "node:zlib";

// Build the same selected object graph that the renderer reads. pdf-lib's normal
// loader scans physical definitions in file order, which does not implement
// incremental saves, deleted entries, or cross-reference selection. This loader
// uses its object lexer, but never its document/object-stream scanning loaders.
// It accepts well-formed cross references only: guessing or repairing an offset
// here could inspect different image dimensions from those PDF.js renders.
export function loadPdfWithRevisions(bytes, pdfLib, options = {}) {
  const {
    PDFParser,
    PDFObjectParser,
    PDFContext,
    PDFDocument,
    PDFDict,
    PDFArray,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFRawStream,
    PDFNull,
    decodePDFRawStream,
  } = pdfLib;
  const maxObjects = options.maxObjects ?? 100_000;
  const reject = (code = "pdf_invalid") => {
    if (options.fail) options.fail(code);
    throw Object.assign(new Error("PDF object graph could not be read."), {
      code,
    });
  };
  const invalid = () => reject();
  const complexity = () => reject("pdf_complexity_limit");
  const MAX_STREAM_BYTES = 16 * 1024 * 1024;
  const MAX_DECODED_BYTES = 32 * 1024 * 1024;
  const MAX_REVISIONS = 256;
  const MAX_OBJECT_NUMBER = 2 ** 31 - 1;
  const context = PDFContext.create();
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = (key) => PDFName.of(key);
  const isWhite = (byte) => [0, 9, 10, 12, 13, 32].includes(byte);
  const isBoundary = (byte) =>
    byte === undefined ||
    isWhite(byte) ||
    [37, 40, 41, 47, 60, 62, 91, 93, 123, 125].includes(byte);
  const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
    return value;
  };
  const number = (object, fallback) => {
    if (object === undefined && fallback !== undefined) return fallback;
    if (!(object instanceof PDFNumber)) invalid();
    return integer(object.asNumber());
  };
  const offset = (value) => {
    integer(value, input.length - 1);
    if (!value) invalid();
    return value;
  };
  const match = (parser, token) => {
    const start = parser.bytes.offset();
    for (let i = 0; i < token.length; i++) {
      if (parser.bytes.next() !== token.charCodeAt(i)) {
        parser.bytes.moveTo(start);
        return false;
      }
    }
    if (!isBoundary(parser.bytes.peek())) {
      parser.bytes.moveTo(start);
      return false;
    }
    return true;
  };
  const rawInteger = (parser, maximum = Number.MAX_SAFE_INTEGER) => {
    parser.skipWhitespaceAndComments();
    const value = integer(parser.parseRawInt(), maximum);
    if (!isBoundary(parser.bytes.peek())) invalid();
    return value;
  };
  let parsedNodes = 0;
  let decodedBytes = 0;
  const selected = new Map();
  const loading = new Set();
  const objectStreams = new Map();
  let resolve;

  function makeParser(data, indirect, allowStreams = true) {
    const parser = indirect
      ? PDFParser.forBytesWithOptions(data, Infinity, true)
      : PDFObjectParser.forBytes(data, context);
    parser.context = context;
    let depth = 0;
    const parseObject = parser.parseObject;
    parser.parseObject = function () {
      if (++depth > 128 || ++parsedNodes > maxObjects * 16) complexity();
      try {
        return parseObject.call(this);
      } finally {
        depth--;
      }
    };
    // /Length may be indirect, so resolve it through the selected graph. Never
    // use pdf-lib's fallback search for an endstream token inside binary data.
    parser.parseDictOrStream = function () {
      const dict = this.parseDict();
      this.skipWhitespaceAndComments();
      if (!match(this, "stream")) return dict;
      if (!allowStreams) invalid();
      while ([9, 32].includes(this.bytes.peek())) this.bytes.next();
      if (this.bytes.peek() === 13) {
        this.bytes.next();
        if (this.bytes.peek() === 10) this.bytes.next();
      } else if (this.bytes.peek() === 10) this.bytes.next();
      else invalid();
      let length = dict.get(name("Length"));
      if (length instanceof PDFRef) {
        if (!resolve) invalid();
        length = resolve(length);
      }
      const size = number(length);
      const start = this.bytes.offset();
      const end = start + size;
      if (!Number.isSafeInteger(end) || end > data.length) invalid();
      this.bytes.moveTo(end);
      this.skipWhitespace();
      if (!match(this, "endstream")) invalid();
      return PDFRawStream.of(dict, data.subarray(start, end));
    };
    return parser;
  }

  function indirectAt(position, expected) {
    const parser = makeParser(input, true);
    parser.bytes.moveTo(offset(position));
    const ref = parser.parseIndirectObjectHeader();
    integer(ref.objectNumber, MAX_OBJECT_NUMBER);
    integer(ref.generationNumber, 65535);
    if (!ref.objectNumber || !isBoundary(parser.bytes.peek())) invalid();
    if (
      expected &&
      (expected.objectNumber !== ref.objectNumber ||
        expected.generationNumber !== ref.generationNumber)
    )
      invalid();
    const object = parser.parseObject();
    parser.skipWhitespaceAndComments();
    if (!match(parser, "endobj")) invalid();
    return { ref, object };
  }

  function getDirect(object) {
    return object instanceof PDFRef
      ? resolve
        ? resolve(object)
        : invalid()
      : object;
  }

  function applyPredictor(data, parameters) {
    if (parameters === undefined || parameters === PDFNull) return data;
    if (!(parameters instanceof PDFDict)) invalid();
    const predictor = number(getDirect(parameters.get(name("Predictor"))), 1);
    if (predictor === 1) return data;
    const colors = number(getDirect(parameters.get(name("Colors"))), 1);
    const bits = number(getDirect(parameters.get(name("BitsPerComponent"))), 8);
    const columns = number(getDirect(parameters.get(name("Columns"))), 1);
    if (!colors || !columns || ![1, 2, 4, 8, 16].includes(bits)) invalid();
    const samples = colors * columns;
    const rowBytes = Math.ceil((samples * bits) / 8);
    const pixelBytes = Math.ceil((colors * bits) / 8);
    if (!Number.isSafeInteger(rowBytes) || rowBytes > MAX_STREAM_BYTES)
      complexity();
    if (predictor === 2) {
      if (data.length % rowBytes !== 0) invalid();
      const out = Uint8Array.from(data);
      const mask = 2 ** bits - 1;
      // TIFF differences are per component (including packed 1/2/4-bit data).
      for (let row = 0; row < out.length; row += rowBytes) {
        for (let sample = 0; sample < samples; sample++) {
          const bit = sample * bits;
          const byte = row + Math.floor(bit / 8);
          const shift = 8 - bits - (bit % 8);
          let value =
            bits === 16
              ? out[byte] * 256 + out[byte + 1]
              : (out[byte] >>> shift) & mask;
          if (sample >= colors) {
            const priorBit = (sample - colors) * bits;
            const priorByte = row + Math.floor(priorBit / 8);
            const priorValue =
              bits === 16
                ? out[priorByte] * 256 + out[priorByte + 1]
                : (out[priorByte] >>> (8 - bits - (priorBit % 8))) & mask;
            value = (value + priorValue) & mask;
          }
          if (bits === 16) {
            out[byte] = value >>> 8;
            out[byte + 1] = value & 255;
          } else out[byte] = (out[byte] & ~(mask << shift)) | (value << shift);
        }
      }
      return out;
    }
    if (predictor < 10 || predictor > 15 || data.length % (rowBytes + 1) !== 0)
      invalid();
    const rows = data.length / (rowBytes + 1);
    const out = new Uint8Array(rows * rowBytes);
    for (let row = 0; row < rows; row++) {
      const inputStart = row * (rowBytes + 1);
      const type = data[inputStart];
      if (type > 4) invalid();
      for (let column = 0; column < rowBytes; column++) {
        const index = row * rowBytes + column;
        const left = column >= pixelBytes ? out[index - pixelBytes] : 0;
        const above = row ? out[index - rowBytes] : 0;
        const upperLeft =
          row && column >= pixelBytes ? out[index - rowBytes - pixelBytes] : 0;
        let prediction = 0;
        if (type === 1) prediction = left;
        if (type === 2) prediction = above;
        if (type === 3) prediction = Math.floor((left + above) / 2);
        if (type === 4) {
          const p = left + above - upperLeft;
          const a = Math.abs(p - left),
            b = Math.abs(p - above),
            c = Math.abs(p - upperLeft);
          prediction = a <= b && a <= c ? left : b <= c ? above : upperLeft;
        }
        out[index] = (data[inputStart + 1 + column] + prediction) & 255;
      }
    }
    return out;
  }

  function decode(stream) {
    let data = stream.contents;
    const filter = getDirect(stream.dict.get(name("Filter")));
    const params = getDirect(stream.dict.get(name("DecodeParms")));
    const filters =
      filter instanceof PDFArray
        ? filter.asArray().map(getDirect)
        : filter && filter !== PDFNull
          ? [filter]
          : [];
    if (filters.length > 8) complexity();
    const parameters =
      params instanceof PDFArray ? params.asArray().map(getDirect) : [params];
    for (let index = 0; index < filters.length; index++) {
      const encoding = filters[index];
      if (!(encoding instanceof PDFName)) invalid();
      const parameter = parameters[index];
      if (encoding === name("FlateDecode") || encoding === name("Fl")) {
        try {
          data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
        } catch (error) {
          if (error?.code === "ERR_BUFFER_TOO_LARGE") complexity();
          throw error;
        }
      } else {
        const dict = PDFDict.withContext(context);
        dict.set(name("Filter"), encoding);
        if (parameter && parameter !== PDFNull)
          dict.set(name("DecodeParms"), parameter);
        const decoder = decodePDFRawStream(PDFRawStream.of(dict, data));
        // Guard allocation inside each decode stage; reading cap+1 bytes alone
        // does not cap a decoder that expands an entire compressed block.
        const ensure = decoder.ensureBuffer;
        if (ensure)
          decoder.ensureBuffer = function (size) {
            if (!Number.isSafeInteger(size) || size > MAX_STREAM_BYTES)
              complexity();
            return ensure.call(this, size);
          };
        data = decoder.decode();
      }
      if (data.length > MAX_STREAM_BYTES) complexity();
      if (
        [name("FlateDecode"), name("Fl"), name("LZWDecode")].includes(encoding)
      )
        data = applyPredictor(data, parameter);
      decodedBytes += data.length;
      if (decodedBytes > MAX_DECODED_BYTES) complexity();
    }
    if (!filters.length) {
      decodedBytes += data.length;
      if (data.length > MAX_STREAM_BYTES || decodedBytes > MAX_DECODED_BYTES)
        complexity();
    }
    return data;
  }

  let seenEntries = 0;
  function addEntry(entries, id, type, field2, field3) {
    integer(id, MAX_OBJECT_NUMBER);
    if (++seenEntries > maxObjects * 4) complexity();
    if (entries.has(id)) invalid();
    if (type === 0) {
      integer(field2, MAX_OBJECT_NUMBER);
      integer(field3, 65535);
    } else if (type === 1) {
      offset(field2);
      integer(field3, 65535);
    } else if (type === 2) {
      integer(field2, MAX_OBJECT_NUMBER);
      integer(field3, maxObjects - 1);
      if (!field2) invalid();
    } else invalid();
    if (id === 0 && type !== 0) invalid();
    entries.set(id, { type, field2, field3 });
  }

  function readSection(position) {
    const parser = makeParser(input, true);
    parser.bytes.moveTo(offset(position));
    parser.skipWhitespaceAndComments();
    const entries = new Map();
    if (match(parser, "xref")) {
      for (;;) {
        parser.skipWhitespaceAndComments();
        if (match(parser, "trailer")) break;
        const first = rawInteger(parser, MAX_OBJECT_NUMBER);
        const count = rawInteger(parser, maxObjects * 4);
        if (!count || first + count > MAX_OBJECT_NUMBER) invalid();
        for (let i = 0; i < count; i++) {
          const field2 = rawInteger(parser);
          const field3 = rawInteger(parser, 65535);
          parser.skipWhitespaceAndComments();
          const type = match(parser, "n")
            ? 1
            : match(parser, "f")
              ? 0
              : invalid();
          addEntry(entries, first + i, type, field2, field3);
        }
      }
      const trailer = parser.parseObject();
      if (!(trailer instanceof PDFDict)) invalid();
      return { entries, trailer };
    }
    const { object } = indirectAt(position);
    if (
      !(object instanceof PDFRawStream) ||
      object.dict.get(name("Type")) !== name("XRef")
    )
      invalid();
    const trailer = object.dict;
    const widths = trailer.get(name("W"));
    if (!(widths instanceof PDFArray) || widths.size() !== 3) invalid();
    const sizes = widths.asArray().map((value) => integer(number(value), 8));
    const rowSize = sizes.reduce((sum, value) => sum + value, 0);
    if (!rowSize) invalid();
    const size = integer(number(trailer.get(name("Size"))), MAX_OBJECT_NUMBER);
    const index = trailer.get(name("Index"));
    const ranges =
      index === undefined
        ? [0, size]
        : index instanceof PDFArray
          ? index.asArray().map((value) => number(value))
          : invalid();
    if (!ranges.length || ranges.length % 2) invalid();
    let rows = 0;
    for (let i = 0; i < ranges.length; i += 2) {
      integer(ranges[i], MAX_OBJECT_NUMBER);
      integer(ranges[i + 1], maxObjects * 4);
      if (ranges[i] + ranges[i + 1] > size) invalid();
      rows += ranges[i + 1];
      if (rows > maxObjects * 4) complexity();
    }
    const data = decode(object);
    if (data.length !== rows * rowSize) invalid();
    let cursor = 0;
    const read = (width, defaultValue) => {
      if (!width) return defaultValue;
      let result = 0;
      for (let i = 0; i < width; i++) result = result * 256 + data[cursor++];
      return integer(result);
    };
    for (let i = 0; i < ranges.length; i += 2) {
      for (let j = 0; j < ranges[i + 1]; j++) {
        addEntry(
          entries,
          ranges[i] + j,
          read(sizes[0], 1),
          read(sizes[1], 0),
          read(sizes[2], 0)
        );
      }
    }
    return { entries, trailer };
  }

  function readLinearization() {
    // Match PDF.js's optional first-object recognition. An outdated /L after an
    // incremental save disables linearization; it does not invalidate the PDF.
    const parser = makeParser(input, true, false);
    let dict;
    try {
      parser.parseIndirectObjectHeader();
      parser.skipWhitespaceAndComments();
      if (parser.bytes.peek() !== 60 || parser.bytes.peekAhead(1) !== 60)
        return;
      dict = parser.parseDict();
    } catch (error) {
      if (error?.code) throw error;
      return;
    }
    const marker = dict.get(name("Linearized"));
    if (!(marker instanceof PDFNumber) || !(marker.asNumber() > 0)) return;
    const positive = (key, allowZero = false) => {
      const object = dict.get(name(key));
      if (!(object instanceof PDFNumber)) return;
      const value = object.asNumber();
      return Number.isInteger(value) && (allowZero ? value >= 0 : value > 0)
        ? value
        : undefined;
    };
    if (positive("L") !== input.length) return;
    const hints = dict.get(name("H"));
    if (
      !(hints instanceof PDFArray) ||
      ![2, 4].includes(hints.size()) ||
      hints
        .asArray()
        .some(
          (value) =>
            !(value instanceof PDFNumber) ||
            !Number.isInteger(value.asNumber()) ||
            value.asNumber() <= 0
        )
    )
      return;
    const objectNumberFirst = positive("O");
    const numPages = positive("N");
    const pageFirst = dict.has(name("P")) ? positive("P", true) : 0;
    if (
      objectNumberFirst === undefined ||
      numPages === undefined ||
      pageFirst === undefined ||
      positive("E") === undefined ||
      positive("T") === undefined
    )
      return;
    // PDF.js recognizes integers beyond JS's safe range. Reject that recognized
    // form rather than silently switching it to the final-directory algorithm.
    if (
      [
        objectNumberFirst,
        numPages,
        pageFirst,
        positive("E"),
        positive("T"),
        ...hints.asArray().map((value) => value.asNumber()),
      ].some((value) => !Number.isSafeInteger(value))
    )
      invalid();
    let start = input.indexOf(Buffer.from("endobj"));
    if (start < 0 || start > 1024 - 6) invalid();
    start += 6;
    while (isWhite(input[start])) start++;
    return { start, objectNumberFirst, numPages, pageFirst };
  }

  try {
    if (!input.subarray(0, 5).equals(Buffer.from("%PDF-"))) invalid();
    // Require a final directory, not a scan/recovery of apparently valid objects.
    const tail = input
      .subarray(Math.max(0, input.length - 2048))
      .toString("latin1");
    const ending =
      /startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/.exec(
        tail
      );
    if (!ending) invalid();
    const linearization = readLinearization();
    const queue = [offset(linearization?.start ?? Number(ending[1]))];
    const seenSections = new Set();
    const sectionLinks = new Map();
    let latestTrailer;
    // PDF.js uses FIFO traversal: current section, hybrid XRefStm, then Prev.
    // First-seen entries win by object number, including deletions. Prev offsets
    // can point forwards in linearized PDFs, so do not assume decreasing offsets.
    for (let q = 0; q < queue.length; q++) {
      const position = queue[q];
      if (seenSections.has(position)) continue;
      if (seenSections.size >= MAX_REVISIONS) complexity();
      seenSections.add(position);
      const { entries, trailer } = readSection(position);
      latestTrailer ??= trailer;
      const encryption = latestTrailer.get(name("Encrypt"));
      if (encryption !== undefined && encryption !== PDFNull)
        reject("pdf_password");
      for (const [id, entry] of entries) {
        if (!selected.has(id)) selected.set(id, entry);
        if (selected.size > maxObjects) complexity();
      }
      for (const key of ["XRefStm", "Prev"]) {
        const value = trailer.get(name(key));
        if (value !== undefined && value !== PDFNull) {
          const next = offset(number(value));
          queue.push(next);
          const links = sectionLinks.get(position) ?? [];
          links.push(next);
          sectionLinks.set(position, links);
        }
      }
    }
    // Convergent hybrid links are valid; an actual cycle has no older revision
    // boundary and cannot establish a trustworthy selected graph.
    const active = new Set(),
      complete = new Set();
    const checkAcyclic = (position) => {
      if (active.has(position)) invalid();
      if (complete.has(position)) return;
      active.add(position);
      for (const next of sectionLinks.get(position) ?? []) checkAcyclic(next);
      active.delete(position);
      complete.add(position);
    };
    checkAcyclic(queue[0]);
    if (!latestTrailer) invalid();
    for (const key of ["Root", "Encrypt", "Info", "ID"])
      context.trailerInfo[key] = latestTrailer.get(name(key));

    function streamObjects(id) {
      if (objectStreams.has(id)) return objectStreams.get(id);
      const entry = selected.get(id);
      if (!entry || entry.type !== 1 || entry.field3 !== 0) invalid();
      const stream = resolve(PDFRef.of(id, 0));
      if (
        !(stream instanceof PDFRawStream) ||
        stream.dict.get(name("Type")) !== name("ObjStm")
      )
        invalid();
      const count = integer(
        number(getDirect(stream.dict.get(name("N")))),
        maxObjects
      );
      const first = number(getDirect(stream.dict.get(name("First"))));
      const data = decode(stream);
      if (!count || first > data.length) invalid();
      const parser = makeParser(data.subarray(0, first), false, false);
      const parts = [];
      const ids = new Set();
      for (let i = 0; i < count; i++) {
        const objectNumber = rawInteger(parser, MAX_OBJECT_NUMBER);
        const relative = rawInteger(parser);
        if (
          !objectNumber ||
          ids.has(objectNumber) ||
          first + relative >= data.length ||
          (i && relative <= parts[i - 1].relative)
        )
          invalid();
        ids.add(objectNumber);
        parts.push({ objectNumber, relative });
      }
      parser.skipWhitespaceAndComments();
      if (!parser.bytes.done()) invalid();
      const result = { data, first, parts };
      objectStreams.set(id, result);
      return result;
    }

    resolve = (ref) => {
      if (!(ref instanceof PDFRef)) return ref;
      const existing = context.lookup(ref);
      if (existing !== undefined) return existing;
      const entry = selected.get(ref.objectNumber);
      if (!entry || entry.type === 0) return undefined;
      const generation = entry.type === 2 ? 0 : entry.field3;
      if (ref.generationNumber !== generation) invalid();
      if (loading.has(ref.objectNumber)) invalid();
      loading.add(ref.objectNumber);
      let object;
      try {
        if (entry.type === 1) object = indirectAt(entry.field2, ref).object;
        else {
          const { data, first, parts } = streamObjects(entry.field2);
          const part = parts[entry.field3];
          if (!part || part.objectNumber !== ref.objectNumber) invalid();
          const end =
            entry.field3 + 1 < parts.length
              ? first + parts[entry.field3 + 1].relative
              : data.length;
          const parser = makeParser(
            data.subarray(first + part.relative, end),
            false,
            false
          );
          object = parser.parseObject();
          parser.skipWhitespaceAndComments();
          if (!parser.bytes.done() || object instanceof PDFRef) invalid();
        }
        context.assign(ref, object);
        return object;
      } finally {
        loading.delete(ref.objectNumber);
      }
    };
    for (const [id, entry] of selected) {
      if (entry.type !== 0)
        resolve(PDFRef.of(id, entry.type === 2 ? 0 : entry.field3));
    }
    const root = context.trailerInfo.Root;
    if (!(root instanceof PDFRef)) invalid();
    const catalog = resolve(root);
    if (
      !(catalog instanceof PDFDict) ||
      catalog.get(name("Type")) !== name("Catalog")
    )
      invalid();
    const document = new PDFDocument(context, true, false);
    if (linearization) {
      const pages = document.getPages();
      const first = pages[linearization.pageFirst];
      if (
        pages.length !== linearization.numPages ||
        !first ||
        first.ref.objectNumber !== linearization.objectNumberFirst ||
        first.ref.generationNumber !== 0
      )
        invalid();
    }
    return document;
  } catch (error) {
    if (
      ["pdf_invalid", "pdf_complexity_limit", "pdf_password"].includes(
        error?.code
      )
    )
      throw error;
    invalid();
  }
}
