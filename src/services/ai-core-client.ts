import axios from 'axios';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { RawAiSuggestion, scanPatterns } from './detection-engine.js';
import { SpreadsheetMaskPlan } from '../types/index.js';

const logger = createLogger('ai-core-client');

// --- OAuth token cache -------------------------------------------------------

interface TokenCache { token: string; expiresAt: number; }
let tokenCache: TokenCache | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  logger.info('Fetching new OAuth token');
  const creds = Buffer.from(
    `${config.aiCore.clientId}:${config.aiCore.clientSecret}`
  ).toString('base64');
  const resp = await axios.post(
    `${config.aiCore.oauthUrl}/oauth/token`,
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const { access_token, expires_in } = resp.data as { access_token: string; expires_in?: number };
  tokenCache = { token: access_token, expiresAt: Date.now() + ((expires_in ?? 3600) - 60) * 1000 };
  logger.info('OAuth token cached');
  return access_token;
}

// --- Deployment auto-discovery ------------------------------------------------
// The service key has no deployment id, so if SAP_AI_CORE_DEPLOYMENT_ID is not
// set we list deployments in the resource group and pick a RUNNING LLM one,
// preferring Anthropic Claude models.

interface DeploymentInfo { id: string; model: string; }
let resolvedDeployment: DeploymentInfo | null = null;
// Set when the configured SAP_AI_CORE_DEPLOYMENT_ID turns out to be dead
// (deleted/stopped on AI Core) so we stop trying it and auto-discover instead.
let configuredDeploymentInvalid = false;

function isDeploymentNotFound(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}

/**
 * Drop the cached deployment. Called when an inference request 404s, which
 * means the deployment was deleted or restarted with a new id — the next
 * resolveDeployment() call re-discovers a live one, so the existing
 * stream→sync→retry fallback layers recover automatically.
 */
export function invalidateDeployment(): void {
  resolvedDeployment = null;
  if (config.aiCore.deploymentId) configuredDeploymentInvalid = true;
  logger.warn('Deployment cache invalidated — will re-discover on next call');
}

interface AiCoreDeployment {
  id: string;
  status?: string;
  scenarioId?: string;
  configurationName?: string;
  details?: {
    resources?: {
      backend_details?: { model?: { name?: string; version?: string } };
      backendDetails?: { model?: { name?: string; version?: string } };
    };
  };
}

function deploymentModelName(d: AiCoreDeployment): string {
  const res = d.details?.resources;
  return (
    res?.backend_details?.model?.name ??
    res?.backendDetails?.model?.name ??
    d.configurationName ??
    ''
  );
}

export async function resolveDeployment(): Promise<DeploymentInfo> {
  if (resolvedDeployment) return resolvedDeployment;

  const token = await getToken();

  // A configured id is verified before use: if the deployment was deleted or
  // is not RUNNING (ids change when deployments are recreated), fall back to
  // auto-discovery instead of failing every inference call with a 404.
  if (config.aiCore.deploymentId && !configuredDeploymentInvalid) {
    try {
      const resp = await axios.get<AiCoreDeployment>(
        `${config.aiCore.inferenceUrl}/v2/lm/deployments/${config.aiCore.deploymentId}`,
        {
          headers: { Authorization: `Bearer ${token}`, 'AI-Resource-Group': config.aiCore.resourceGroup },
          timeout: 30_000,
        }
      );
      const status = (resp.data?.status ?? '').toUpperCase();
      if (status === 'RUNNING') {
        resolvedDeployment = {
          id: config.aiCore.deploymentId,
          model: deploymentModelName(resp.data) || 'configured',
        };
        logger.info(`Using configured deployment ${resolvedDeployment.id} (${resolvedDeployment.model})`);
        return resolvedDeployment;
      }
      if (status === 'PENDING' || status === 'STARTING' || status === 'UNKNOWN') {
        // Still starting up — use a fallback for now but do NOT write it to the
        // cache, so the next call re-checks and switches over once it is RUNNING.
        logger.warn(`Configured deployment ${config.aiCore.deploymentId} has status "${status}" — using a fallback until it is RUNNING`);
        return discoverDeployment(token, { cache: false });
      }
      logger.warn(`Configured deployment ${config.aiCore.deploymentId} has status "${status}" — auto-discovering instead`);
    } catch (err) {
      logger.warn(
        `Configured deployment ${config.aiCore.deploymentId} is not usable — auto-discovering instead`,
        err instanceof Error ? err.message : String(err)
      );
    }
    configuredDeploymentInvalid = true;
  }

  return discoverDeployment(token, { cache: true });
}

async function discoverDeployment(
  token: string,
  opts: { cache: boolean }
): Promise<DeploymentInfo> {
  logger.info('Auto-discovering deployment from AI Core');
  const resp = await axios.get<{ resources?: AiCoreDeployment[] }>(
    `${config.aiCore.inferenceUrl}/v2/lm/deployments?$top=100`,
    {
      headers: { Authorization: `Bearer ${token}`, 'AI-Resource-Group': config.aiCore.resourceGroup },
      timeout: 30_000,
    }
  );

  const all = resp.data?.resources ?? [];
  const running = all.filter((d) => (d.status ?? '').toUpperCase() === 'RUNNING');
  logger.info(`Found ${all.length} deployment(s), ${running.length} running`);

  // Prefer Claude/Anthropic, then any foundation-model deployment, then anything running
  const score = (d: AiCoreDeployment): number => {
    const name = deploymentModelName(d).toLowerCase();
    if (name.includes('claude') || name.includes('anthropic')) return 3;
    if ((d.scenarioId ?? '').includes('foundation')) return 2;
    return 1;
  };
  const best = running.sort((a, b) => score(b) - score(a))[0];
  if (!best) {
    throw new Error(
      'No RUNNING deployment found in AI Core resource group ' +
      `"${config.aiCore.resourceGroup}". Create a foundation-model deployment ` +
      'or set SAP_AI_CORE_DEPLOYMENT_ID in .env.'
    );
  }

  const info: DeploymentInfo = { id: best.id, model: deploymentModelName(best) || best.id };
  if (opts.cache) resolvedDeployment = info;
  logger.info(`Auto-discovered deployment ${best.id} (model: ${info.model})`);
  return info;
}

