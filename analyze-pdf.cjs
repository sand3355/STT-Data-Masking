// Quick diagnostic: dump every text item from both PDFs
// Run with: node analyze-pdf.cjs
const path = require('path');

async function main() {
  // Use the already-installed pdfjs-dist
  const pdfjs = require(path.join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.js'));
  pdfjs.GlobalWorkerOptions.workerSrc = '';

  const files = [
    { label: 'ORIGINAL', file: 'C:\\Users\\Sandeep B\\Downloads\\Sample Vendor Pricing_2.pdf' },
    { label: 'MASKED',   file: 'C:\\Users\\Sandeep B\\Downloads\\Sample Vendor Pricing_2-masked (2).pdf' },
  ];

  const fs = require('fs');

  for (const { label, file } of files) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${label}: ${file}`);
    console.log('='.repeat(70));

    const buf  = fs.readFileSync(file);
    const uint8 = new Uint8Array(buf);
    const pdf  = await pdfjs.getDocument({ data: uint8, verbosity: 0, disableFontFace: true }).promise;

    for (let pn = 1; pn <= pdf.numPages; pn++) {
      const page = await pdf.getPage(pn);
      const tc   = await page.getTextContent({ includeMarkedContent: false });
      console.log(`\n--- Page ${pn} (${tc.items.length} items) ---`);

      for (const rawItem of tc.items) {
        const item = rawItem;
        if (!item.str || !item.str.trim()) continue;
        const [a=10,b=0,,, e=0, f=0] = item.transform || [];
        const fs2 = Math.round(Math.sqrt(a*a+b*b));
        console.log(`  x=${Math.round(e).toString().padStart(4)} y=${Math.round(f).toString().padStart(4)} w=${Math.round(item.width||0).toString().padStart(4)} sz=${fs2} | "${item.str}"`);
      }
    }
  }
}

main().catch(console.error);
