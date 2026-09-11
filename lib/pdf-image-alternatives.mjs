// Metadata is untrusted document content. Keep extraction bounded, preserve the
// authored string exactly, and never infer image identity from structure order.
const MAX_FIGURES_PAGE = 100;
const MAX_FIGURES_DOCUMENT = 500;
const MAX_ALT_CHARACTERS = 8_000;
const MAX_CHARACTERS_PAGE = 32_000;
const MAX_CHARACTERS_DOCUMENT = 128_000;
const MAX_NODES_PAGE = 10_000;
const MAX_DEPTH = 64;
const MAX_OPERATIONS_PAGE = 50_000;
const MAX_OPERATIONS_DOCUMENT = 200_000;

export function inspectImageAlternativeStructure(document, pdf) {
  const unavailable = { available: false, allowBounds: false };
  const {
    PDFDict,
    PDFArray,
    PDFName,
    PDFNumber,
    PDFString,
    PDFHexString,
    PDFRef,
  } = pdf;
  const name = PDFName.of;
  const lookup = (object) => document.context.lookup(object);
  const value = (dict, key) => lookup(dict.get(name(key)));
  const integer = (object) => {
    const number = object instanceof PDFNumber ? object.asNumber() : NaN;
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  };
  try {
    const rootValue = document.catalog.get(name("StructTreeRoot"));
    if (rootValue === undefined) return { available: true, allowBounds: true };
    const root = lookup(rootValue);
    if (!(root instanceof PDFDict)) return unavailable;
    const parentRoot = value(root, "ParentTree");
    if (!(parentRoot instanceof PDFDict)) return unavailable;

    // getStructTree() can silently return an empty/partial tree if ParentTree is
    // absent or omits an entry. Validate the raw number tree and each referenced
    // content item's inverse owner link before treating that result as complete.
    const parents = new Map();
    const numberPending = [{ node: parentRoot, depth: 0 }];
    const numberVisited = new Set();
    let inspected = 0;
    let previousKey = -1;
    while (numberPending.length) {
      const { node, depth } = numberPending.pop();
      if (
        !(node instanceof PDFDict) ||
        numberVisited.has(node) ||
        depth > MAX_DEPTH ||
        ++inspected > MAX_NODES_PAGE
      )
        return unavailable;
      numberVisited.add(node);
      const nums = value(node, "Nums");
      const kids = value(node, "Kids");
      if (nums !== undefined && kids !== undefined) return unavailable;
      if (nums instanceof PDFArray) {
        if (nums.size() % 2 || inspected + nums.size() > MAX_NODES_PAGE)
          return unavailable;
        inspected += nums.size();
        for (let index = 0; index < nums.size(); index += 2) {
          const key = integer(lookup(nums.get(index)));
          const parent = lookup(nums.get(index + 1));
          if (
            key === null ||
            key <= previousKey ||
            parents.has(key) ||
            !(parent instanceof PDFArray || parent instanceof PDFDict) ||
            (parent instanceof PDFArray && parent.size() > MAX_NODES_PAGE)
          )
            return unavailable;
          previousKey = key;
          parents.set(key, parent);
        }
      } else if (kids instanceof PDFArray) {
        if (inspected + numberPending.length + kids.size() > MAX_NODES_PAGE)
          return unavailable;
        for (let index = kids.size() - 1; index >= 0; index--)
          numberPending.push({
            node: lookup(kids.get(index)),
            depth: depth + 1,
          });
      } else return unavailable;
    }

    const orderedPages = document.getPages().map((page) => page.node);
    const pageNodes = new Set(orderedPages);
    const authoredFigurePages = new Map();
    const roles = value(root, "RoleMap");
    let allowBounds = true;
    const pending = [
      {
        node: value(root, "K"),
        page: null,
        owner: root,
        depth: 0,
        figures: [],
      },
    ];
    const visited = new Set();
    const checkContent = (mcid, page, owner) => {
      if (mcid === null || !pageNodes.has(page)) return false;
      const key = integer(value(page, "StructParents"));
      const entries = key === null ? undefined : parents.get(key);
      return (
        entries instanceof PDFArray &&
        mcid < entries.size() &&
        entries.get(mcid) instanceof PDFRef &&
        lookup(entries.get(mcid)) === owner
      );
    };
    const noteFigurePage = (figures, page) => {
      if (!pageNodes.has(page)) return false;
      for (const figure of figures) authoredFigurePages.get(figure).add(page);
      return true;
    };
    while (pending.length) {
      const item = pending.pop();
      const { node, owner, depth } = item;
      let page = item.page;
      let figures = item.figures;
      if (depth > MAX_DEPTH || ++inspected > MAX_NODES_PAGE) return unavailable;
      if (node instanceof PDFNumber) {
        if (!checkContent(integer(node), page, owner)) return unavailable;
        noteFigurePage(figures, page);
        continue;
      }
      if (
        !(node instanceof PDFArray || node instanceof PDFDict) ||
        visited.has(node)
      )
        return unavailable;
      visited.add(node);
      if (node instanceof PDFArray) {
        if (inspected + pending.length + node.size() > MAX_NODES_PAGE)
          return unavailable;
        for (let index = node.size() - 1; index >= 0; index--)
          pending.push({
            node: lookup(node.get(index)),
            page,
            owner,
            figures,
            depth: depth + 1,
          });
        continue;
      }
      if (node.has(name("Pg"))) page = value(node, "Pg");
      if (node.has(name("Stm"))) {
        // PDF.js serializes MCR IDs using only page+MCID and drops /Stm. An
        // unused Form stream can therefore collide with an unrelated page MCID
        // without ever appearing in the rendering operators. Keep text, but
        // disable these page-only bounds whenever stream scope was discarded.
        allowBounds = false;
      }
      if (node.has(name("MCID"))) {
        if (!pageNodes.has(page)) return unavailable;
        if (
          !node.has(name("Stm")) &&
          !checkContent(integer(value(node, "MCID")), page, owner)
        )
          return unavailable;
        noteFigurePage(figures, page);
        continue;
      }
      if (value(node, "Type") === name("OBJR")) {
        const object = value(node, "Obj");
        const objectDict = object instanceof PDFDict ? object : object?.dict;
        if (!(objectDict instanceof PDFDict)) return unavailable;
        const key = integer(value(objectDict, "StructParent"));
        if (key === null || parents.get(key) !== owner) return unavailable;
        if (!noteFigurePage(figures, page)) return unavailable;
        continue;
      }
      const role = value(node, "S");
      if (!(role instanceof PDFName) || value(node, "P") !== owner)
        return unavailable;
      const mappedRole =
        roles instanceof PDFDict ? value(roles, role.decodeText()) : role;
      const figure = role === name("Figure") || mappedRole === name("Figure");
      let alt = value(node, "Alt");
      if (!(alt instanceof PDFString || alt instanceof PDFHexString))
        alt = value(node, "ActualText");
      const authored = alt instanceof PDFString || alt instanceof PDFHexString;
      if (figure && authored) {
        authoredFigurePages.set(node, new Set());
        figures = [...figures, node];
      }
      if (!node.has(name("K"))) {
        if (figure && authored) return unavailable;
        continue;
      }
      pending.push({
        node: value(node, "K"),
        page,
        owner: node,
        figures,
        depth: depth + 1,
      });
    }
    const expectedFigureCounts = orderedPages.map(() => 0);
    for (const pages of authoredFigurePages.values()) {
      // An authored Figure with no reachable content cannot safely be called an
      // absent description merely because PDF.js omitted it from its page tree.
      if (pages.size === 0) return unavailable;
      for (const page of pages)
        expectedFigureCounts[orderedPages.indexOf(page)]++;
    }
    return { available: true, allowBounds, expectedFigureCounts };
  } catch {
    return unavailable;
  }
}