// --- Direct masking system prompts -------------------------------------------
// These prompts ask the AI to OUTPUT the masked document, not a detection list.

const MASK_SYSTEM_SPREADSHEET = [
  'You are a data-privacy specialist. You will receive a vendor pricing spreadsheet.',
  '',
  'Your job: process EVERY sheet in the workbook and output ALL sheets as CSV with',
  'ALL sensitive data replaced with the exact string "XXXX".',
  '',
  '═══ WHAT TO REPLACE WITH "XXXX" ═══',
  '',
  '1. VENDOR NAMES & CODES',
  '   Mask: any vendor name, supplier code, company name, country-code identifier.',
  '   Examples: "SG-01", "Vendor SG01", "PT Jaya", "Singapore Vendor"',
  '',
  '2. MONETARY AMOUNTS & PRICES',
  '   Mask: any number in a column whose header contains "Amount", "Cost", "Price",',
  '   "Total", "Budget", "Value", "USD", "SGD", "IDR", "MYR", "EUR", or similar.',
  '   Also mask formatted values like "150,000,000", "SGD 150M", "~USD 11.75M/MW".',
  '   Even plain numbers like "7350000" are prices if they are in an Amount column.',
  '',
  '3. PERCENTAGE VALUES — CRITICAL RULE',
  '   *** ANY numeric cell whose column header contains "%" OR "Weight" OR',
  '   "Percentage" OR "Share" OR "Ratio" MUST be replaced with XXXX. ***',
  '   This includes ALL these examples:',
  '     - Column "%" with values 12, 42, 18, 4, 7, 5   → all become XXXX',
  '     - Column "Weight (%)" with values 25, 20, 15    → all become XXXX',
  '     - Column "% Share" with values 30, 25, 45       → all become XXXX',
  '   Single-digit percentages (4, 5, 7) are just as sensitive as large ones (42, 25).',
  '   Do NOT skip a cell just because it looks like a small number.',
  '',
  '4. SCORES & RATINGS in vendor comparison sheets',
  '   Mask: numeric scores that compare vendor performance (e.g. 8, 7, 9 out of 10).',
  '   These appear in columns like "Singapore Score", "Malaysia Score", "Indonesia Score",',
  '   "Germany Score", "Vendor Score", "Rating", etc.',
  '',
  '5. UNIT RATES & CAPACITY VALUES',
  '   Mask: "10 MW", "5.5 GW", "~USD 9.11M/MW", "$7K-12K/MW", exchange rates.',
  '',
  '═══ KEEP EXACTLY AS-IS (never replace with XXXX) ═══',
  '- Column headers themselves: "Component", "%", "Weight (%)", "Amount", "Criteria", etc.',
  '- Row labels / category names: "Site & Civil", "Electrical", "Design Capability", etc.',
  '- Empty cells: output as empty (two consecutive commas in CSV)',
  '',
  '═══ OUTPUT FORMAT — CRITICAL ═══',
  '- For EACH sheet, output a marker line: ===SHEET:{exact_sheet_name}===',
  '  followed immediately by that sheet\'s CSV data.',
  '- Example for a workbook with sheets "Summary" and "Breakdown":',
  '  ===SHEET:Summary===',
  '  Criteria,Weight (%),Singapore Score,Malaysia Score',
  '  Design Capability,XXXX,XXXX,XXXX',
  '  Delivery Timeline,XXXX,XXXX,XXXX',
  '  ===SHEET:Breakdown===',
  '  Component,%,Amount',
  '  Site & Civil,XXXX,XXXX',
  '  Electrical,XXXX,XXXX',
  '- Process ALL sheets in the workbook, not just the first one.',
  '- One row per line, cells separated by commas.',
  '- No markdown fences, no extra explanations, no text outside the markers and CSV.',
].join('\n');

const MASK_SYSTEM_DOCUMENT = [
  'You are a data-privacy specialist. You will receive a vendor pricing document.',
  '',
  'Your job: read the ENTIRE document and output it VERBATIM with ALL sensitive data replaced by "XXXX".',
  '',
  '═══ REPLACE WITH "XXXX" ═══',
  '',
  '1. VENDOR NAMES & CODES — all company names, supplier codes, identifiers',
  '',
  '2. ALL MONETARY VALUES — single amounts AND ranges:',
  '   Single: "USD 120M", "SGD 150,000,000", "€ 12.6M", "~USD 122.25K", "$7M"',
  '   Ranges: "USD 100M – 120M", "10M – 15M", "40M – 54M", "$7M–$12M", "5M – 10M"',
  '   Per-unit rates: "~USD 11.75M/MW", "$7M–$12M per MW", "USD 10M–12M per MW"',
  '   Replace the ENTIRE range as one XXXX — e.g. "10M – 15M" → "XXXX"',
  '',
  '3. ALL PERCENTAGE VALUES — single AND ranges:',
  '   Single: "4%", "12%", "42%", "5%", "7%"',
  '   Ranges: "10–15%", "40–45%", "3–5%", "5–8%", "5–10%", "15–20%"',
  '   In-sentence: "(~40–45%)", "cooling (15–25%)"',
  '   Replace the ENTIRE range as one XXXX — e.g. "10–15%" → "XXXX"',
  '',
  '4. CAPACITY & POWER VALUES: "10 MW", "20 MW", "5.5 GW", "100 KWh"',
  '',
  '5. SCORES AND RATINGS in vendor comparison tables',
  '',
  '═══ KEEP EXACTLY AS-IS ═══',
  '- Section and table headers, row labels ("Site & Civil", "Electrical", etc.)',
  '- Descriptive text, project names, technology descriptions',
  '- Non-financial text: "Tier III Data Center", "EPC Turnkey", "18–24 months"',
  '  (Duration ranges like "18–24 months" are NOT financial — keep them)',
  '- Dates, page numbers, addresses',
  '',
  'OUTPUT: The complete document text with XXXX substitutions. Nothing else.',
  'Do NOT summarise, truncate, add commentary, or wrap in markdown.',
  'Replace FULL range strings — never split a range into two separate XXXXs.',
].join('\n');

