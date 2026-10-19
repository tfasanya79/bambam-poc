/**
 * Text extraction for uploaded documents.
 *
 * Everything downstream (block parsing, diffing, classification) works on plain
 * text, so this is the only place that knows about file formats. Adding a new
 * format means adding one branch here and nothing else.
 *
 * Extraction is lossy by nature. When it fails badly, say so instead of
 * returning an empty document that silently compares as "no changes".
 */

import path from 'node:path';

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);
const MIN_USEFUL_CHARS = 40;

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.md', '.txt'];

export function isSupported(filename) {
  const ext = path.extname(String(filename ?? '')).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext) || ext === '.pdf' || ext === '.docx';
}

/**
 * @returns {Promise<{text: string, info: object}>}
 */
export async function extractText(buffer, filename) {
  const ext = path.extname(String(filename ?? '')).toLowerCase();
  const base = { filename: filename || 'document', bytes: buffer.length };

  if (ext === '' || TEXT_EXTENSIONS.has(ext)) {
    return {
      text: cleanup(buffer.toString('utf8')),
      info: { ...base, kind: 'text', warning: null },
    };
  }

  if (ext === '.docx') return extractDocx(buffer, base);
  if (ext === '.pdf') return extractPdf(buffer, base);

  throw new Error(`Unsupported file type "${ext}". Upload a PDF, DOCX, MD or TXT file.`);
}

function cleanup(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripInline(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mammoth gives us HTML, which we translate to the Markdown shape the block
 * parser already understands. This keeps headings, lists and tables intact, so
 * a Word document is not flattened into one anonymous run of paragraphs.
 */
function htmlToMarkdown(html) {
  let out = String(html);

  out = out.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => stripInline(cell[1])),
    );
    if (rows.length === 0) return '\n\n';
    const header = rows[0];
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
    ];
    return `\n\n${lines.join('\n')}\n\n`;
  });

  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => {
    return `\n\n${'#'.repeat(Number(level))} ${stripInline(inner)}\n\n`;
  });

  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner) => `\n- ${stripInline(inner)}`);

  out = out.replace(/<\/(p|div|ul|ol|tr)>/gi, '\n\n');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');

  return decodeEntities(out);
}

async function extractDocx(buffer, base) {
  const mammoth = (await import('mammoth')).default;

  let text = '';
  const notes = [];
  try {
    const result = await mammoth.convertToHtml({ buffer });
    text = htmlToMarkdown(result.value ?? '');
    for (const message of result.messages ?? []) notes.push(message.message);
  } catch {
    // Fall through to the plain-text reader below.
  }

  if (text.trim().length < MIN_USEFUL_CHARS) {
    const raw = await mammoth.extractRawText({ buffer });
    if (raw.value && raw.value.trim().length > text.trim().length) text = raw.value;
  }

  const clean = cleanup(text);
  return {
    text: clean,
    info: {
      ...base,
      kind: 'docx',
      warning:
        clean.length < MIN_USEFUL_CHARS
          ? 'Almost no text could be read from this Word file. It may be image-only.'
          : null,
      notes: notes.slice(0, 3),
    },
  };
}

/** Group PDF text items into visual lines, then merge lines into paragraphs. */
function paragraphsFromItems(items) {
  const lines = [];
  let current = null;

  for (const item of items) {
    const str = item.str ?? '';
    if (str.trim() === '') {
      if (item.hasEOL && current) {
        lines.push(current);
        current = null;
      }
      continue;
    }

    const y = item.transform?.[5] ?? 0;
    const size = Math.abs(item.height ?? item.transform?.[3] ?? 11) || 11;

    if (!current) {
      current = { y, size, parts: [str] };
    } else if (Math.abs(current.y - y) <= Math.max(2, size * 0.35)) {
      current.parts.push(str);
    } else {
      lines.push(current);
      current = { y, size, parts: [str] };
    }

    if (item.hasEOL) {
      lines.push(current);
      current = null;
    }
  }
  if (current) lines.push(current);

  if (lines.length === 0) return '';

  const sizes = lines.map((line) => line.size).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] || 11;
  const paragraphGap = bodySize * 1.6;

  const blocks = [];
  let paragraph = [];
  let previousY = null;

  for (const line of lines) {
    const text = line.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const isHeading = line.size > bodySize * 1.15 && text.length < 120 && !/[.;:]$/.test(text);

    if (isHeading) {
      if (paragraph.length > 0) {
        blocks.push(paragraph.join(' '));
        paragraph = [];
      }
      blocks.push(`## ${text}`);
      previousY = line.y;
      continue;
    }

    if (previousY !== null && Math.abs(previousY - line.y) > paragraphGap && paragraph.length > 0) {
      blocks.push(paragraph.join(' '));
      paragraph = [];
    }
    paragraph.push(text);
    previousY = line.y;
  }
  if (paragraph.length > 0) blocks.push(paragraph.join(' '));

  return blocks.join('\n\n');
}

/**
 * Work out *why* a PDF yielded no text. "It is probably a scan" is a guess; the
 * page operators tell us the answer, and the right remedy differs sharply:
 * a scan needs OCR, a broken text layer needs a different export.
 */
async function explainEmptyPdf(document, pdfjs, pageCount) {
  const ops = pdfjs.OPS ?? {};
  const numbers = (values) => values.filter((value) => typeof value === 'number');
  const imageOps = new Set(
    numbers([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject, ops.paintJpegXObject]),
  );
  const textOps = new Set(numbers([ops.showText, ops.showSpacedText]));

  let images = 0;
  let textRuns = 0;

  try {
    for (let pageNumber = 1; pageNumber <= Math.min(pageCount, 3); pageNumber++) {
      const page = await document.getPage(pageNumber);
      const operatorList = await page.getOperatorList();
      for (const fn of operatorList.fnArray ?? []) {
        if (imageOps.has(fn)) images += 1;
        else if (textOps.has(fn)) textRuns += 1;
      }
      page.cleanup();
    }
  } catch {
    return 'Almost no text could be read from this PDF. It may be a scan, which needs OCR before it can be compared.';
  }

  if (textRuns === 0 && images > 0) {
    return 'This PDF is a scan: the page is an image with no text layer at all. It needs OCR, or a text or Word version of the same document.';
  }
  if (textRuns > 0) {
    return 'This PDF contains text, but none of it could be decoded. That usually means unusual embedded font encoding. Try exporting the document as Word, or re-saving it as a fresh PDF.';
  }
  return 'This PDF has no readable text and no images. It may be empty, or an unsupported PDF variant.';
}

async function extractPdf(buffer, base) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // pdf.js resolves its built-in font metrics from this URL. Without it, text
  // from standard fonts (Helvetica et al) can come back garbled.
  const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href;

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl,
    // Only surface real errors: we extract text and never render, so missing
    // font assets are noise. Extracted text is unaffected.
    verbosity: 0,
  });

  const document = await loadingTask.promise;
  const pageCount = document.numPages;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(paragraphsFromItems(content.items ?? []));
      page.cleanup();
    }

    const clean = cleanup(pages.join('\n\n'));
    const warning = clean.length < MIN_USEFUL_CHARS ? await explainEmptyPdf(document, pdfjs, pageCount) : null;

    return { text: clean, info: { ...base, kind: 'pdf', pages: pageCount, warning } };
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new Error('this PDF is password protected. Remove the password and upload it again');
    }
    throw error;
  } finally {
    await document.cleanup?.();
    await loadingTask.destroy();
  }
}
