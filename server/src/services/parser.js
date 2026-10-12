import path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/** Turn an uploaded file (PDF / DOCX / TXT / MD) into plain text. */
export async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  let text;
  if (ext === '.pdf') {
    // pdf-parse (old pdf.js inside) sometimes fails on the very first call in a fresh process; one retry fixes it
    let data;
    try { data = await pdfParse(buffer); } catch { data = await pdfParse(buffer); }
    text = data.text;
  } else if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    text = value;
  } else if (ext === '.txt' || ext === '.md') {
    text = buffer.toString('utf8');
  } else {
    throw new Error(`Unsupported file type "${ext}". Use PDF, DOCX or TXT.`);
  }
  text = text.replace(/\r/g, '').replace(/\u00A0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 50) throw new Error('Could not extract text (scanned PDF? OCR is not included).');
  return text;
}
