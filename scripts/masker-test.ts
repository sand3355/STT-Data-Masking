/**
 * Offline test for format-preserving maskers (xlsx / csv / docx).
 *
 *   npx tsx scripts/masker-test.ts
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { maskXlsx, maskCsv, maskDocx } from '../src/services/file-masker.js';

const VALUES = ['SG-01', 'Acme Corp Pte Ltd', 'SGD 150,000,000', '15%', '1,500,000'];

async function testXlsx() {
  console.log('── XLSX ──');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Pricing');
  ws.columns = [{ width: 24 }, { width: 20 }];
  const header = ws.addRow(['Item', 'Value']);
  header.font = { bold: true };
  ws.addRow(['Vendor', 'SG-01']);
  ws.addRow(['Company', 'Acme Corp Pte Ltd']);
  const contract = ws.addRow(['Contract', 150000000]);
  contract.getCell(2).numFmt = '"SGD" #,##0';
  const pct = ws.addRow(['Discount', 0.15]);
  pct.getCell(2).numFmt = '0%';
  ws.addRow(['Note', 'Vendor SG-01 charges SGD 150,000,000 total']);
  ws.addRow(['Country', 'Singapore']); // must stay untouched
  const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);

  const masked = await maskXlsx(buf, VALUES);

  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(masked as unknown as ArrayBuffer);
  const ws2 = wb2.getWorksheet('Pricing')!;
  const cell = (r: number, c: number) => ws2.getRow(r).getCell(c).value;

  const checks: Array<[string, boolean]> = [
    ['vendor code masked',        cell(2, 2) === 'XXXX'],
    ['company name masked',       cell(3, 2) === 'XXXX'],
    ['numeric contract masked',   cell(4, 2) === 'XXXX'],
    ['percent cell masked',       cell(5, 2) === 'XXXX'],
    ['inline text masked',        cell(6, 2) === 'Vendor XXXX charges XXXX total'],
    ['untouched cell intact',     cell(7, 2) === 'Singapore'],
    ['label column intact',       cell(2, 1) === 'Vendor'],
    ['header still bold',         ws2.getRow(1).getCell(1).font?.bold === true],
    ['numFmt preserved',          ws2.getRow(4).getCell(2).numFmt === '"SGD" #,##0'],
    ['column width preserved',    Math.round(ws2.getColumn(1).width ?? 0) === 24],
  ];
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}`);
    if (!ok) throw new Error(`XLSX check failed: ${name} (got: ${JSON.stringify(cell(6, 2))})`);
  }
}

function testCsv() {
  console.log('── CSV ──');
  const src = '\uFEFFItem,Value\nVendor,SG-01\nContract,"SGD 150,000,000"\nDiscount,15%\nCountry,Singapore\n';
  const masked = maskCsv(Buffer.from(src, 'utf8'), VALUES).toString('utf8');
  const checks: Array<[string, boolean]> = [
    ['BOM preserved',        masked.startsWith('\uFEFF')],
    ['vendor masked',        masked.includes('Vendor,XXXX')],
    ['price masked',         masked.includes('"XXXX"')],
    ['percent masked',       masked.includes('Discount,XXXX')],
    ['untouched row intact', masked.includes('Country,Singapore')],
  ];
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}`);
    if (!ok) throw new Error(`CSV check failed: ${name}\n${masked}`);
  }
}

async function makeDocx(): Promise<Buffer> {
  // Minimal but valid .docx — note "SGD 150,000,000" is SPLIT across two runs,
  // exactly how Word fragments text in real documents
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Vendor Pricing Agreement</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Primary vendor: SG-01 (Acme Corp Pte Ltd)</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Total value: SGD 150,</w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>000,000</w:t></w:r>
      <w:r><w:t xml:space="preserve"> with a discount of 15% applied.</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t>Delivery location: Singapore</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function testDocx() {
  console.log('── DOCX ──');
  const buf = await makeDocx();
  const masked = await maskDocx(buf, VALUES);

  const { value: text } = await mammoth.extractRawText({ buffer: masked });
  const checks: Array<[string, boolean]> = [
    ['vendor code masked',           text.includes('Primary vendor: XXXX (XXXX)')],
    ['split-run price masked',       text.includes('Total value: XXXX with')],
    ['percentage masked',            text.includes('discount of XXXX applied')],
    ['heading intact',               text.includes('Vendor Pricing Agreement')],
    ['untouched paragraph intact',   text.includes('Delivery location: Singapore')],
    ['no residue of original value', !text.includes('150,') && !text.includes('000,000')],
  ];
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}`);
    if (!ok) throw new Error(`DOCX check failed: ${name}\n${text}`);
  }
}

(async () => {
  await testXlsx();
  testCsv();
  await testDocx();
  console.log('\nALL MASKER TESTS PASSED');
})().catch((err) => { console.error(err); process.exit(1); });
