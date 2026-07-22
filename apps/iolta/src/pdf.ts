/**
 * PDF text extraction for uploaded bank statements (audit issue #12).
 *
 * pdf-parse@2 is a CLASS API — `new PDFParse({ data }).getText()` — not the
 * v1 callable default export. The old `await pdf(buffer)` call threw on every
 * upload ("pdf is not a function"), so IOLTA's PDF statement import was dead.
 * Isolating the extraction here keeps server.ts thin and makes the parser
 * testable against a real PDF fixture without booting the HTTP server.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// v1 @types/pdf-parse is still installed (transitively), so the class export
// is untyped here; require() returns the real v2 runtime shape regardless.
const { PDFParse } = require('pdf-parse') as { PDFParse: new (opts: { data: Uint8Array | ArrayBuffer }) => PdfParser };

interface PdfParser {
  getText(): Promise<{ text: string }>;
  destroy(): Promise<void>;
}

/** Extract the concatenated document text from a PDF buffer. */
export async function extractPdfText(data: Buffer | Uint8Array): Promise<string> {
  // PDFParse's constructor converts a Node Buffer to Uint8Array itself, but be
  // explicit so the type is a plain Uint8Array either way.
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}
