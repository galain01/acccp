/** Stable IDs identify objects in the original OOXML part; they are not PDF pages. */
export interface DocxFinding {
  code: string;
  severity: "warning" | "error";
  objectId?: string;
  location: string;
  message: string;
  suggestion: string;
}

export interface DocxParagraph {
  id: string;
  partName: string;
  index: number;
  location: string;
  text: string;
  styleId: string | null;
  styleName: string | null;
  headingLevel: number | null;
  language: string | null;
  /** Native numbering inherited from paragraph styles is included. numId=0 disables a list and is represented by null. */
  list?: {
    numId: string;
    /** Word's native zero-based nesting level. */
    level: number;
    format: string | null;
    markerText: string | null;
  } | null;
  inTable: boolean;
  editable: boolean;
  formatting: { bold: boolean | null; fontSizePt: number | null };
}

export interface DocxTable {
  id: string;
  partName: string;
  index: number;
  location: string;
  cells: string[][];
  firstRowHeader: boolean;
  complex: boolean;
  editable: boolean;
}

export interface DocxImage {
  id: string;
  partName: string;
  index: number;
  location: string;
  paragraphId?: string;
  name: string;
  description: string;
  title: string;
  decorative: boolean;
  functional: boolean;
  /** Only inline drawings have a reliable anchor in the paragraph reading flow. */
  inline: boolean;
  editable: boolean;
  nearbyText: string;
}

export interface DocxInspection {
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
  images: DocxImage[];
  /** Structural/coverage limitations that a model cannot dismiss. */
  findings: DocxFinding[];
}

export type DocxRepairOperation =
  | { type: "setHeading"; id: string; level: number; sourceText: string }
  | { type: "setImageDescription"; id: string; text: string }
  | { type: "setDecorative"; id: string; decorative: true }
  | { type: "setTableHeader"; id: string; headerTexts: string[] }
  | { type: "setLanguage"; id: string; tag: string; sourceText: string };

export interface DocxRepairPlan {
  reviewedParagraphIds: string[];
  reviewedTableIds: string[];
  reviewedImageIds: string[];
  operations: DocxRepairOperation[];
}

export interface DocxChange {
  type: DocxRepairOperation["type"];
  id: string;
  location: string;
  message: string;
  before: string;
  after: string;
}

export interface DocxRepairResult {
  buffer: Buffer;
  inspection: DocxInspection;
  findings: DocxFinding[];
  changes: DocxChange[];
}
