/**
 * Offline smoke test — exercises the pattern scanner, reconciliation engine,
 * and PDF redactor without calling SAP AI Core.
 *
 *   npx tsx scripts/smoke-test.ts
 */
import PDFDocument from 'pdfkit';
import { reconcile, scanPatterns, RawAiSuggestion } from '../src/services/detection-engine.js';
import { redactPdf } from '../src/services/pdf-redactor.js';
import fs from 'fs';
import path from 'path';

const SAMPLE_TEXT = [
  'Vendor Pricing Summary — Q2 2026',
  '',
  'Vendor: SG-01 (Acme Corp Pte Ltd)',
  'Total Contract Value: SGD 150,000,000',
  'Unit Price: USD 2,500 per licence',
  'Discount Rate: 15%',
  'Margin: 7.5 %',
  'Secondary Vendor: MY-02 (PT Jaya Perkasa)',
  'Subtotal: 1,500,000',
].join('\n');

async function makeSamplePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(14).text('Vendor Pricing Summary — Q2 2026');
    doc.moveDown();
    doc.fontSize(10);
    for (const line of SAMPLE_TEXT.split('\n').slice(2)) doc.text(line);
    doc.end();
  });
}

async function main() {
  console.log('── 1. Pattern scanner ──');
  const hits = scanPatterns(SAMPLE_TEXT);
  for (const h of hits) console.log(`  [${h.category}] "${h.value}"`);

  console.log('\n── 2. Reconciliation (simulated AI output) ──');
  const fakeAi: RawAiSuggestion[] = [
    { fieldName: 'Vendor Name', originalValue: 'SG-01', reason: 'Vendor code', sensitivity: 'high' },
    { fieldName: 'Vendor Name', originalValue: 'acme corp pte ltd', reason: 'Company name (wrong case on purpose)', sensitivity: 'high' },
    { fieldName: 'Price', originalValue: 'SGD 150,000,000', reason: 'Contract value', sensitivity: 'high' },
    { fieldName: 'Percentage', originalValue: '15%', reason: 'Discount', sensitivity: 'medium' },
    { fieldName: 'Price', originalValue: 'EUR 999,999', reason: 'Hallucinated — not in document', sensitivity: 'high' },
  ];
  const findings = reconcile(SAMPLE_TEXT, fakeAi);
  for (const f of findings) {
    console.log(
      `  ${f.fieldId.padEnd(16)} "${f.originalValue}" src=${f.source} conf=${f.confidence} ` +
      `occ=${f.occurrences} verified=${f.verified}`
    );
    if (f.context) console.log(`    ctx: ${f.context}`);
  }

  // Assertions
  const caseFix = findings.find((f) => f.originalValue === 'Acme Corp Pte Ltd');
  if (!caseFix) throw new Error('FAIL: case-correction did not restore document casing');
  const halluc = findings.find((f) => f.originalValue === 'EUR 999,999');
  if (!halluc || halluc.verified || halluc.confidence !== 40) throw new Error('FAIL: hallucination not flagged');
  const patternOnly = findings.filter((f) => f.source === 'pattern');
  if (patternOnly.length === 0) throw new Error('FAIL: pattern scanner found nothing the AI missed');
  console.log('  ✓ case-correction, hallucination flagging, and pattern fallback all work');

  console.log('\n── 3. PDF redaction ──');
  const pdf = await makeSamplePdf();
  const masked = findings.filter((f) => f.verified).map((f) => f.originalValue);
  const redacted = await redactPdf(pdf, masked);
  const outDir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'smoke-original.pdf'), pdf);
  fs.writeFileSync(path.join(outDir, 'smoke-redacted.pdf'), redacted);
  console.log(`  ✓ redacted PDF written to tmp/smoke-redacted.pdf (${redacted.length} bytes)`);

  console.log('\nALL SMOKE TESTS PASSED');
}

main().catch((err) => { console.error(err); process.exit(1); });
