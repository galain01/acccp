import { inflateSync } from "node:zlib";

// This is a deliberately narrow content interpreter, not a second PDF renderer.
// When its interpretation could differ from PDF.js, the caller must use the
// original full-resource-graph guard for the WHOLE page. Never use a partial Set.
const LIMITS = Object.freeze({
  maxStreamBytes: 8 * 1024 * 1024,
  maxDecodedBytes: 32 * 1024 * 1024,
  maxTokens: 1_000_000,
  maxOperations: 250_000,
  maxDepth: 32,
  maxObjects: 100_000,
});
class ConservativeFallback extends Error {}
const fallback = () => {
  throw new ConservativeFallback(
    "PDF image usage requires conservative checking."
  );
};
const white = (byte) => [0, 9, 10, 12, 13, 32].includes(byte);
const delimiter = (byte) =>
  byte === undefined ||
  white(byte) ||
  "()<>[]{}/%".includes(String.fromCharCode(byte));
const hex = (byte) =>
  (byte >= 48 && byte <= 57) ||
  (byte >= 65 && byte <= 70) ||
  (byte >= 97 && byte <= 102);

// Exact arities prevent PDF.js's surplus-operand recovery from interpreting a
// later Do with an operand this inspector already discarded. Unknown commands,
// including concatenated operators and inline-image BI, fall back completely.
const NUMERIC_ARITIES = new Map([
  ...[
    "w",
    "J",
    "j",
    "M",
    "i",
    "Tc",
    "Tw",
    "Tz",
    "TL",
    "Tr",
    "Ts",
    "G",
    "g",
  ].map((op) => [op, 1]),
  ...["m", "l", "Td", "TD", "d0"].map((op) => [op, 2]),
  ...["RG", "rg"].map((op) => [op, 3]),
  ...["v", "y", "re", "K", "k"].map((op) => [op, 4]),
  ...["cm", "c", "Tm", "d1"].map((op) => [op, 6]),
]);
const ZERO_ARITIES = new Set([
  "q",
  "Q",
  "h",
  "S",
  "s",
  "f",
  "F",
  "f*",
  "B",
  "B*",
  "b",
  "b*",
  "n",
  "W",
  "W*",
  "BT",
  "ET",
  "T*",
  "EMC",
  "BX",
  "EX",
]);

function tokenize(bytes, budget, maxDepth) {
  let offset = 0;
  const skip = () => {
    while (offset < bytes.length) {
      if (white(bytes[offset])) offset++;
      else if (bytes[offset] === 37) {
        while (offset < bytes.length && ![10, 13].includes(bytes[offset]))
          offset++;
      } else break;
    }
  };
  const token = (depth = 0) => {
    if (depth > maxDepth || --budget.tokens < 0) fallback();
    skip();
    if (offset >= bytes.length) return null;
    const start = offset;
    const byte = bytes[offset++];
    if (byte === 47) {
      while (!delimiter(bytes[offset])) {
        // pdf-lib and PDF.js differ on some escaped-name spellings. Do not
        // decide which resource was selected when that ambiguity is present.
        if (bytes[offset] === 35 || bytes[offset] < 33 || bytes[offset] > 126)
          fallback();
        if (offset - start > 256) fallback();
        offset++;
      }
      return {
        type: "name",
        value: bytes.subarray(start + 1, offset).toString("latin1"),
      };
    }
    if (byte === 40) {
      let nesting = 1;
      while (offset < bytes.length && nesting) {
        const next = bytes[offset++];
        if (next === 92) {
          if (offset >= bytes.length) fallback();
          // Escaped delimiters, octal digits, and line continuations cannot
          // terminate the string. The remaining octal digits are plain data.
          const escaped = bytes[offset++];
          if (escaped === 13 && bytes[offset] === 10) offset++;
        } else if (next === 40) {
          if (++nesting > maxDepth) fallback();
        } else if (next === 41) nesting--;
      }
      if (nesting) fallback();
      return { type: "string" };
    }
    if (byte === 60 && bytes[offset] !== 60) {
      while (offset < bytes.length && bytes[offset] !== 62) {
        if (!white(bytes[offset]) && !hex(bytes[offset])) fallback();
        offset++;
      }
      if (bytes[offset++] !== 62) fallback();
      return { type: "string" };
    }
    if (byte === 91) {
      const values = [];
      while (true) {
        skip();
        if (bytes[offset] === 93) {
          offset++;
          return { type: "array", values };
        }
        const item = token(depth + 1);
        if (!item || item.type === "operator") fallback();
        values.push(item);
      }
    }
    if (byte === 60 && bytes[offset] === 60) {
      offset++;
      while (true) {
        skip();
        if (bytes[offset] === 62 && bytes[offset + 1] === 62) {
          offset += 2;
          return { type: "dictionary" };
        }
        const key = token(depth + 1);
        if (key?.type !== "name") fallback();
        const value = token(depth + 1);
        if (!value || value.type === "operator") fallback();
      }
    }
    if (delimiter(byte)) fallback();
    while (!delimiter(bytes[offset])) {
      if (offset - start > 256 || bytes[offset] < 33 || bytes[offset] > 126)
        fallback();
      offset++;
    }
    const value = bytes.subarray(start, offset).toString("latin1");
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
      if (!Number.isFinite(Number(value))) fallback();
      return { type: "number" };
    }
    if (["true", "false", "null"].includes(value)) return { type: "scalar" };
    return { type: "operator", value };
  };
  return () => token();
}

