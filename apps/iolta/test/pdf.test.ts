// PDF import regression test (audit issue #12).
// Reproduces the "every PDF upload throws" bug: the old code called the
// pdf-parse v1 default export as a function, but v2 ships a PDFParse class.
// Builds a tiny valid PDF in-memory and asserts extractPdfText returns its
// text — the exact server.ts path an uploaded bank statement takes.
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import { extractPdfText } from '../src/pdf';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// Minimal single-page PDF with one Helvetica text line. All bytes are ASCII,
// so string length equals byte length and the xref offsets are exact.
function buildPdf(text: string): Buffer {
  const bodies = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    '', // contents stream, filled below
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  bodies[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<</Size ${bodies.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function main() {
  await test('extractPdfText pulls text from a real PDF (v2 class API, not v1 call)', async () => {
    const marker = 'IOLTA STATEMENT 1234.56';
    const text = await extractPdfText(buildPdf(marker));
    assert.equal(typeof text, 'string');
    assert.match(text, /IOLTA STATEMENT/);
    assert.match(text, /1234\.56/);
  });

  await test('extractPdfText accepts a Uint8Array as well as a Buffer', async () => {
    const buf = buildPdf('RECEIPT 500.00');
    const text = await extractPdfText(new Uint8Array(buf));
    assert.match(text, /RECEIPT/);
  });

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
