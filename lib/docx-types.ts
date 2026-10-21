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
  /** A proven two-row header hierarchy that can become explicit unmerged labels. */
  headerCandidate?: {
    headerRows: 2;
    labels: string[];
    sourceCells: string[][];
    headerParagraphIds: string[];
    gridWidthsTwips: number[];
    /** null means Word chooses the height from the content. */
    headerHeightsTwips: (number | null)[];
    indentTwips: number | null;
    alignment: string | null;
  };
}

export interface DocxListCandidate {
  id: string;
  paragraphIds: string[];
  sourceTexts: string[];
  prefixes: string[];
  kind: "bullet" | "decimal";
  marker: string;
  start: number | null;
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
  listCandidates?: DocxListCandidate[];
}

export type DocxRepairOperation =
  | { type: "setHeading"; id: string; level: number; sourceText: string }
  | { type: "setImageDescription"; id: string; text: string }
  | { type: "setDecorative"; id: string; decorative: true }
  | { type: "setTableHeader"; id: string; headerTexts: string[] }
  | {
      type: "convertTypedList";
      id: string;
      items: { paragraphId: string; sourceText: string }[];
    }
  | { type: "simplifyTableHeaders"; id: string; sourceCells: string[][] }
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
  /** Original paragraph IDs for an explicitly authorized structural repair. */
  paragraphIds?: string[];
}

export interface DocxRepairResult {
  buffer: Buffer;
  inspection: DocxInspection;
  findings: DocxFinding[];
  changes: DocxChange[];
  /** Original IDs to actual output IDs; null identifies removed header paragraphs. */
  identityMap?: Record<string, string | null>;
}
