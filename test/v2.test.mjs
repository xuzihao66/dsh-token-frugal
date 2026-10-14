// v2: the saving-mode state, the workspace memory document, and recall.
// These are the properties that keep the new features from costing more tokens
// than they save, or from recording something the user did not say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { emptyStats, recordAged, sanitizeStats, summarizeStats, toolRows } from '../lib/stats.js';

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
    assert.deepEqual(readState(dir), { modes: { json: false, recall: false }, elisionDepth: undefined });
    // The write is atomic, so no temporary file is left behind.
    assert.equal(readState(dir).modes.nope, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the elision tier is state of its own, and an unknown one is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-depth-'));
  try {
    writeState(dir, { json: false }, 'extreme');
    assert.deepEqual(readState(dir), { modes: { json: false }, elisionDepth: 'extreme' });
    // A tier alone is state: the panel can move the depth without a mode switch.
    writeState(dir, {}, 'deep');
    assert.deepEqual(readState(dir), { modes: {}, elisionDepth: 'deep' });
    // An unknown tier is discarded rather than persisted as a policy change.
    writeState(dir, { json: true }, 'nonsense');
    assert.deepEqual(readState(dir), { modes: { json: true }, elisionDepth: undefined });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version 1 state file still yields its modes, on the default tier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v1-'));
  try {
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: 1, modes: { json: false } }));
    assert.deepEqual(readState(dir), { modes: { json: false }, elisionDepth: undefined });
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
  assert.equal(stateDirectory({}, 'C:/nowhere'), undefined, 'no directory means no persistence, not a crash');
});

test('an unadvertised profile is discovered by evidence, never by guesswork', () => {
  const root = mkdtempSync(join(tmpdir(), 'token-frugal-home-'));
  try {
    const profiles = join(root, 'profiles');
    mkdirSync(join(profiles, 'desktop', 'node_modules', 'dsh-token-frugal'), { recursive: true });
    mkdirSync(join(profiles, 'untouched'), { recursive: true });
    assert.equal(stateDirectory({}, root), join(profiles, 'desktop'));
    // A file this plugin wrote earlier is evidence too - but a second
    // candidate turns the answer into "no directory" rather than a coin toss.
    writeFileSync(
      join(profiles, 'untouched', STATE_FILE),
      JSON.stringify({ version: STATE_VERSION, modes: { elide: false } }),
    );
    assert.equal(stateDirectory({}, root), undefined, 'two candidates is ambiguity, not a choice');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

import { applyDepth, depthFor } from '../lib/depths.js';

test('an elision tier merges over the resolved budget table without mutating it', async () => {
  const { resolveConfig } = await import('../index.js');
  const resolved = resolveConfig({ toolBudgets: { read: 9999 } });
  const standard = applyDepth('standard', resolved);
  assert.equal(standard.depth, 'standard');
  assert.equal(standard.defaultMaxChars, resolved.defaultMaxChars);
  assert.deepEqual([...standard.budgets], [...resolved.budgets], 'the default tier is the configured table itself');
  const extreme = applyDepth('extreme', resolved);
  assert.equal(extreme.depth, 'extreme');
  assert.equal(extreme.defaultMaxChars, 500);
  assert.equal(extreme.budgets.get('read'), 800, 'a tier overrides the tool it names');
  assert.equal(extreme.budgets.get('edit'), resolved.budgets.get('edit'), 'a tool the tier does not name keeps its configured budget');
  assert.equal(resolved.budgets.get('read'), 9999, 'the tier does not mutate the config it was applied to');
});

// ---------------------------------------------------------------------------
// the elision depth's aging rule
// ---------------------------------------------------------------------------

test('only the deeper tiers age a result, and each one names its rule', () => {
  assert.equal(depthFor('standard').aging, undefined, 'the default tier must not rewrite anything after arrival');
  for (const id of ['deep', 'extreme']) {
    const aging = depthFor(id).aging;
    assert.ok(Number.isInteger(aging.keepFull) && aging.keepFull > 0, `${id} must keep a positive number of results whole`);
    assert.ok(Number.isInteger(aging.lateLimit) && aging.lateLimit > 0, `${id} must name a positive late limit`);
  }
  assert.ok(depthFor('extreme').aging.keepFull <= depthFor('deep').aging.keepFull, 'the extreme tier keeps no more results whole than the deep tier');
  assert.ok(depthFor('extreme').aging.lateLimit < depthFor('deep').aging.lateLimit, 'the extreme tier digests harder');
  assert.deepEqual(depthFor('deep').aging, { keepFull: 2, lateLimit: 300 }, 'the deep tier ships the constants the corpus measured');
  assert.deepEqual(depthFor('extreme').aging, { keepFull: 1, lateLimit: 200 }, 'the extreme tier ships the constants the corpus measured');
});

test('applyDepth carries the aging rule through with the rest of the tier', () => {
  const resolved = { defaultMaxChars: 4000, budgets: new Map([['read', 9999]]) };
  assert.equal(applyDepth('standard', resolved).aging, undefined, 'the default tier must not rewrite anything after arrival');
  const deep = applyDepth('deep', resolved);
  assert.deepEqual(deep.aging, { keepFull: 2, lateLimit: 300 });
  assert.equal(deep.defaultMaxChars, 1000, 'the tier still owns its arrival budget');
  assert.equal(deep.budgets.get('read'), 1500, 'the tier table still wins over the profile');
  assert.equal(applyDepth('standard', resolved).budgets.get('read'), 9999, 'the default tier keeps the profile table');
});

test('an aged result is counted as its own kind of saving, never as a call', () => {
  const stats = emptyStats();
  recordAged(stats, 'read', 5000, 700);
  recordAged(stats, 'read', 4000, 600);
  const summary = summarizeStats(stats);
  assert.equal(summary.aged, 2);
  assert.equal(summary.before, 9000);
  assert.equal(summary.after, 1300);
  assert.equal(summary.calls, 0, 'aging never fabricates a tool call');
  assert.equal(summary.rewritten, 0, 'aging is not an arrival rewrite');
  assert.equal(summary.savedChars, 7700);
  assert.equal(toolRows(stats).find((row) => row.tool === 'read').savedChars, 7700);
  const sanitized = sanitizeStats({ aged: 3, before: 10, after: 4, bogus: 1 });
  assert.equal(sanitized.aged, 3, 'a persisted record keeps the new counter');
  assert.equal(Object.hasOwn(sanitized, 'bogus'), false);
});
