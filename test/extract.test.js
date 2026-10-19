import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractText } from '../src/extract.js';
import { compare } from '../src/diff.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function extractFixture(name) {
  const buffer = await readFile(path.join(FIXTURES, name));
  return extractText(buffer, name);
}

test('extraction recovers the same changes from DOCX and PDF as from Markdown', async () => {
  for (const ext of ['docx', 'pdf']) {
    const before = await extractFixture(`policy-v1.${ext}`);
    const after = await extractFixture(`policy-v2.${ext}`);

    assert.ok(before.text.length > 500, `${ext}: extracted text is too short to be useful`);
    assert.equal(before.info.warning, null, `${ext}: unexpected extraction warning`);

    const { changes } = compare(before.text, after.text);
    assert.equal(changes.length, 7, `${ext}: expected the same seven changes as the Markdown baseline`);
  }
});

test('plain text is passed through untouched', async () => {
  const { text, info } = await extractText(Buffer.from('# T\n\nHello.\n'), 'notes.md');
  assert.equal(info.kind, 'text');
  assert.match(text, /Hello\./);
});

test('unsupported file types are rejected with a readable message', async () => {
  await assert.rejects(() => extractText(Buffer.from('x'), 'budget.xlsx'), /Unsupported file type/);
});
