/**
 * Generates the binary test fixtures (DOCX and PDF) from the Markdown samples.
 *
 * Checked in so the extraction tests are reproducible, and dependency-free so
 * regenerating them never needs a toolchain beyond Node.
 *
 *   npm run fixtures
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/* ------------------------------------------------------------------ */
/* Markdown -> blocks                                                  */
/* ------------------------------------------------------------------ */

function parseMarkdown(markdown) {
  const blocks = [];
  let paragraph = [];

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();

    if (line === '') {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (line.startsWith('|')) {
      flush();
      const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      if (cells.every((cell) => /^-{2,}$/.test(cell))) continue;
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === 'table') previous.rows.push(cells);
      else blocks.push({ kind: 'table', rows: [cells] });
      continue;
    }

    paragraph.push(line);
  }

  flush();
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Markdown -> DOCX                                                    */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer using stored (uncompressed) entries. */
function zipStored(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name]));

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, directory, end]);
}

const escapeXml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function docxParagraph(text, style) {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function docxTable(rows) {
  const cell = (text) =>
    `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p></w:tc>`;
  const body = rows.map((row) => `<w:tr>${row.map(cell).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${body}</w:tbl>`;
}

function buildDocx(blocks) {
  const body = blocks
    .map((block) => {
      if (block.kind === 'heading') return docxParagraph(block.text, `Heading${Math.min(block.level, 6)}`);
      if (block.kind === 'table') return docxTable(block.rows) + '<w:p/>';
      return docxParagraph(block.text);
    })
    .join('\n');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return zipStored([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: relationships },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

/* ------------------------------------------------------------------ */
/* Markdown -> PDF                                                     */
/* ------------------------------------------------------------------ */

const escapePdfText = (text) =>
  String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildPdf(blocks) {
  const operations = [];
  let y = 760;

  for (const block of blocks) {
    if (y < 70) break; // One page is enough for a fixture.

    if (block.kind === 'heading') {
      operations.push(`BT /F1 16 Tf 56 ${y} Td (${escapePdfText(block.text)}) Tj ET`);
      y -= 20;
      y -= 14;
      continue;
    }

    if (block.kind === 'table') {
      for (const row of block.rows) {
        operations.push(`BT /F1 11 Tf 56 ${y} Td (${escapePdfText(row.join('  |  '))}) Tj ET`);
        y -= 15;
      }
      y -= 12;
      continue;
    }

    for (const line of wrap(block.text, 88)) {
      operations.push(`BT /F1 11 Tf 56 ${y} Td (${escapePdfText(line)}) Tj ET`);
      y -= 15;
    }
    y -= 12;
  }

  const content = operations.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/* ------------------------------------------------------------------ */

/**
 * An image-only PDF: one page, one image XObject, zero text operators.
 * This is what a scanned document looks like to the extractor, and it is the
 * fixture behind the "this PDF is a scan" message.
 */
function buildScannedPdf() {
  const width = 16;
  const height = 16;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) % 256;

  const content = 'q 540 0 0 720 36 36 cm /Im1 Do Q';
  const latin1 = (text) => Buffer.from(text, 'latin1');

  const objects = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    latin1(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    latin1(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.concat([
      latin1(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
      ),
      pixels,
      latin1('\nendstream'),
    ]),
  ];

  const chunks = [latin1('%PDF-1.4\n')];
  let offset = chunks[0].length;
  const offsets = [];

  objects.forEach((body, index) => {
    const head = latin1(`${index + 1} 0 obj\n`);
    const tail = latin1('\nendobj\n');
    offsets.push(offset);
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });

  chunks.push(latin1(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (const value of offsets) {
    chunks.push(latin1(`${String(value).padStart(10, '0')} 00000 n \n`));
  }
  chunks.push(
    latin1(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`),
  );

  return Buffer.concat(chunks);
}

async function main() {
  await mkdir(FIXTURES, { recursive: true });

  for (const version of ['v1', 'v2']) {
    const markdown = await readFile(path.join(ROOT, 'samples', `policy-${version}.md`), 'utf8');
    const blocks = parseMarkdown(markdown);

    const docx = buildDocx(blocks);
    await writeFile(path.join(FIXTURES, `policy-${version}.docx`), docx);

    const pdf = buildPdf(blocks);
    await writeFile(path.join(FIXTURES, `policy-${version}.pdf`), pdf);

    console.log(`policy-${version}: ${blocks.length} blocks -> .docx ${docx.length} bytes, .pdf ${pdf.length} bytes`);
  }

  const scanned = buildScannedPdf();
  await writeFile(path.join(FIXTURES, 'scanned-v1.pdf'), scanned);
  console.log(`scanned-v1: image-only PDF, ${scanned.length} bytes (no text layer)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