// --- Shared streaming+fallback helper -----------------------------------------
// SAP AI Core SSE format: text lines with Python-style single-quoted dicts.
// Shared by maskDocumentDirectStream and maskRawTextStream.

function sseExtractDelta(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice(6);
  if (!payload.includes('contentBlockDelta')) return null;
  const m = payload.match(/'text':\s*'((?:[^'\\]|\\.)*)'/);
  if (!m) return null;
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/\\'/g, "'");
}

async function invokeMaskDirect(
  content: ContentBlock[],
  systemPrompt: string,
  onChunk: (delta: string) => void,
  label: string
): Promise<string> {
  const token = await getToken();

  // ── Attempt 1: streaming ───────────────────────────────────────────────────
  let streamedText = '';
  try {
    const deployment = await resolveDeployment();
    const url = `${config.aiCore.inferenceUrl}/v2/inference/deployments/${deployment.id}/converse-stream`;
    const resp = await axios.post(url, {
      messages: [{ role: 'user', content }],
      system: [{ text: systemPrompt }],
      inferenceConfig: { maxTokens: config.maskMaxTokens },
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'AI-Resource-Group': config.aiCore.resourceGroup,
      },
      responseType: 'stream',
      timeout: 300_000,
    });

    streamedText = await new Promise<string>((resolve, reject) => {
      let fullText = '';
      let resolved = false;
      let textBuf = '';
      let rawBytes = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = resp.data as any;
      stream.on('data', (chunk: Buffer) => {
        rawBytes += chunk.length;
        textBuf += chunk.toString('utf8');
        const lines = textBuf.split('\n');
        textBuf = lines.pop() ?? '';
        for (const line of lines) {
          const delta = sseExtractDelta(line.trim());
          if (delta !== null) { fullText += delta; onChunk(delta); }
          else if (line.includes('messageStop') && !resolved) {
            resolved = true;
            logger.info(`${label} stream done: ${fullText.length} chars`);
            resolve(fullText);
          }
        }
      });
      stream.on('error', (e: Error) => { logger.warn(`${label} stream error: ${e.message}`); reject(e); });
      stream.on('end', () => {
        if (!resolved) {
          resolved = true;
          if (fullText.length > 0) resolve(fullText);
          else reject(new Error(`${label} stream ended empty (${rawBytes} raw bytes)`));
        }
      });
    });
  } catch (err) {
    if (isDeploymentNotFound(err)) invalidateDeployment();
    logger.warn(`${label} stream failed, trying sync:`, err instanceof Error ? err.message : String(err));
  }

  if (streamedText.length > 0) {
    logger.info(`${label}: using streamed output (${streamedText.length} chars)`);
    return streamedText;
  }

  // ── Attempt 2: sync /converse (retried once if the deployment id went stale) ──
  interface ConverseResp { output: { message: { content: Array<{ text?: string }> } }; }
  const callSync = async (): Promise<string> => {
    const deployment = await resolveDeployment();
    const url = `${config.aiCore.inferenceUrl}/v2/inference/deployments/${deployment.id}/converse`;
    const resp = await axios.post<ConverseResp>(url, {
      messages: [{ role: 'user', content }],
      system: [{ text: systemPrompt }],
      inferenceConfig: { maxTokens: config.maskMaxTokens },
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'AI-Resource-Group': config.aiCore.resourceGroup,
      },
      timeout: 300_000,
    });
    return resp.data?.output?.message?.content?.[0]?.text ?? '';
  };

  let text: string;
  try {
    text = await callSync();
  } catch (err) {
    if (!isDeploymentNotFound(err)) throw err;
    invalidateDeployment();
    text = await callSync();
  }
  logger.info(`${label} sync done: ${text.length} chars`);
  onChunk(text);
  return text;
}

// --- AI produces the masked document directly ---------------------------------

/**
 * Sends the binary file to the AI as a native document block.
 * For spreadsheets: AI outputs CSV with XXXX in place of sensitive cells.
 * (Word/PDF use maskRawTextStream instead — see below.)
 */
const SPREADSHEET_TASK = (
  'Output every sheet of this spreadsheet as CSV with all sensitive values replaced by XXXX.\n' +
  'IMPORTANT: Every number in any column whose header contains "%" or "Weight" or "Score" or "Rating" ' +
  'MUST be replaced with XXXX — including values like 25, 20, 15, 12, 42, 18, 4, 7, 5.\n' +
  'Use ===SHEET:{name}=== markers between sheets. Nothing else.'
);

/**
 * Text-path spreadsheet masking for files too large to send as a native
 * document block (> ~3 MB binary): the extracted CSV text goes to the AI with
 * the same system prompt and output format, so the downstream cell-by-cell
 * appliers (maskXlsxFromAiCsv / maskCsvFromAiCsv) work unchanged.
 */
export async function maskSpreadsheetTextStream(
  rawText: string,
  onChunk: (delta: string) => void
): Promise<string> {
  const content: ContentBlock[] = [
    {
      text: (
        SPREADSHEET_TASK +
        '\nThe spreadsheet content is below (sheets are delimited by "=== Sheet: {name} ===" lines):\n\n' +
        rawText
      ),
    },
  ];
  logger.info(`maskSpreadsheetTextStream: ${rawText.length} chars`);
  return invokeMaskDirect(content, MASK_SYSTEM_SPREADSHEET, onChunk, 'maskSpreadsheetTextStream');
}

