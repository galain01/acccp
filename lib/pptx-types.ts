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
    | "language";
  slideNumber: number;
  objectId?: string;
  message: string;
  /** Trusted engine-computed bounds for a declared structural table repair. */
  visualRegion?: PptxRect;
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
  /** Existing authored titles/descriptions and decorative objects are never overwritten. */
  descriptions?: { objectId: string; text: string }[];
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
