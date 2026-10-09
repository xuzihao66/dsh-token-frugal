// v2: the saving-mode state, the workspace memory document, and recall.
// These are the properties that keep the new features from costing more tokens
// than they save, or from recording something the user did not say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODE_IDS, STATE_FILE, STATE_VERSION, effectivePolicy, modeAvailable, readState,
  resolveModes, sanitizeModePatch, stateDirectory, writeState,
} from '../lib/modes.js';
import {
  appendBlock, extractPoints, parseMemo, sessionHeading, stamp, summaryBlock, userBlock,
} from '../lib/memo.js';
import { rank, renderRecall, selectExcerpts, terms } from '../lib/recall.js';
import { DEFAULT_CONFIG } from '../lib/defaults.js';

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

test('modes start from the v1 keys, so an existing profile is unchanged', () => {
  const modes = resolveModes({
    ...DEFAULT_CONFIG,
    transforms: { ...DEFAULT_CONFIG.transforms, json: false },
    recovery: 'none',
    hiddenTools: ['workflow'],
  });
  assert.equal(modes.json, false, 'a disabled transform stays disabled');
  assert.equal(modes.terminal, true);
  assert.equal(modes.elide, false, 'recovery none means elide off');
  assert.equal(modes.catalogue, true, 'a non-empty hiddenTools means catalogue on');
  assert.equal(modes.memo, true);
  assert.equal(modes.recall, true);
});

test('an explicit modes block overrides what the v1 keys imply', () => {
  const modes = resolveModes({ ...DEFAULT_CONFIG, recovery: 'none', modes: { elide: true, memo: false } });
  assert.equal(modes.elide, true);
  assert.equal(modes.memo, false);
});

test('the effective policy maps modes onto the compressor options', () => {
  const all = effectivePolicy(Object.fromEntries(MODE_IDS.map((id) => [id, true])));
  assert.deepEqual(all.transforms.json, true);
  assert.equal(all.recovery, 'spill');
  assert.equal(all.memo, true);
  assert.equal(all.recall, true);
  const none = effectivePolicy(Object.fromEntries(MODE_IDS.map((id) => [id, false])));
  assert.equal(none.recovery, 'none', 'elide off must mean lossless-only');
  assert.equal(none.transforms.columns, false);
  assert.equal(none.memo, false);
});

test('catalogue is only offered when hiddenTools names something', () => {
  assert.equal(modeAvailable('catalogue', { hiddenTools: [] }), false);
  assert.equal(modeAvailable('catalogue', { hiddenTools: ['workflow'] }), true);
  assert.equal(modeAvailable('json', { hiddenTools: [] }), true);
});

test('an untrusted mode patch is filtered, never trusted', () => {
  assert.deepEqual(sanitizeModePatch({ json: false, nope: true, memo: 'yes' }), { json: false });
  assert.deepEqual(sanitizeModePatch(null), {});
  assert.deepEqual(sanitizeModePatch(['json']), {});
});

test('mode state round-trips through the profile directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-modes-'));
  try {
    assert.equal(readState(dir), undefined, 'nothing persisted yet');
    const written = writeState(dir, { json: false, recall: false });
    assert.equal(written, join(dir, STATE_FILE));
    assert.deepEqual(readState(dir), { json: false, recall: false });
    // The write is atomic, so no temporary file is left behind.
    assert.equal(readState(dir).nope, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or stale state file is ignored rather than half-applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-modes-'));
  try {
    writeFileSync(join(dir, STATE_FILE), '{ not json');
    assert.equal(readState(dir), undefined);
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: STATE_VERSION + 1, modes: { json: false } }));
    assert.equal(readState(dir), undefined, 'a schema bump must not be read as the new shape');
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: STATE_VERSION, modes: {} }));
    assert.equal(readState(dir), undefined, 'an empty patch is not state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the state directory prefers the profile, then the harness home', () => {
  assert.equal(stateDirectory({ DSH_PROFILE_DIR: 'C:/p', DSH_HOME: 'C:/h' }), 'C:/p');
  assert.match(stateDirectory({ DSH_HOME: 'C:/h', DSH_PROFILE: 'desktop' }), /desktop$/);
  assert.equal(stateDirectory({}), undefined, 'no directory means no persistence, not a crash');
});