export async function maskDocumentDirectStream(
  fileBuffer: Buffer,
  fileType: string,
  onChunk: (delta: string) => void
): Promise<string> {
  const isSpreadsheet = fileType === 'xlsx' || fileType === 'xls' || fileType === 'csv';
  const systemPrompt = isSpreadsheet ? MASK_SYSTEM_SPREADSHEET : MASK_SYSTEM_DOCUMENT;
  const format = BEDROCK_FORMAT[fileType] ?? 'txt';

  const content: ContentBlock[] = [
    {
      document: {
        format,
        name: 'vendor-pricing-document',
        source: { bytes: fileBuffer.toString('base64') },
      },
    },
    {
      text: isSpreadsheet
        ? SPREADSHEET_TASK
        : 'Output the complete document text with all sensitive values replaced by XXXX. Nothing else.',
    },
  ];

  logger.info(`maskDocumentDirectStream: format=${format}, size=${fileBuffer.length} bytes`);
  return invokeMaskDirect(content, systemPrompt, onChunk, 'maskDocumentDirectStream');
}

/**
 * Sends extracted plain text to the AI and asks it to output the same text
 * with ALL sensitive values replaced by XXXX.
 *
 * Used for DOC/DOCX: mammoth extracts rawText → AI masks it → caller runs
 * extractMaskedValuesFromText(rawText, aiOutput) to recover which exact strings
 * were substituted → those strings are applied to the original binary.
 *
 * Because both AI and extractMaskedValuesFromText work from the SAME rawText,
 * line-by-line alignment is reliable and full ranges are captured correctly
 * (e.g. "USD 100M – 120M" → XXXX, "10–15%" → XXXX, not partial replacements).
 */
// ── Chunked masking for large documents ──────────────────────────────────────
// Documents whose text exceeds the single-pass output budget are split at
// row/line boundaries, masked chunk-by-chunk (each chunk fits comfortably in
// the output-token budget), and stitched back into one output that looks
// exactly like a single-pass response — so the downstream cell/line appliers
// (maskXlsxFromAiCsv, maskCsvFromAiCsv, extractMaskedValuesFromText) work
// unchanged.

interface SheetBlock { name: string | null; header: string; rows: string[]; }

/** Split spreadsheet rawText into per-sheet blocks ("=== Sheet: X ===" markers). */
function splitSheetBlocks(rawText: string): SheetBlock[] {
  const sheets: SheetBlock[] = [];
  let cur: SheetBlock | null = null;
  for (const line of rawText.split('\n')) {
    const m = line.match(/^===\s*Sheet:\s*(.+?)\s*===$/);
    if (m) {
      if (cur) sheets.push(cur);
      cur = { name: m[1], header: '', rows: [] };
      continue;
    }
    if (!cur) cur = { name: null, header: '', rows: [] };
    if (cur.header === '' && cur.rows.length === 0) cur.header = line;
    else cur.rows.push(line);
  }
  if (cur) sheets.push(cur);
  return sheets;
}

/** Group lines into chunks whose total size stays under the chunk budget. */
function chunkLines(lines: string[], budget: number): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (cur.length > 0 && size + line.length + 1 > budget) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

const PLAN_SYSTEM = [
  'You are a data-privacy specialist reviewing a vendor pricing spreadsheet.',
  'You receive each sheet\'s column header row plus a SAMPLE of its data rows.',
  '',
  'Decide which COLUMNS are sensitive and must be masked in full, and which',
  'additional specific VALUES (outside those columns) must also be masked.',
  '',
  'Sensitive columns: vendor/supplier/subcontractor names or codes, monetary',
  'amounts, prices, costs, totals, subtotals, quoted/marked-up prices, budgets,',
  'discounts, mark-ups, percentages, weights, shares, ratios, scores, ratings,',
  'capacities, unit rates, exchange rates, country identifiers.',
  'NOT sensitive: descriptive labels, category names, item descriptions, dates,',
  'sequence numbers, quantities, units of measure, Y/N flags, and the header',
  'labels themselves (headers are never masked).',
  '',
  'Real-world sheets often have title blocks, multi-row headers, section rows,',
  'and the same column group repeated (e.g. Year 01 / Year 02). Header labels',
  'may therefore appear on ANY row. Copy each label EXACTLY as it appears in',
  'the sample (same case, spacing and line breaks); list each unique label once',
  '— every occurrence of that column is masked automatically.',
  '',
  'Return ONLY this JSON — no markdown, no commentary:',
  '{"sheets":[{"name":"<sheet name, or null for CSV>","maskColumns":["<exact header text>"],"maskValues":["<exact cell value>"]}]}',
  '- maskColumns: header text copied EXACTLY as given (same case and spacing).',
  '- maskValues: only for sensitive values appearing in columns NOT listed in',
  '  maskColumns (e.g. a vendor name inside a description column). Usually empty.',
].join('\n');

/**
 * Plan-based masking for large spreadsheets. Re-emitting thousands of rows is
 * unreliable (models truncate/summarise long repetitive output), so instead the
 * AI sees headers + sampled rows and returns a small column/value plan; the
 * server then masks every row mechanically. Scales to any row count.
 */
