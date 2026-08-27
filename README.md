# Data Masking

AI-powered redaction tool for vendor pricing documents. Upload a PDF, Excel, CSV, or
Word file; an AI scan (SAP AI Core / Claude) combined with a deterministic pattern
scanner finds **Vendor Names**, **Prices**, and **Percentages**; you review each
finding and download the masked document **in its original format** plus a forensic
audit log.

## How it works

```
Upload → Review → Export
```

1. **Upload** — drag in a `.pdf`, `.xlsx`, `.csv`, `.docx`, or legacy `.doc`
   (max 10 MB). Text is extracted with pdfjs / SheetJS / mammoth / word-extractor.
2. **AI + pattern scan** — the document text is sent to a Claude deployment on
   SAP AI Core. In parallel, a regex scanner independently hunts for prices,
   percentages, and vendor codes. The two result sets are reconciled:
   - every AI finding is **verified verbatim** against the document (hallucinations
     are flagged at 40% confidence instead of silently trusted),
   - values the AI missed but the scanner caught are added (75% confidence),
   - findings both agree on score 100%,
   - each finding gets an occurrence count and a context snippet.
3. **Review** — filter by category, search, mask/skip per row or in bulk.
4. **Export** — the output is the **same format as the input**, edited in place so
   only the sensitive values change and all other content/formatting is preserved:
   - **PDF** → dark-grey redaction bars with white `XXXX`, layout untouched
   - **XLSX** → cell values become `XXXX` (numeric cells matched against their
     formatted text, e.g. `150000000` vs "SGD 150,000,000"; styles, number formats,
     column widths, merges kept)
   - **DOCX** → text runs inside the OOXML are edited (values split across runs are
     handled); run formatting, tables, headers/footers untouched
   - **CSV** → plain-text replacement, BOM preserved
   - **DOC** (legacy Word 97–2003) → same-length binary overwrite: each value is
     replaced by `XXX…` padded to the value's exact character count (the OLE format
     stores absolute offsets, so lengths must not change); file opens normally in Word

   The audit log (JSON) records every field, its original value, decision,
   detection source, confidence, and the SHA-256 of the uploaded file.

## Running locally

Requires Node.js ≥ 18.

```bash
cp .env.example .env       # fill in your SAP AI Core service key values
npm install
npm install --prefix frontend

# dev (two terminals)
npm run dev                # backend on :3000
npm run dev:frontend       # Vite dev server on :5173 (proxies /api)

# or production-style (single server)
npm run build
npm start                  # serves API + built frontend on :3000
```

`SAP_AI_CORE_DEPLOYMENT_ID` may be left blank — at startup the server lists the
deployments in your resource group and auto-selects a running Claude deployment.

## Offline smoke test

Exercises the pattern scanner, reconciliation engine, PDF redactor, and the
format-preserving maskers without calling SAP AI Core:

```bash
npx tsx scripts/smoke-test.ts     # detection + PDF redaction
npx tsx scripts/masker-test.ts    # xlsx / csv / docx in-place masking
```

## Known PoC limitations

- **PDF** redaction is a visual overlay: bars are drawn on top of the text, but the
  original characters remain in the PDF content stream and are recoverable with
  copy-paste or text extraction. Do not use PDF output for genuinely confidential
  distribution without flattening pages to images first. (XLSX/CSV/DOCX masking is
  destructive — the original values really are removed from those files.)
- XLSX: formulas whose result matches a masked value are replaced by the literal
  `XXXX` (the formula is dropped); charts/pivot caches may not survive the
  ExcelJS round-trip.
- Jobs are held in memory (1-hour TTL) — no persistence across restarts.
