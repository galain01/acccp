/** PPTX-specific contracts. Slide numbers follow presentation order, including hidden slides. */
export interface PptxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PptxFinding {
  code: string;
  severity: "warning" | "error";
  slideNumber?: number;
  objectId?: string;
  message: string;
  suggestion: string;
}

export interface PptxChange {
  type:
    | "title"
    | "description"
    | "table-header"
    | "table-caption"
    | "reading-order"
    | "language"
    | "link-text"
    | "text-style"
    | "position";
  slideNumber: number;
  objectId?: string;
  message: string;
  /** Trusted engine-computed bounds for a declared structural table repair. */
  visualRegion?: PptxRect;
  /** Engine-assigned operation identifier, used to replay reviewed revisions. */
  operationId?: string;
}

export interface PptxObject {
  id: string;
  name: string;
  kind:
    | "text"
    | "image"
    | "table"
    | "chart"
    | "smartart"
    | "group"
    | "shape"
    | "media"
    | "unsupported";
  text: string;
  description: string;
  title: string;
  decorative: boolean;
  isTitle: boolean;
  hidden: boolean;
  rect: PptxRect | null;
  grouped: boolean;
  parentId: string | null;
  language: string | null;
  /** Actual text/language runs, including mixed-language objects. */
  textRuns?: {
    text: string;
    language: string | null;
    hyperlink?: boolean;
    fontSizePt?: number;
    colorHex?: string;
  }[];
  /** Native SmartArt data text, when present; its order alone does not prove reading order. */
  diagramText?: string[];
  table?: {
    rows: number;
    columns: number;
    firstRow: boolean;
    firstColumn: boolean;
    complex: boolean;
    cells: string[][];
  };
}

export interface PptxSlide {
  slideNumber: number;
  partName: string;
  hidden: boolean;
  hasTiming: boolean;
  hasExternalContent: boolean;
  objects: PptxObject[];
}

export interface PptxInspection {
  slideCount: number;
  width: number;
  height: number;
  slides: PptxSlide[];
  findings: PptxFinding[];
}

export interface PptxSlideRepairs {
  slideNumber: number;
  /** Select an existing, nonempty, top-level text object. Text is never rewritten. */
  titleObjectId?: string;
  /** Replacement of authored descriptions requires explicit revisioned mode. */
  descriptions?: {
    objectId: string;
    text: string;
    replaceExisting?: boolean;
  }[];
  /** Exact first-row text is required as a source-content guard. */
  tableHeaders?: { objectId: string; firstRow: true; headerTexts: string[] }[];
  /** Move one merged caption above new column labels; every source cell must match. */
  splitTableCaption?: {
    objectId: string;
    captionText: string;
    headerTexts: string[];
    sourceCells: string[][];
  }[];
  /** Must be a complete permutation of direct shape-tree children. */
  readingOrder?: string[];
  /** Accepted for compatibility but never applied in v1: language inheritance needs review. */
  language?: { tag: string; evidenceText: string };
  /** Exact, uniquely matched text within an object; only those runs receive the language. */
  textLanguages?: { objectId: string; sourceText: string; tag: string }[];
  /** Rename one exact hyperlink label while preserving its target relationship. */
  linkTexts?: { objectId: string; sourceText: string; text: string }[];
  textStyles?: {
    objectId: string;
    sourceText: string;
    fontSizePt?: number;
    colorHex?: string;
  }[];
  objectBounds?: { objectId: string; sourceRect: PptxRect; rect: PptxRect }[];
  revisionNotes?: {
    type: PptxChange["type"];
    objectId?: string;
    reason: string;
    assumption?: string;
  }[];
}

export interface PptxRepairPlan {
  slides: PptxSlideRepairs[];
}

export interface PptxRepairResult {
  buffer: Buffer;
  changes: PptxChange[];
  findings: PptxFinding[];
  inspection: PptxInspection;
}

export interface PptxRevisionChange {
  id: string;
  type: PptxChange["type"];
  slideNumber: number;
  objectId?: string;
  label: string;
  before: string;
  after: string;
  reason: string;
  assumption?: string;
  /** All operations in one change are accepted or restored together. */
  operationIds: string[];
  editableDescription?: boolean;
}

export interface PptxRevisionBundle {
  version: 1;
  sourceHash: string;
  plan: PptxRepairPlan;
  changes: PptxRevisionChange[];
}