export async function planSpreadsheetMasking(
  rawText: string,
  onChunk: (delta: string) => void
): Promise<SpreadsheetMaskPlan> {
  const sheets = splitSheetBlocks(rawText);

  // Sample per sheet: header + first 30 rows + 30 rows spread across the rest,
  // so late-file columns/values are represented without sending everything.
  const sampleParts: string[] = [];
  for (const sheet of sheets) {
    sampleParts.push(`--- SHEET: ${sheet.name ?? '(csv — no sheet name)'} ---`);
    sampleParts.push(`HEADER: ${sheet.header}`);
    const rows = sheet.rows.filter((r) => r.trim() !== '');
    const sampled: string[] = rows.slice(0, 30);
    if (rows.length > 30) {
      const step = Math.max(1, Math.floor((rows.length - 30) / 30));
      for (let i = 30; i < rows.length; i += step) sampled.push(rows[i]);
    }
    sampleParts.push(...sampled.map((r) => `ROW: ${r}`));
    sampleParts.push(`(sheet has ${rows.length} data rows in total)`);
  }

  const content: ContentBlock[] = [{
    text: 'Analyse the sheet samples below and return the masking-plan JSON.\n\n' + sampleParts.join('\n'),
  }];

  logger.info(`planSpreadsheetMasking: ${sheets.length} sheet(s), sample ${sampleParts.join('\n').length} chars`);
  const raw = await invokeMaskDirect(content, PLAN_SYSTEM, onChunk, 'planSpreadsheetMasking');

  // Parse {sheets:[...]} — tolerate fences/surrounding text
  const t = raw.trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('AI masking plan could not be parsed');
  const parsed = JSON.parse(t.slice(s, e + 1)) as { sheets?: unknown };
  if (!Array.isArray(parsed.sheets)) throw new Error('AI masking plan has no sheets');

  const plan: SpreadsheetMaskPlan = {
    sheets: (parsed.sheets as Array<Record<string, unknown>>).map((p) => ({
      name: typeof p.name === 'string' && p.name !== '' && p.name !== 'null' ? p.name : null,
      maskColumns: Array.isArray(p.maskColumns) ? p.maskColumns.filter((c): c is string => typeof c === 'string') : [],
      maskValues: Array.isArray(p.maskValues) ? p.maskValues.filter((v): v is string => typeof v === 'string') : [],
    })),
  };
  logger.info(
    'Masking plan: ' +
    plan.sheets.map((p) => `${p.name ?? 'csv'}: [${p.maskColumns.join(', ')}]${p.maskValues.length ? ` +${p.maskValues.length} value(s)` : ''}`).join(' | ')
  );
  return plan;
}

/**
 * Detection-based path for large Word documents: full-document re-emission is
 * unreliable at this size (models truncate repetitive output), so instead the
 * document text is analysed for sensitive VALUES (chunked as needed) and the
 * caller applies them to the original binary via value-based replacement.
 */
export async function detectSensitiveValuesInText(
  text: string,
  onChunk: (delta: string) => void
): Promise<RawAiSuggestion[]> {
  const suggestions = await analyseTextAnySize(text);
  onChunk(JSON.stringify(suggestions, null, 2));
  return suggestions;
}

export async function maskRawTextStream(
  rawText: string,
  onChunk: (delta: string) => void
): Promise<string> {
  const content: ContentBlock[] = [
    {
      text: (
        'Output the complete text below with ALL sensitive values replaced by XXXX.\n' +
        'Rules:\n' +
        '- Replace ENTIRE monetary ranges as one XXXX: "USD 100M – 120M" → "XXXX", "10M – 15M" → "XXXX"\n' +
        '- Replace ENTIRE percentage ranges as one XXXX: "10–15%" → "XXXX", "40–45%" → "XXXX"\n' +
        '- Replace capacity values: "10 MW" → "XXXX"\n' +
        '- Replace all vendor names, unit costs, totals\n' +
        '- Do NOT change line structure, headers, row labels, or non-sensitive text\n' +
        '- Nothing else in your response — just the modified text\n\n' +
        rawText
      ),
    },
  ];

  logger.info(`maskRawTextStream: ${rawText.length} chars`);
  return invokeMaskDirect(content, MASK_SYSTEM_DOCUMENT, onChunk, 'maskRawTextStream');
}

// --- Original detection system prompt ----------------------------------------

const SYSTEM_PROMPT = [
  'You are a data-privacy specialist reviewing a vendor pricing document for a Proof of Concept.',
  '',
  '## YOUR TASK',
  'Identify ONLY the following 3 categories of sensitive data. Do NOT flag anything else.',
  '',
  '### Category 1 — VENDOR NAME',
  'Any vendor code, supplier identifier, company name, or business entity name.',
  'Examples: "SG-01", "MY-01", "Vendor SG01", "Vendor MY01", "Vendor DE-01", "Acme Corp", "PT Jaya Perkasa", "Vendor A"',
  'Include "Vendor XXNN" style names even when the code has no hyphen (e.g. "Vendor SG01", "Vendor ID01").',
  'fieldName value: "Vendor Name"',
  'sensitivity: "high"',
  '',
  '### Category 2 — PRICE',
  'Any monetary amount, unit price, unit rate, total, subtotal, cost, rate, fee, or capacity/power value — with or without currency symbol.',
  'This includes RANGES of prices — capture the FULL range string as one originalValue.',
  'Single amounts: "SGD 150,000,000", "~USD 117.49M", "~USD 11.75M/MW", "~USD 122.25K", "IDR 1.55T", "EUR 105.0K", "10 MW", "7350000"',
  'Price ranges (capture full range as one value): "USD 100M – 120M", "10M – 15M", "40M – 54M", "15M – 24M", "5M – 12M", "3M – 6M", "5M – 10M"',
  'Per-unit ranges: "$7M–$12M per MW", "USD 10M–12M per MW", "$ 7K–12K/MW"',
  'IMPORTANT: For a range like "$7M–$12M per MW", the ENTIRE string is one originalValue — do NOT split into "$7M" and "$12M" separately.',
  'Always include the ~ prefix when present. Always include the /unit suffix when present.',
  'fieldName value: "Price"',
  'sensitivity: "high"',
  '',
  '### Category 3 — PERCENTAGE',
  'Any percentage value that represents a commercial rate, markup, discount, tax rate, margin, or share.',
  'This includes RANGES of percentages — capture the FULL range string as one originalValue.',
  'Single: "4%", "5%", "7%", "12%", "42%", "15%", "30%"',
  'Ranges (capture full range as one value): "10–15%", "40–45%", "3–5%", "5–8%", "5–10%", "15–20%", "~40–45%"',
  'In-sentence percentages: "(~40–45%)" should be flagged as "~40–45%", "cooling (15–25%)" as "15–25%".',
  'IMPORTANT: For a range like "10–15%", the ENTIRE string is one originalValue — do NOT split into "10%" and "15%" separately.',
  'For spreadsheet cells where the column header is "%" and the cell shows just a number like "7", treat it as "7%" and flag it.',
  'Do NOT flag column headers like "% Share" or label text like "Percentage Breakdown".',
  'fieldName value: "Percentage"',
  'sensitivity: "medium"',
  '',
  '## OUTPUT FORMAT',
  'Return ONLY a valid JSON array — no markdown, no code fences, no explanation, nothing else.',
  'Each element must have exactly these keys:',
  '  fieldId       : unique snake_case string (e.g. "vendor_name_1", "price_3")',
  '  fieldName     : exactly one of "Vendor Name", "Price", or "Percentage"',
  '  originalValue : THE EXACT STRING as it appears verbatim in the document — copy-paste accurate, same case, same spacing',
  '  maskedValue   : always the string "XXXX"',
  '  reason        : one brief sentence',
  '  sensitivity   : "high" for Vendor Name and Price, "medium" for Percentage',
  '',
  '## CRITICAL RULES',
  '1. originalValue MUST be copy-paste exact from the document. If you are unsure of exact casing or spacing, do your best to reproduce it exactly.',
  '2. Do NOT include: currency codes alone (SGD, USD), column headers, row labels, country names, date values, blank/empty cells.',
  '3. Each unique value should appear ONCE even if it repeats in the document.',
  '4. maskedValue is always "XXXX" — never anything else.',
].join('\n');