// ---------------------------------------------------------------------------
// memo
// ---------------------------------------------------------------------------

test('a digest picks conclusions, not the whole reply', () => {
  const reply = [
    'I looked at the repository and then at the build.',
    '',
    '```js',
    'const secret = "this line is code and must not be quoted";',
    '```',
    '',
    '- Added the retry policy to the dispatcher.',
    '- Fixed the timeout that dropped the last chunk.',
    '- Verified with 29 tests.',
    '',
    'Anything else is prose that does not need recording.',
  ].join('\n');
  const points = extractPoints(reply, { maxPoints: 4, maxChars: 300 });
  assert.equal(points.length, 3, `expected the three bullets, got ${JSON.stringify(points)}`);
  assert.match(points[0], /retry policy/);
  assert.ok(!points.some((point) => point.includes('secret')), 'fenced code must never be quoted');
  assert.ok(points.every((point) => point.length <= 220));
});

test('a digest of prose falls back to its opening sentence', () => {
  const points = extractPoints('The migration is complete and the old path is gone. Nothing else changed.');
  assert.equal(points.length, 1);
  assert.match(points[0], /migration is complete/);
});

test('a digest is empty for empty input, and bounded by maxChars', () => {
  assert.deepEqual(extractPoints(''), []);
  assert.deepEqual(extractPoints(undefined), []);
  const many = Array.from({ length: 40 }, (_, i) => `- completed item number ${i} with a reasonably long tail`).join('\n');
  const points = extractPoints(many, { maxChars: 200, maxPoints: 20 });
  assert.ok(points.join('\n').length <= 200);
});

