/**
 * Deterministic document diff: parse -> align -> word diff.
 *
 * Nothing in this file calls a language model. That is deliberate: the answer
 * to "what changed, exactly?" must never be hallucinated. The model only gets
 * involved later, in agent.js, to judge how much a change matters.
 */

const TOKEN_RE = /\s+|\S+/g;

/** Word-count product above which we stop doing token-level LCS. */
const TOKEN_DIFF_LIMIT = 400_000;

/**
 * Split a document into addressable blocks (headings, paragraphs, list items,
 * table rows). Stable IDs let the UI and the agent point at exact places.
 */
export function parseBlocks(text, side) {
  const normalizedNewlines = String(text ?? '').replace(/\r\n?/g, '\n');
  const chunks = [];
  let buffer = [];

  const flush = () => {
    if (buffer.length > 0) {
      chunks.push(buffer.join('\n'));
      buffer = [];
    }
  };

  for (const line of normalizedNewlines.split('\n')) {
    if (line.trim() === '') flush();
    else buffer.push(line);
  }
  flush();

  let section = '';
  return chunks.map((chunk, index) => {
    const blockText = chunk.trim();
    const kind = classifyKind(blockText);
    if (kind === 'heading') section = blockText.replace(/^#{1,6}\s*/, '');
    return {
      id: `${side}-${index + 1}`,
      kind,
      section,
      text: blockText,
      norm: normalize(blockText),
    };
  });
}

function classifyKind(text) {
  if (/^#{1,6}\s/.test(text)) return 'heading';
  if (/^\|/.test(text)) return 'table';
  if (/^\s{0,3}([-*+]|\d+[.)])\s/.test(text)) return 'list';
  return 'paragraph';
}

/** Comparison form: case, spacing and smart punctuation stop mattering. */
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Longest-common-subsequence table. Small documents only, guarded by callers.
 */
function lcsTable(a, b, equals) {
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] = equals(a[i], b[j])
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Turn an LCS table into a flat list of eq / del / ins operations. */
function walk(table, a, b, equals) {
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (equals(a[i], b[j])) {
      ops.push({ op: 'eq', before: a[i], after: b[j] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ op: 'del', before: a[i], after: null });
      i++;
    } else {
      ops.push({ op: 'ins', before: null, after: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ op: 'del', before: a[i++], after: null });
  while (j < b.length) ops.push({ op: 'ins', before: null, after: b[j++] });
  return ops;
}

/** Merge adjacent operations that share a type, producing renderable segments. */
function toSegments(ops) {
  const segments = [];
  for (const item of ops) {
    const text = item.op === 'ins' ? item.after : item.before;
    const last = segments[segments.length - 1];
    if (last && last.op === item.op) last.text += text;
    else segments.push({ op: item.op, text });
  }
  return segments;
}

/** Word-level diff inside a single changed block. */
export function wordDiff(before, after) {
  const a = before.match(TOKEN_RE) ?? [];
  const b = after.match(TOKEN_RE) ?? [];

  if (a.length * b.length > TOKEN_DIFF_LIMIT) {
    return [
      { op: 'del', text: before },
      { op: 'ins', text: after },
    ];
  }

  const equals = (x, y) => x === y || x.toLowerCase() === y.toLowerCase();
  return toSegments(walk(lcsTable(a, b, equals), a, b, equals));
}

/**
 * Compare two documents and return the list of changed regions.
 *
 * Blocks are aligned first, then paired across a gap, so inserting one
 * paragraph near the top does not mark the rest of the document as changed.
 */
export function compare(beforeText, afterText) {
  const beforeBlocks = parseBlocks(beforeText, 'before');
  const afterBlocks = parseBlocks(afterText, 'after');

  if (beforeBlocks.length * afterBlocks.length > 250_000) {
    throw new Error('Document too large for this proof of concept (try fewer than 300 blocks).');
  }

  const equals = (x, y) => x.norm === y.norm;
  const ops = walk(lcsTable(beforeBlocks, afterBlocks, equals), beforeBlocks, afterBlocks, equals);

  const changes = [];
  let pendingBefore = [];
  let pendingAfter = [];
  let counter = 0;
  const nextId = () => `c${++counter}`;

  const flushGap = () => {
    if (pendingBefore.length === 0 && pendingAfter.length === 0) return;
    const pairs = Math.min(pendingBefore.length, pendingAfter.length);

    for (let k = 0; k < pairs; k++) {
      const from = pendingBefore[k];
      const to = pendingAfter[k];
      changes.push({
        id: nextId(),
        type: 'modified',
        section: from.section || to.section || '',
        beforeIds: [from.id],
        afterIds: [to.id],
        before: from.text,
        after: to.text,
        segments: wordDiff(from.text, to.text),
      });
    }

    // Leftover blocks on either side form one contiguous region: a new clause
    // with its heading is one change, not two cards.
    if (pendingBefore.length > pairs) {
      const rest = pendingBefore.slice(pairs);
      const text = rest.map((block) => block.text).join('\n\n');
      changes.push({
        id: nextId(),
        type: 'removed',
        section: rest[0].section || '',
        beforeIds: rest.map((block) => block.id),
        afterIds: [],
        before: text,
        after: '',
        segments: [{ op: 'del', text }],
      });
    }

    if (pendingAfter.length > pairs) {
      const rest = pendingAfter.slice(pairs);
      const text = rest.map((block) => block.text).join('\n\n');
      changes.push({
        id: nextId(),
        type: 'added',
        section: rest[0].section || '',
        beforeIds: [],
        afterIds: rest.map((block) => block.id),
        before: '',
        after: text,
        segments: [{ op: 'ins', text }],
      });
    }

    pendingBefore = [];
    pendingAfter = [];
  };

  for (const item of ops) {
    if (item.op === 'eq') {
      flushGap();
    } else if (item.op === 'del') {
      pendingBefore.push(item.before);
    } else {
      pendingAfter.push(item.after);
    }
  }
  flushGap();

  return {
    changes,
    stats: {
      blocksBefore: beforeBlocks.length,
      blocksAfter: afterBlocks.length,
      total: changes.length,
      modified: changes.filter((c) => c.type === 'modified').length,
      added: changes.filter((c) => c.type === 'added').length,
      removed: changes.filter((c) => c.type === 'removed').length,
    },
  };
}