// --- Robust JSON parser -------------------------------------------------------

// Strip BOM, zero-width chars, Unicode line terminators, and C0 control chars.
// All patterns use \uXXXX / \xXX escapes - no binary bytes in source.
function sanitize(s: string): string {
  return s
    .replace(/\uFEFF/g, '')
    .replace(/\u200B/g, '')
    .replace(/\u200C/g, '')
    .replace(/\u200D/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// Walk the string respecting quoted strings to extract every top-level object.
function extractObjects(src: string): RawAiSuggestion[] {
  const results: RawAiSuggestion[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const obj = JSON.parse(src.slice(start, i + 1)) as Record<string, unknown>;
          if (typeof obj.originalValue === 'string' && typeof obj.fieldName === 'string') {
            results.push(obj as unknown as RawAiSuggestion);
          }
        } catch { /* skip malformed */ }
        start = -1;
      }
    }
  }
  return results;
}

export function parseJsonFromText(text: string): RawAiSuggestion[] {
  logger.info('parseJsonFromText', { rawLength: text.length });

  const t = sanitize(text.trim());

  // Log full cleaned text at debug level for CF logs diagnostics
  logger.debug('parseJsonFromText cleaned', { text: t });

  // S1: direct parse — model obeyed the prompt. An EMPTY array is a valid
  // answer ("nothing sensitive in this text"), not a parse failure.
  try {
    const p = JSON.parse(t);
    if (Array.isArray(p)) {
      if (p.length === 0) logger.warn('AI returned an empty detection list');
      logger.info('Parsed S1 direct');
      return p as RawAiSuggestion[];
    }
  } catch { /* next */ }

  // S2: first '[' to last ']' — handles markdown fences and surrounding text
  const s2 = t.indexOf('['), e2 = t.lastIndexOf(']');
  if (s2 !== -1 && e2 > s2) {
    try {
      const p = JSON.parse(t.slice(s2, e2 + 1));
      if (Array.isArray(p)) {
        if (p.length === 0) logger.warn('AI returned an empty detection list');
        logger.info('Parsed S2 slice');
        return p as RawAiSuggestion[];
      }
    } catch { /* next */ }
  }

  // S3: object-by-object extraction — handles truncated or partially invalid arrays
  const objs = extractObjects(t);
  if (objs.length > 0) { logger.warn(`Parsed S3 extraction: ${objs.length} objects`); return objs; }

  // S4: wrapped object { suggestions: [...] }
  const s4 = t.indexOf('{'), e4 = t.lastIndexOf('}');
  if (s4 !== -1 && e4 > s4) {
    try {
      const p = JSON.parse(t.slice(s4, e4 + 1)) as Record<string, unknown>;
      const arr = Object.values(p).find((v) => Array.isArray(v));
      if (arr) { logger.info('Parsed S4 wrapped'); return arr as RawAiSuggestion[]; }
    } catch { /* next */ }
  }

  logger.error('All parse strategies failed', { length: t.length, preview: t.slice(0, 1000) });
  throw new Error(`AI Core response could not be parsed. Length=${t.length} Preview: ${t.slice(0, 300)}`);
}

// --- AWS EventStream binary parser -------------------------------------------

interface StreamEvent { type: string; payload: unknown; }

class EventStreamParser {
  private buf = Buffer.alloc(0);
  feed(chunk: Buffer): StreamEvent[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const events: StreamEvent[] = [];
    while (this.buf.length >= 12) {
      const totalLen = this.buf.readUInt32BE(0);
      if (this.buf.length < totalLen) break;
      const headersLen = this.buf.readUInt32BE(4);
      const headers: Record<string, string> = {};
      let ho = 12;
      while (ho < 12 + headersLen) {
        const nameLen = this.buf[ho++];
        const name = this.buf.subarray(ho, ho + nameLen).toString('utf8'); ho += nameLen;
        const vType = this.buf[ho++];
        if (vType === 7) {
          const vLen = this.buf.readUInt16BE(ho); ho += 2;
          headers[name] = this.buf.subarray(ho, ho + vLen).toString('utf8'); ho += vLen;
        }
      }
      const payloadStart = 12 + headersLen;
      const payloadEnd = totalLen - 4;
      const eventType = headers[':event-type'];
      if (eventType && payloadEnd > payloadStart) {
        const raw = this.buf.subarray(payloadStart, payloadEnd).toString('utf8');
        try { events.push({ type: eventType, payload: JSON.parse(raw) }); } catch { /* skip */ }
      }
      this.buf = this.buf.subarray(totalLen);
    }
    return events;
  }
}