test('the document is created with a title and grows by whole blocks', () => {
  const first = appendBlock('', sessionHeading('session-1', 'C:/work', Date.UTC(2026, 9, 8, 6, 11)));
  assert.match(first, /^# dsh-token-frugal session memory/);
  assert.match(first, /## session-1 — 2026-10-08 06:11 UTC · C:\/work/);
  const next = appendBlock(first, userBlock('hello there', { time: Date.UTC(2026, 9, 8, 6, 12) }));
  assert.match(next, /### user · 2026-10-08 06:12 UTC\n\nhello there/);
  assert.match(next, /^# dsh-token-frugal session memory/, 'the title is written once');
  assert.equal(appendBlock(next, ''), next, 'an empty block changes nothing');
  assert.equal(appendBlock(next, '   '), next);
});

test('a long user message is clipped in memory, and says so', () => {
  const block = userBlock('x'.repeat(5000), { maxChars: 100 });
  assert.ok(block.includes('truncated in memory'));
  assert.ok(block.length < 300);
});

test('parsing recovers blocks, their session, and their kind', () => {
  let doc = appendBlock('', sessionHeading('session-a', 'C:/w', 0));
  doc = appendBlock(doc, userBlock('first question about the parser', { time: 0 }));
  doc = appendBlock(doc, summaryBlock(['Added the parser.', 'Verified it.'], { turn: 1, time: 0 }));
  doc = appendBlock(doc, sessionHeading('session-b', 'C:/w', 0));
  doc = appendBlock(doc, userBlock('second question about recall', { time: 0 }));

  const blocks = parseMemo(doc);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, 'user');
  assert.equal(blocks[0].session, 'session-a');
  assert.match(blocks[0].text, /first question/);
  assert.equal(blocks[1].kind, 'summary');
  assert.match(blocks[1].text, /Added the parser\. - Verified it\.|Added the parser\./);
  assert.equal(blocks[2].session, 'session-b', 'blocks are attributed to their session');
  assert.equal(parseMemo('').length, 0);
  assert.equal(parseMemo(undefined).length, 0);
});

test('a verbatim user block keeps its paragraph breaks', () => {
  let doc = appendBlock('', sessionHeading('s', 'C:/w', 0));
  doc = appendBlock(doc, userBlock('first paragraph\n\nsecond paragraph', { time: 0 }));
  const [block] = parseMemo(doc);
  assert.match(block.text, /first paragraph\n\nsecond paragraph/);
});

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

test('terms cover latin words and CJK bigrams, and drop stopwords', () => {
  const list = terms('Fix the RecallCache bug 修复记忆召回的问题');
  assert.ok(list.includes('recallcache'), 'latin words are lowercased and kept whole');
  assert.ok(list.includes('bug'));
  assert.ok(!list.includes('the'), 'stopwords carry no signal');
  assert.ok(list.includes('记忆'), 'CJK contributes adjacent bigrams');
  assert.ok(list.includes('召回'));
  // Overlapping bigrams are the price of not shipping a segmenter: a noise
  // bigram like 的问 does appear, and inverse document frequency is what keeps
  // it from deciding a match on its own.
  assert.ok(list.includes('的问'));
});

test('ranking prefers the block that actually matches, and exclusions hold', () => {
  let doc = appendBlock('', sessionHeading('s', 'C:/w', 0));
  doc = appendBlock(doc, userBlock('我们讨论了数据库迁移的方案与回滚步骤', { time: 0 }));
  doc = appendBlock(doc, summaryBlock(['Unrelated work on the tool catalogue visibility model.'], { turn: 1, time: 0 }));
  doc = appendBlock(doc, userBlock('The colour of the button should be brand primary.', { time: 0 }));
  const blocks = parseMemo(doc);

  const ranked = rank(blocks, '数据库迁移要怎么做？');
  assert.ok(ranked.length >= 1);
  assert.match(ranked[0].block.text, /数据库迁移/);

  const english = rank(blocks, 'How should the catalogue visibility work?');
  assert.ok(english.length >= 1);
  assert.match(english[0].block.text, /catalogue visibility/);
});

test('a single shared word is not enough to spend tokens on', () => {
  let doc = appendBlock('', sessionHeading('s', 'C:/w', 0));
  doc = appendBlock(doc, userBlock('Please update the button colour.', { time: 0 }));
  const blocks = parseMemo(doc);
  const selection = selectExcerpts(blocks, 'button', { minMatchedTerms: 2, maxChars: 400 });
  assert.equal(selection.excerpts.length, 0, 'one term is a coincidence');
  assert.equal(selection.skipped, 'too-few-terms');

  const two = selectExcerpts(blocks, 'update the button colour', { minMatchedTerms: 2, maxChars: 400 });
  assert.ok(two.excerpts.length >= 1, 'corroborated matches do inject');
});

test('excerpts respect the character budget and mark a trimmed one', () => {
  let doc = appendBlock('', sessionHeading('s', 'C:/w', 0));
  doc = appendBlock(doc, userBlock(`alpha bravo charlie ${'y'.repeat(4000)}`, { time: 0 }));
  const blocks = parseMemo(doc);
  const selection = selectExcerpts(blocks, 'alpha bravo charlie', { maxChars: 300, maxBlocks: 2 });
  assert.equal(selection.excerpts.length, 1);
  assert.ok(selection.chars <= 300, `budget respected, got ${selection.chars}`);
  assert.equal(selection.excerpts[0].trimmed, true);
  assert.match(selection.excerpts[0].text, /excerpt trimmed by dsh-token-frugal/);
});

test('the injected text names its source and tells the model what to do with it', () => {
  let doc = appendBlock('', sessionHeading('s', 'C:/w', 0));
  doc = appendBlock(doc, userBlock('the retry policy lives in the dispatcher', { time: 0 }));
  const selection = selectExcerpts(parseMemo(doc), 'where does the retry policy live', { maxChars: 500 });
  const rendered = renderRecall(selection, 'C:/w/.dsh-token-frugal/memory.md');
  assert.match(rendered, /<recalled-context source="C:\/w\/\.dsh-token-frugal\/memory\.md">/);
  assert.match(rendered, /Prefer these over re-reading the transcript/);
  assert.match(rendered, /retry policy lives in the dispatcher/);
  assert.equal(renderRecall({ excerpts: [] }, 'x'), '');
});

test('an empty document never injects anything', () => {
  const selection = selectExcerpts([], 'anything at all', {});
  assert.deepEqual(selection.excerpts, []);
  assert.equal(renderRecall(selection, 'path'), '');
});
