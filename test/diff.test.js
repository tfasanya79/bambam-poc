import test from 'node:test';
import assert from 'node:assert/strict';

import { compare } from '../src/diff.js';

test('identical documents produce no changes', () => {
  const doc = '# A\n\nHello world.\n';
  assert.equal(compare(doc, doc).changes.length, 0);
});

test('inserting a paragraph at the top does not mark later blocks as changed', () => {
  const before = '# A\n\nOne.\n\nTwo.\n\nThree.\n';
  const after = '# A\n\nZero.\n\nOne.\n\nTwo.\n\nThree.\n';
  const { changes } = compare(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'added');
  assert.equal(changes[0].after, 'Zero.');
});

test('a changed number yields one modified region with one deletion and one insertion', () => {
  const { changes } = compare('# T\n\nRotate every 60 days.\n', '# T\n\nRotate every 90 days.\n');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'modified');
  assert.equal(changes[0].segments.filter((s) => s.op === 'del').length, 1);
  assert.equal(changes[0].segments.filter((s) => s.op === 'ins').length, 1);
});

test('capitalisation-only edits are not reported', () => {
  const { changes } = compare('# T\n\nThis policy applies.\n', '# T\n\nThis Policy applies.\n');
  assert.equal(changes.length, 0);
});

test('a new heading and paragraph is one added region with two block ids', () => {
  const { changes } = compare('# T\n\nOne.\n', '# T\n\nOne.\n\n## New\n\nBody text.\n');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'added');
  assert.equal(changes[0].afterIds.length, 2);
});

test('a removed clause is reported as removed, not as a modification', () => {
  const { changes } = compare('# T\n\nKeep.\n\nDrop this.\n', '# T\n\nKeep.\n');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'removed');
  assert.equal(changes[0].before, 'Drop this.');
});
