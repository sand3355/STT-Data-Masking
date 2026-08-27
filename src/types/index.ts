export type Sensitivity = 'high' | 'medium' | 'low';

export type JobStatus = 'uploaded' | 'analysing' | 'ready' | 'exported' | 'error';

/** Where a finding came from: AI model, deterministic pattern scanner, or both agreeing. */
export type DetectionSource = 'ai' | 'pattern' | 'ai+pattern';

export type FieldCategory = 'Vendor Name' | 'Price' | 'Percentage';

export interface MaskingSuggestion {
  fieldId: string;
  fieldName: FieldCategory;
  originalValue: string;
  maskedValue: string;
  reason: string;
  sensitivity: Sensitivity;
  /** How this value was detected. */
  source: DetectionSource;
  /** 0–100. AI+pattern agreement = 100, verified AI = 90, pattern-only = 75, unverified AI = 40. */
  confidence: number;
  /** How many times the exact value occurs in the document text. */
  occurrences: number;
  /** True when the value was located verbatim (or case-corrected) in the document. */
  verified: boolean;
  /** Short snippet of surrounding document text, with the value marked by «…». */
  context: string;
}

export interface ReviewDecision {
  fieldId: string;
  accepted: boolean;
  editedValue?: string;
}

// Structured sheet data preserved from the original XLSX upload
export interface SheetData {
  name: string;
  rows: string[][];      // rows[r][c] = stringified cell value
  colCount: number;
}

// Column/value-level masking plan for large spreadsheets: the AI decides WHAT
// to mask from headers + sample rows; the server applies it to every row.
export interface SheetMaskPlan {
  name: string | null;        // null for CSV (no sheets)
  maskColumns: string[];      // exact header texts of columns masked in full
  maskValues: string[];       // specific values masked wherever they appear
  sweepNumbers?: boolean;     // default true: also mask money/percent-shaped cells
}

export interface SpreadsheetMaskPlan {
  sheets: SheetMaskPlan[];
}

export interface MaskingJob {
  jobId: string;
  fileName: string;
  fileType: 'xlsx' | 'csv' | 'pdf' | 'docx' | 'doc';
  status: JobStatus;
  charCount: number;
  rawText: string;
  originalBuffer: Buffer;          // original uploaded file bytes
  maskedBuffer?: Buffer;           // AI-produced masked file (set when AI generates output directly)
  documentSha256: string;          // hash of the uploaded bytes, for the audit trail
  fileStructure: SheetData[];      // populated for xlsx; empty array otherwise
  suggestions: MaskingSuggestion[];
  decisions: Map<string, ReviewDecision>;
  createdAt: number;
  maskStats?: ProcessStats;        // stats from AI-driven masking pass
  errorMessage?: string;           // set when status === 'error' so reconnects can report it
  maskPlan?: SpreadsheetMaskPlan;  // set for large spreadsheets (plan-based masking)
}

export interface ExportResult {
  maskedDocument: string;
  auditLog: AuditEntry[];
  stats: ExportStats;
  meta: AuditMeta;
}

export interface AuditMeta {
  tool: string;
  version: string;
  jobId: string;
  fileName: string;
  fileType: string;
  documentSha256: string;
  generatedAt: string;
}

export interface AuditEntry {
  fieldId: string;
  fieldName: string;
  originalValue: string;
  finalValue: string;
  action: 'masked' | 'skipped' | 'pending';
  reason: string;
  sensitivity: Sensitivity;
  source: DetectionSource;
  confidence: number;
  occurrences: number;
  timestamp: string;
}

export interface CategoryStat {
  category: string;
  total: number;
  masked: number;
  skipped: number;
}

export interface ProcessStats {
  totalFields: number;
  masked: number;
  skipped: number;
  pending: number;
  maskedRate: number;
  byCategory: CategoryStat[];
}

export interface ExportStats {
  totalFields: number;
  masked: number;
  skipped: number;
  pending: number;
  maskedRate: number;          // % of fields that ended up masked
  byCategory: CategoryStat[];
}