export function createImageAlternativeBudget() {
  return { figures: 0, characters: 0, operations: 0 };
}

export function unavailableImageAlternatives() {
  return { status: "unavailable", figures: [] };
}

export async function extractImageAlternatives(page, pageNumber, budget) {
  try {
    const tree = await page.getStructTree();
    if (!tree) return { status: "complete", figures: [] };
    const figures = [];
    const pending = [{ node: tree, depth: 0, owners: [] }];
    const visited = new Set();
    let characters = 0;
    while (pending.length) {
      const { node, depth, owners: inheritedOwners } = pending.pop();
      if (!node || typeof node !== "object" || visited.has(node))
        return unavailableImageAlternatives();
      visited.add(node);
      if (depth > MAX_DEPTH || visited.size > MAX_NODES_PAGE)
        return unavailableImageAlternatives();
      let owners = inheritedOwners;
      if (node.role === "Figure" && typeof node.alt === "string") {
        // PDF.js exposes /Alt, or /ActualText when /Alt is absent. Both are
        // authored figure alternatives; its API does not distinguish them.
        // Empty strings remain meaningful authored metadata, not missing values.
        characters += node.alt.length;
        if (
          node.alt.length > MAX_ALT_CHARACTERS ||
          characters > MAX_CHARACTERS_PAGE ||
          characters + budget.characters > MAX_CHARACTERS_DOCUMENT ||
          figures.length >= MAX_FIGURES_PAGE ||
          figures.length + budget.figures >= MAX_FIGURES_DOCUMENT
        )
          return unavailableImageAlternatives();
        const figure = {
          id: `p${pageNumber}-figure${figures.length + 1}`,
          alt: node.alt,
          bounds: null,
          contentIds: new Set(),
          unresolvedContent: false,
        };
        figures.push(figure);
        owners = [...inheritedOwners, figure];
      }
      if (node.type) {
        for (const owner of owners) {
          if (
            node.type === "content" &&
            typeof node.id === "string" &&
            node.id.length <= 80
          )
            owner.contentIds.add(node.id);
          else owner.unresolvedContent = true;
        }
      }
      if (node.children !== undefined) {
        if (
          !Array.isArray(node.children) ||
          visited.size + pending.length + node.children.length > MAX_NODES_PAGE
        )
          return unavailableImageAlternatives();
        for (let index = node.children.length - 1; index >= 0; index--)
          pending.push({
            node: node.children[index],
            depth: depth + 1,
            owners,
          });
      }
    }
    budget.figures += figures.length;
    budget.characters += characters;
    return { status: "complete", figures };
  } catch {
    return unavailableImageAlternatives();
  }
}