// --- Document format mapping -------------------------------------------------

// Bedrock Converse API document format identifiers (Claude supports all of these natively)
const BEDROCK_FORMAT: Record<string, string> = {
  pdf:  'pdf',
  xlsx: 'xlsx',
  xls:  'xls',
  csv:  'csv',
  docx: 'docx',
  doc:  'doc',
};

// --- Content builders ---------------------------------------------------------

type ContentBlock = Record<string, unknown>;

/**
 * Native document block — Claude reads the file with full visual/layout fidelity,
 * exactly like a direct upload to Claude.ai. Works for PDF, XLSX, XLS, CSV, DOCX, DOC.
 */
function buildDocumentContent(fileBuffer: Buffer, fileType: string): ContentBlock[] {
  const format = BEDROCK_FORMAT[fileType] ?? 'txt';
  logger.info(`Building native document block: format=${format}, size=${fileBuffer.length} bytes`);
  return [
    {
      document: {
        format,
        name: 'vendor-pricing-document',
        source: { bytes: fileBuffer.toString('base64') },
      },
    },
    {
      text: (
        'Scan the attached vendor pricing document. ' +
        'You can see the full document including all tables, multi-line cells, and formatting. ' +
        'Extract ONLY Vendor Names, Prices, and Percentages as specified in your instructions. ' +
        'Pay close attention to: every table cell, values that wrap across lines, ' +
        'unit rates (e.g. ~USD 11.75M/MW), approximate values (prefixed with ~), price ranges, ' +
        'capacity values (e.g. 10 MW, 20 MW), ALL numeric values in Amount/Cost/Price columns ' +
        '(even without currency symbols, e.g. "7350000"), and ALL percentage values in % columns ' +
        '(including single-digit ones like "4%", "7%", "5%"). ' +
        'Return a valid JSON array — nothing else.'
      ),
    },
  ];
}

// Text volume one detection call can take without crowding the input context.
const DETECT_CHUNK_CHARS = 700_000;

/**
 * Detection over arbitrarily large text: within budget → one call; larger →
 * split at line boundaries, detect per chunk, merge + dedupe the suggestion
 * lists. Detection output is a small JSON list, so chunk count only affects
 * duration, never correctness.
 */
async function analyseTextAnySize(text: string): Promise<RawAiSuggestion[]> {
  const all: RawAiSuggestion[] = [];
  const seen = new Set<string>();
  const add = (suggestions: RawAiSuggestion[]) => {
    for (const s of suggestions) {
      if (s.originalValue && !seen.has(s.originalValue)) {
        seen.add(s.originalValue);
        all.push(s);
      }
    }
  };

  if (text.length <= DETECT_CHUNK_CHARS) {
    add(await analyseWithContent(buildTextContent(text)));
  } else {
    const chunks = chunkLines(text.split('\n'), DETECT_CHUNK_CHARS);
    logger.info(`analyseTextAnySize: ${text.length} chars → ${chunks.length} detection chunk(s)`);
    // Run chunks with limited concurrency — order does not matter (results are
    // merged + deduped), and 3-wide keeps well inside the tenant rate limit
    // while cutting wall-clock time to roughly a third.
    const CONCURRENCY = 3;
    const results: RawAiSuggestion[][] = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        logger.info(`Detection chunk ${i + 1}/${chunks.length}`);
        results[i] = await analyseWithContent(buildTextContent(chunks[i].join('\n')));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    for (const part of results) add(part ?? []);
  }

  // Safety net: merge deterministic pattern-scanner hits (vendor codes, prices,
  // percentages, capacities) so values the AI overlooked — more likely in long
  // repetitive documents — are still masked. Over-masking beats leaking; the
  // review page lets the user uncheck any of these.
  const patternSuggestions: RawAiSuggestion[] = scanPatterns(text).map((h) => ({
    fieldName: h.category,
    originalValue: h.value,
    reason: 'Matched a known sensitive-data pattern',
    sensitivity: h.category === 'Percentage' ? 'medium' : 'high',
  }));
  const before = all.length;
  add(patternSuggestions);
  if (all.length > before) logger.info(`Pattern scanner added ${all.length - before} value(s) the AI missed`);

  return all;
}

/** Fallback plain-text content when native document block is not available. */
function buildTextContent(documentText: string): ContentBlock[] {
  return [{
    text: (
      'Scan the following vendor pricing document. Extract ONLY Vendor Names, Prices, and Percentages ' +
      'as specified in your instructions. Return a valid JSON array — nothing else.\n\n' +
      documentText
    ),
  }];
}

// --- Streaming with sync fallback --------------------------------------------

async function tryConverseStream(
  token: string,
  content: ContentBlock[],
  onChunk: (delta: string) => void
): Promise<RawAiSuggestion[]> {
  const deployment = await resolveDeployment();
  const url = `${config.aiCore.inferenceUrl}/v2/inference/deployments/${deployment.id}/converse-stream`;
  const payload = {
    messages: [{ role: 'user', content }],
    system: [{ text: SYSTEM_PROMPT }],
    inferenceConfig: { maxTokens: 8192 },
  };
  const resp = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'AI-Resource-Group': config.aiCore.resourceGroup },
    responseType: 'stream',
    timeout: 180_000,
  });
  // SAP AI Core streaming uses text SSE with Python-style single-quoted dicts
  return new Promise((resolve, reject) => {
    let fullText = '';
    let textBuf = '';
    let resolved = false;
    const tryResolve = (text: string) => {
      if (resolved) return; resolved = true;
      try { resolve(parseJsonFromText(text)); } catch (err) { reject(err); }
    };
    const extractDelta = (line: string): string | null => {
      if (!line.startsWith('data: ') || !line.includes('contentBlockDelta')) return null;
      const m = line.match(/'text':\s*'((?:[^'\\]|\\.)*)'/);
      if (!m) return null;
      return m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\').replace(/\\'/g, "'");
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = resp.data as any;
    stream.on('data', (chunk: Buffer) => {
      textBuf += chunk.toString('utf8');
      const lines = textBuf.split('\n');
      textBuf = lines.pop() ?? '';
      for (const line of lines) {
        const delta = extractDelta(line.trim());
        if (delta !== null) { fullText += delta; onChunk(delta); }
        else if (line.includes('messageStop')) tryResolve(fullText);
      }
    });
    stream.on('error', (err: Error) => reject(err));
    stream.on('end', () => fullText ? tryResolve(fullText) : reject(new Error('converse-stream: no text received')));
  });
}