/**
 * images contains original pdf-lib stream identities, including used image
 * masks. precise=false means the caller MUST traverse the entire original page
 * resource graph instead; the returned Set is then empty, never partial.
 * This inspector does not enforce image dimensions/areas or decode image data.
 */
export function createPdfImageUsageInspector(document, pdfLib, options = {}) {
  const { PDFDict, PDFArray, PDFName, PDFRawStream, PDFNull } = pdfLib;
  const bounds = Object.fromEntries(
    Object.entries(LIMITS).map(([key, value]) => {
      const configured = options[key];
      return [
        key,
        Number.isSafeInteger(configured) && configured > 0
          ? Math.min(configured, value)
          : value,
      ];
    })
  );
  const name = (key) => PDFName.of(key);
  const resolve = (object) => document.context.lookup(object);
  const lookup = (dict, key) => resolve(dict?.get(name(key)));
  const missing = (object) => object === undefined || object === PDFNull;
  const decoded = new Map();
  // These budgets belong to the whole document, not each page or invocation.
  // Caching prevents a shared stream from being repeatedly inflated.
  const budget = {
    tokens: bounds.maxTokens,
    operations: bounds.maxOperations,
    decodedBytes: 0,
    objects: 0,
  };
  const countObject = () => {
    if (++budget.objects > bounds.maxObjects) fallback();
  };
  const decode = (stream) => {
    if (!(stream instanceof PDFRawStream)) fallback();
    if (decoded.has(stream)) {
      const value = decoded.get(stream);
      if (!value) fallback();
      return value;
    }
    decoded.set(stream, null);
    countObject();
    let data = stream.contents;
    if (data.length > bounds.maxStreamBytes) fallback();
    let filters = lookup(stream.dict, "Filter");
    const parameters = lookup(stream.dict, "DecodeParms");
    // Predictors and unusual filter chains stay with the original conservative
    // guard. A tiny compressed stream must not allocate an unbounded buffer.
    if (!missing(parameters)) fallback();
    filters =
      filters instanceof PDFArray
        ? filters.asArray().map(resolve)
        : missing(filters)
          ? []
          : [filters];
    if (filters.length > 1) fallback();
    if (filters.length) {
      if (![name("FlateDecode"), name("Fl")].includes(filters[0])) fallback();
      const available = Math.min(
        bounds.maxStreamBytes,
        bounds.maxDecodedBytes - budget.decodedBytes
      );
      if (available <= 0) fallback();
      try {
        data = inflateSync(data, { maxOutputLength: available });
      } catch {
        fallback();
      }
    }
    if (
      data.length > bounds.maxStreamBytes ||
      budget.decodedBytes + data.length > bounds.maxDecodedBytes
    )
      fallback();
    budget.decodedBytes += data.length;
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    decoded.set(stream, bytes);
    return bytes;
  };

  function inheritedResources(page) {
    let ancestor = page.node;
    const seen = new Set();
    let found;
    while (ancestor instanceof PDFDict) {
      if (seen.has(ancestor) || seen.size >= bounds.maxDepth) fallback();
      seen.add(ancestor);
      const resources = lookup(ancestor, "Resources");
      if (!missing(resources)) {
        if (!(resources instanceof PDFDict)) fallback();
        // PDF.js can merge different resource categories across ancestors. The
        // caller's conservative ancestor traversal handles that combination.
        // LibreOffice repeats the identical dictionary on the leaf and parent.
        // Merging an object with itself cannot add or replace any category.
        if (found && found !== resources) fallback();
        found = resources;
      }
      ancestor = lookup(ancestor, "Parent");
    }
    return found;
  }

  function inspectPage(page) {
    const images = new Set();
    const active = new Map();
    const completed = new Map();
    const resourcesByName = new Map();
    try {
      const rootResources = inheritedResources(page);
      const annotations = lookup(page.node, "Annots");
      if (!missing(annotations)) {
        if (!(annotations instanceof PDFArray)) fallback();
        for (const item of annotations.asArray()) {
          const annotation = resolve(item);
          if (!(annotation instanceof PDFDict)) fallback();
          // All N/R/D appearance states remain subject to the prior conservative
          // walk, including hidden/inactive appearances and their nested masks.
          if (!missing(lookup(annotation, "AP"))) fallback();
          // Widgets and free-text annotations can synthesize appearances from
          // inherited fonts/resources even without a saved AP stream.
          if (lookup(annotation, "Subtype") !== name("Link")) fallback();
        }
      }

      const resource = (resources, category, selected) => {
        if (!(resources instanceof PDFDict) || selected?.type !== "name")
          fallback();
        const dictionary = lookup(resources, category);
        if (!(dictionary instanceof PDFDict)) fallback();
        let byName = resourcesByName.get(dictionary);
        if (!byName) {
          byName = new Map();
          for (const [key, value] of dictionary.entries()) {
            countObject();
            // Avoid escaped-name parser differences even in dictionary keys.
            if (key.asString().includes("#")) fallback();
            const text = key.decodeText();
            if (byName.has(text)) fallback();
            byName.set(text, value);
          }
          resourcesByName.set(dictionary, byName);
        }
        const object = resolve(byName.get(selected.value));
        if (!object) fallback();
        return object;
      };

      const addImage = (stream, depth = 0) => {
        if (!(stream instanceof PDFRawStream) || depth > bounds.maxDepth)
          fallback();
        if (images.has(stream)) return;
        countObject();
        images.add(stream);
        for (const key of ["SMask", "Mask"]) {
          const mask = lookup(stream.dict, key);
          if (mask instanceof PDFRawStream) addImage(mask, depth + 1);
          else if (
            !missing(mask) &&
            !(mask instanceof PDFArray) &&
            mask !== name("None")
          )
            fallback();
        }
      };

      const checkFont = (font) => {
        if (!(font instanceof PDFDict)) fallback();
        if (
          lookup(font, "Subtype") === name("Type3") ||
          !missing(lookup(font, "Resources")) ||
          !missing(lookup(font, "CharProcs"))
        )
          fallback();
        if (
          ![
            "Type0",
            "Type1",
            "MMType1",
            "TrueType",
            "CIDFontType0",
            "CIDFontType2",
          ].some((kind) => lookup(font, "Subtype") === name(kind))
        )
          fallback();
      };

      const contentsBytes = (contents) => {
        contents = resolve(contents);
        if (missing(contents)) return Buffer.alloc(0);
        const streams =
          contents instanceof PDFArray
            ? contents.asArray().map(resolve)
            : [contents];
        if (streams.length > bounds.maxObjects) fallback();
        let size = 0;
        const chunks = streams.map((stream) => {
          const bytes = decode(stream);
          size += bytes.length;
          if (size > bounds.maxStreamBytes) fallback();
          return bytes;
        });
        // PDF.js's StreamsSequenceStream concatenates bytes exactly. Inserting
        // whitespace could hide an operator or resource name split across streams.
        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      };

      const inspectContent = (contents, resources, depth) => {
        if (depth > bounds.maxDepth) fallback();
        const next = tokenize(contentsBytes(contents), budget, bounds.maxDepth);
        let operands = [];
        for (let item; (item = next()); ) {
          if (item.type !== "operator") {
            operands.push(item);
            if (operands.length > 33) fallback();
            continue;
          }
          if (--budget.operations < 0) fallback();
          const op = item.value;
          const exact = (...types) => {
            if (
              operands.length !== types.length ||
              types.some((type, index) => operands[index].type !== type)
            )
              fallback();
          };
          if (NUMERIC_ARITIES.has(op)) {
            exact(...Array(NUMERIC_ARITIES.get(op)).fill("number"));
          } else if (ZERO_ARITIES.has(op)) exact();
          else if (op === "Do") {
            exact("name");
            const object = resource(resources, "XObject", operands[0]);
            if (!(object instanceof PDFRawStream)) fallback();
            const subtype = lookup(object.dict, "Subtype");
            if (subtype === name("Image")) addImage(object);
            else if (subtype === name("Form")) {
              const ownResources = lookup(object.dict, "Resources");
              if (!missing(ownResources) && !(ownResources instanceof PDFDict))
                fallback();
              const effective = missing(ownResources)
                ? resources
                : ownResources;
              let done = completed.get(object);
              if (!done?.has(effective)) {
                let visiting = active.get(object);
                if (visiting?.has(effective)) fallback();
                if (!visiting) active.set(object, (visiting = new Set()));
                visiting.add(effective);
                inspectContent(object, effective, depth + 1);
                visiting.delete(effective);
                if (!done) completed.set(object, (done = new Set()));
                done.add(effective);
              }
            } else fallback();
          } else if (op === "Tf") {
            exact("name", "number");
            checkFont(resource(resources, "Font", operands[0]));
          } else if (op === "gs") {
            exact("name");
            const state = resource(resources, "ExtGState", operands[0]);
            if (!(state instanceof PDFDict)) fallback();
            const mask = lookup(state, "SMask");
            if (
              (!missing(mask) && mask !== name("None")) ||
              !missing(lookup(state, "Font"))
            )
              fallback();
          } else if (["SC", "sc", "SCN", "scn"].includes(op)) {
            const maximum = op.endsWith("N") || op.endsWith("n") ? 33 : 4;
            // Named patterns merge local and caller resources. Preserve the full
            // existing guard instead of guessing which pattern content is used.
            if (
              operands.length > maximum ||
              operands.some((v) => v.type !== "number")
            )
              fallback();
          } else if (["CS", "cs", "sh", "ri", "MP", "BMC"].includes(op))
            exact("name");
          else if (["Tj", "'"].includes(op)) exact("string");
          else if (op === '"') exact("number", "number", "string");
          else if (op === "TJ") {
            exact("array");
            if (
              operands[0].values.some(
                (v) => !["number", "string"].includes(v.type)
              )
            )
              fallback();
          } else if (op === "d") {
            exact("array", "number");
            if (operands[0].values.some((v) => v.type !== "number")) fallback();
          } else if (["DP", "BDC"].includes(op)) {
            if (
              operands.length !== 2 ||
              operands[0].type !== "name" ||
              !["name", "dictionary"].includes(operands[1].type)
            )
              fallback();
          } else fallback();
          operands = [];
        }
        if (operands.length) fallback();
      };

      inspectContent(page.node.get(name("Contents")), rootResources, 0);
      return { precise: true, images };
    } catch {
      // Unexpected object/lexer failures are conservative too, with no source
      // content or library exception strings leaving this boundary.
      return { precise: false, images: new Set() };
    }
  }
  return { inspectPage };
}
