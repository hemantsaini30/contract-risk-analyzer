// Builds the sample contracts (DOCX + PDF + TXT) from data/contracts_src/*.txt
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(dir, '../data/contracts_src');
const out = path.join(dir, '../data/contracts');
await fs.mkdir(out, { recursive: true });

const FORMATS = { '01_apex_dynamics_nda': 'docx', '02_globex_nda': 'pdf', '03_initech_nda': 'txt' };

for (const [base, fmt] of Object.entries(FORMATS)) {
  const text = await fs.readFile(path.join(src, `${base}.txt`), 'utf8');
  const paras = text.split('\n').map((l) => l.trimEnd());
  const target = path.join(out, `${base}.${fmt}`);

  if (fmt === 'txt') {
    await fs.writeFile(target, text);
  } else if (fmt === 'docx') {
    const doc = new Document({
      sections: [{
        children: paras.filter((l, i) => l || i === 0).map((l, i) =>
          i === 0
            ? new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: l, bold: true })] })
            : new Paragraph({ spacing: { after: 160 }, children: [new TextRun(l)] })),
      }],
    });
    await fs.writeFile(target, await Packer.toBuffer(doc));
  } else {
    await new Promise((resolve, reject) => {
      const pdf = new PDFDocument({ margin: 60, pdfVersion: '1.4' });
      const chunks = [];
      pdf.on('data', (c) => chunks.push(c));
      pdf.on('end', async () => { await fs.writeFile(target, Buffer.concat(chunks)); resolve(); });
      pdf.on('error', reject);
      paras.forEach((l, i) => {
        if (!l) return;
        pdf.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 0 ? 16 : 11).text(l, { paragraphGap: 8 });
      });
      pdf.end();
    });
  }
  console.log('built', path.basename(target));
}