export async function prepareImageAlternativeBounds(page, extracted, budget) {
  if (extracted.status !== "complete" || extracted.figures.length === 0)
    return null;
  try {
    const operators = await page.getOperatorList();
    const count = operators.fnArray.length;
    // Bounding-box tracking adds work proportional to the operator list. Skip
    // that optional work above the cap while retaining the complete metadata.
    if (
      !Number.isSafeInteger(count) ||
      count > MAX_OPERATIONS_PAGE ||
      count + budget.operations > MAX_OPERATIONS_DOCUMENT ||
      operators.argsArray.length !== count
    )
      return null;
    budget.operations += count;
    return operators;
  } catch {
    return null;
  }
}

export function locateImageAlternatives(page, extracted, operators, ops) {
  const output = {
    status: extracted.status,
    figures: extracted.figures.map(({ id, alt }) => ({
      id,
      alt,
      bounds: null,
    })),
  };
  if (!operators || !page.recordedBBoxes || !page.ref) return output;
  try {
    const boxes = page.recordedBBoxes;
    if (boxes.length !== operators.fnArray.length) return output;
    const prefix = `p${page.ref.num}R${page.ref.gen || ""}_mc`;
    const matches = new Map();
    let formDepth = 0;
    let annotationDepth = 0;
    for (let index = 0; index < operators.fnArray.length; index++) {
      const op = operators.fnArray[index];
      if (op === ops.paintFormXObjectBegin) formDepth++;
      else if (op === ops.paintFormXObjectEnd) {
        if (formDepth === 0) return output;
        formDepth--;
      } else if (op === ops.beginAnnotation) annotationDepth++;
      else if (op === ops.endAnnotation) {
        if (annotationDepth === 0) return output;
        annotationDepth--;
      } else if (op === ops.beginMarkedContentProps) {
        const [tag, mcid] = operators.argsArray[index] ?? [];
        if (tag === "OC" || !Number.isSafeInteger(mcid) || mcid < 0) continue;
        const key = prefix + mcid;
        // PDF.js flattens form streams into this list. Their MCIDs may belong to
        // another scope, and repeated MCIDs may describe different occurrences.
        // Preserve the alternative but refuse to attach a guessed visual box.
        matches.set(
          key,
          formDepth || annotationDepth || matches.has(key) ? null : index
        );
      }
    }
    if (formDepth !== 0 || annotationDepth !== 0) return output;
    const references = new Map();
    for (const figure of extracted.figures)
      for (const id of figure.contentIds)
        references.set(id, (references.get(id) ?? 0) + 1);
    for (let index = 0; index < extracted.figures.length; index++) {
      const figure = extracted.figures[index];
      if (figure.unresolvedContent || figure.contentIds.size === 0) continue;
      let x1 = 1,
        y1 = 1,
        x2 = 0,
        y2 = 0;
      let located = true;
      for (const id of figure.contentIds) {
        const opIndex = matches.get(id);
        if (
          references.get(id) !== 1 ||
          !Number.isSafeInteger(opIndex) ||
          boxes.isEmpty(opIndex)
        ) {
          located = false;
          break;
        }
        // BBoxReader returns normalized, top-left canvas coordinates measured
        // during rendering (including rotation, transforms, clipping and vectors).
        // They are quantized to 1/256 page units: approximate locations, not crops.
        const bounds = [
          boxes.minX(opIndex),
          boxes.minY(opIndex),
          boxes.maxX(opIndex),
          boxes.maxY(opIndex),
        ];
        if (
          bounds.some(
            (value) => !Number.isFinite(value) || value < 0 || value > 1
          ) ||
          bounds[0] >= bounds[2] ||
          bounds[1] >= bounds[3]
        ) {
          located = false;
          break;
        }
        x1 = Math.min(x1, bounds[0]);
        y1 = Math.min(y1, bounds[1]);
        x2 = Math.max(x2, bounds[2]);
        y2 = Math.max(y2, bounds[3]);
      }
      if (located)
        output.figures[index].bounds = {
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
        };
    }
  } catch {
    // A PDF.js API change or unsupported association must not discard authored
    // text, fail an otherwise rendered page, or silently invent image identity.
    for (const figure of output.figures) figure.bounds = null;
  }
  return output;
}