// --- Sync /converse with retry -----------------------------------------------

const MAX_ATTEMPTS = 3;

async function converseOnce(content: ContentBlock[]): Promise<RawAiSuggestion[]> {
  const token = await getToken();
  const deployment = await resolveDeployment();
  const url = `${config.aiCore.inferenceUrl}/v2/inference/deployments/${deployment.id}/converse`;
  logger.info('Calling /converse (sync)');
  const payload = {
    messages: [{ role: 'user', content }],
    system: [{ text: SYSTEM_PROMPT }],
    inferenceConfig: { maxTokens: 8192 },
  };
  interface ConverseResp { output: { message: { content: Array<{ text?: string }> } }; }
  const resp = await axios.post<ConverseResp>(url, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'AI-Resource-Group': config.aiCore.resourceGroup },
    timeout: 180_000,
  });
  const rawText = resp.data?.output?.message?.content?.[0]?.text ?? '';
  logger.info('/converse response received', { length: rawText.length });
  logger.debug('/converse full text', { rawText });
  return parseJsonFromText(rawText);
}

async function analyseWithContent(content: ContentBlock[]): Promise<RawAiSuggestion[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await converseOnce(content);
    } catch (err) {
      lastErr = err;
      if (isDeploymentNotFound(err)) invalidateDeployment();
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`/converse attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// --- Public API --------------------------------------------------------------

/**
 * Primary analysis path: sends the original file bytes to Claude as a native
 * document block so Claude reads it with full visual/layout fidelity (tables,
 * multi-line cells, formatting) — identical to a direct upload to Claude.ai.
 *
 * Falls back to plain-text extraction if the document block call fails
 * (e.g. unsupported format, file too large, API version mismatch).
 */
export async function analyseDocumentNativeStream(
  fileBuffer: Buffer,
  fileType: string,
  fallbackText: string,
  onChunk: (delta: string) => void
): Promise<RawAiSuggestion[]> {
  const token = await getToken();

  // Files over the document-block payload limit are guaranteed to be rejected
  // by AI Core (base64 inflates them past ~4.5 MB) — go straight to the text
  // path instead of burning minutes on two doomed attempts.
  // Skip the native attempts when they are guaranteed to fail: files over the
  // document-block payload limit, or text so large the document must exceed
  // the model's native page limit — go straight to (chunked) text detection.
  if (fileBuffer.length > config.limits.maxAiFileBytes || fallbackText.length > DETECT_CHUNK_CHARS) {
    logger.info(
      `File ${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB / text ${fallbackText.length} chars — ` +
      'over native document-block limits, using text extraction directly'
    );
    const textSuggestions = await analyseTextAnySize(fallbackText);
    onChunk(JSON.stringify(textSuggestions, null, 2));
    return textSuggestions;
  }

  // ── 1. Try native document block (streaming) ───────────────────────────────
  try {
    logger.info(`Attempting native document block stream (${fileType})`);
    const content = buildDocumentContent(fileBuffer, fileType);
    const suggestions = await tryConverseStream(token, content, onChunk);
    if (suggestions.length > 0) {
      logger.info(`Native document stream succeeded: ${suggestions.length} suggestion(s)`);
      return suggestions;
    }
    logger.warn('Native document stream returned empty — trying sync');
  } catch (err) {
    if (isDeploymentNotFound(err)) invalidateDeployment();
    logger.warn('Native document stream failed', err instanceof Error ? err.message : String(err));
  }

  // ── 2. Try native document block (sync fallback) ───────────────────────────
  try {
    logger.info(`Attempting native document block sync (${fileType})`);
    const content = buildDocumentContent(fileBuffer, fileType);
    const suggestions = await analyseWithContent(content);
    if (suggestions.length > 0) {
      onChunk(JSON.stringify(suggestions, null, 2));
      logger.info(`Native document sync succeeded: ${suggestions.length} suggestion(s)`);
      return suggestions;
    }
    logger.warn('Native document sync returned empty — falling back to text');
  } catch (err) {
    logger.warn('Native document sync failed', err instanceof Error ? err.message : String(err));
  }

  // ── 3. Plain-text fallback ─────────────────────────────────────────────────
  logger.info('Falling back to plain-text extraction');
  const textSuggestions = await analyseTextAnySize(fallbackText);
  onChunk(JSON.stringify(textSuggestions, null, 2));
  return textSuggestions;
}

/** Legacy text-only path — kept for direct testing / CLI smoke tests. */
export async function analyseDocumentStream(
  documentText: string,
  onChunk: (delta: string) => void
): Promise<RawAiSuggestion[]> {
  const token = await getToken();
  const content = buildTextContent(documentText);
  try {
    logger.info('Attempting text converse-stream');
    const suggestions = await tryConverseStream(token, content, onChunk);
    if (suggestions.length > 0) return suggestions;
    logger.warn('Text stream returned empty — falling back to sync');
  } catch (err) {
    logger.warn('Text stream failed, falling back', err instanceof Error ? err.message : String(err));
  }
  logger.info('Using sync /converse text fallback');
  const suggestions = await analyseWithContent(content);
  onChunk(JSON.stringify(suggestions, null, 2));
  return suggestions;
}

/** Kept for backward compatibility (smoke-test script). */
export async function analyseDocument(documentText: string): Promise<RawAiSuggestion[]> {
  return analyseWithContent(buildTextContent(documentText));
}
