// Invariants the post-execute transform must hold. These are the properties
// that keep the compression from degrading a task rather than just its cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripTerminalNoise,
  normalizeBlankSpace,
  collapseColumnPadding,
  foldRepeatedLines,
  foldNumericRuns,
  compressJson,
  elideToBudget,
  compressText,
  compressContent,
} from '../lib/compress.js';

test('strips ANSI, keeps text, resolves carriage-return repaints', () => {
  assert.equal(stripTerminalNoise('\u001b[31mred\u001b[0m plain'), 'red plain');
  assert.equal(stripTerminalNoise('10%\r50%\r100% done'), '100% done');
  assert.equal(stripTerminalNoise('a\r\nb'), 'a\nb');
  assert.equal(stripTerminalNoise('keep\ttab\nand newline'), 'keep\ttab\nand newline');
});

test('blank-run collapsing preserves content lines', () => {
  assert.equal(normalizeBlankSpace('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(normalizeBlankSpace('a  \nb\t\n'), 'a\nb');
});

test('column collapsing preserves leading indentation', () => {
  const input = '    name        value\n    a           1';
  const out = collapseColumnPadding(input, { minSpaces: 3 });
  assert.equal(out, '    name value\n    a 1');
});

test('repeated lines fold into a counted marker', () => {
  const input = ['start', ...Array.from({ length: 40 }, () => 'noise line'), 'end'].join('\n');
  const out = foldRepeatedLines(input, { minRun: 3 });
  assert.match(out, /\.\.\. \(x40 identical\)/);
  assert.ok(out.includes('noise line'));
  assert.ok(out.includes('start') && out.includes('end'));
  assert.ok(out.length < input.length);
});

test('arithmetic progressions fold to endpoints plus an explicit range', () => {
  const input = Array.from({ length: 20 }, (_, i) => `Downloading chunk ${i + 1} of 20`).join('\n');
  const out = foldNumericRuns(input, { minRun: 6 });
  assert.match(out, /1 -> 20 step 1; 18 line\(s\) folded/);
  assert.ok(out.startsWith('Downloading chunk 1 of 20'));
  assert.ok(out.endsWith('Downloading chunk 20 of 20'));
});

test('a non-arithmetic run is never folded', () => {
  const input = ['step 1', 'step 5', 'step 6', 'step 100', 'step 2', 'step 9', 'step 3'].join('\n');
  assert.equal(foldNumericRuns(input, { minRun: 3 }), input);
});

test('JSON minifies and homogeneous scalar arrays become a labelled table', () => {
  const object = JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2);
  assert.equal(compressJson(object), JSON.stringify({ a: 1, b: [1, 2, 3] }));

  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `row-${i}`, ok: true }));
  const table = compressJson(JSON.stringify(rows, null, 2));
  assert.match(table, /^\[30 rows, 3 columns: id, name, ok\]/);
  assert.match(table, /\nid\tname\tok\n/);
  assert.ok(table.length < JSON.stringify(rows).length);
});

test('a nested row disqualifies the table but still minifies', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, nested: { deep: i } }));
  const out = compressJson(JSON.stringify(rows, null, 2));
  assert.equal(out, JSON.stringify(rows));
});

test('truncated JSON is left alone rather than half-parsed', () => {
  const broken = `{"providers": [${'{"id":"x"},'.repeat(20)}`;
  assert.equal(compressJson(broken), undefined);
});

test('elision keeps both ends, states what it dropped, and retains error lines', () => {
  const lines = [
    'header line',
    ...Array.from({ length: 400 }, (_, i) => `body line ${i} ${'x'.repeat(40)}`),
    'ERROR: the thing failed at the end of the middle',
    ...Array.from({ length: 400 }, (_, i) => `tail body ${i} ${'y'.repeat(40)}`),
    'final line',
  ];
  const text = lines.join('\n');
  const out = elideToBudget(text, { maxChars: 2000, structureAware: true, recoveryHint: ' Recover with X.' });
  assert.ok(out.length <= 2000, `expected <= 2000 chars, got ${out.length}`);
  assert.ok(out.startsWith('header line'));
  assert.ok(out.endsWith('final line'));
  assert.match(out, /elided by dsh-token-frugal\. Recover with X\./);
  assert.match(out, /ERROR: the thing failed at the end of the middle/);
});

test('elision without a recovery hint is not reachable through compressText', () => {
  const text = 'x'.repeat(9000);
  // No maxChars means no budget, so only lossless transforms may run.
  assert.equal(compressText(text, {}), text);
});

test('compressText never grows content and is idempotent', () => {
  const samples = [
    Array.from({ length: 200 }, (_, i) => `\u001b[32m[ok]\u001b[0m    task ${i % 3}      done`).join('\n'),
    JSON.stringify({ deep: { nested: Array.from({ length: 50 }, (_, i) => ({ i, label: `l${i}` })) } }, null, 2),
    Array.from({ length: 40 }, () => 'same line').join('\n'),
  ];
  for (const sample of samples) {
    const once = compressText(sample, { maxChars: 1200, recoveryHint: ' hint' });
    assert.ok(once.length <= sample.length, 'must not grow');
    const twice = compressText(once, { maxChars: 1200, recoveryHint: ' hint' });
    assert.equal(twice, once, 'must be idempotent');
  }
});

test('compressContent leaves rich blocks untouched and in order', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a' } };
  const blocks = [
    { type: 'text', text: 'small' },
    image,
    { type: 'text', text: '\n'.repeat(400) + 'tail' },
  ];
  const { blocks: out, changed } = compressContent(blocks, { minBlockChars: 0 });
  assert.equal(out.length, 3);
  assert.equal(out[1], image);
  assert.equal(out[0], blocks[0], 'unchanged blocks keep identity');
  assert.equal(changed, true);
  assert.ok(out[2].text.length < blocks[2].text.length);
});

test('terminal-only noise still yields a strict reduction, not a copy', () => {
  const noisy = Array.from({ length: 60 }, (_, i) => `\u001b[90m${i}\u001b[0m    value      ${i}   `).join('\n');
  const out = compressText(noisy, { minBlockChars: 0 });
  assert.ok(out.length < noisy.length);
  assert.ok(!out.includes('\u001b'));
});
