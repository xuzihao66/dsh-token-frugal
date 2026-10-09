// The bundle patch is the policy users edit, and the Cordis schema rejects an
// unknown key at activation — a typo there would break the whole profile. These
// tests pin the patch, the schema defaults, and the replay's decision logic to
// each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { DEFAULT_CONFIG } from '../lib/defaults.js';
import { readPatchConfig, resolvePolicy, applyPolicy, recoveryHint, decodeLogBuffer, parseArgs } from '../tools/measure-tokens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = join(ROOT, 'cordis.patch.yml');

/** Text no lossless transform can shrink: unique lines, no JSON, no padding. */
function incompressible(lines) {
  return Array.from({ length: lines }, (_, i) => `q${i}w${(i * 7919) % 104729}e${'k'.repeat(8 + (i % 5))}r${String.fromCharCode(97 + (i % 26))}${i * i}`).join('\n');
}

test('the bundle patch parses and only sets keys the Config schema declares', () => {
  const config = readPatchConfig(PATCH);
  assert.ok(config !== undefined, 'cordis.patch.yml must yield a config block');
  assert.equal(config.enabled, true);
  const unknown = Object.keys(config).filter((key) => !(key in DEFAULT_CONFIG));
  assert.deepEqual(unknown, [], `patch sets keys the schema would reject: ${unknown.join(', ')}`);
  for (const key of ['toolBudgets', 'transforms']) {
    const nested = Object.keys(config[key] ?? {});
    const allowed = Object.keys(DEFAULT_CONFIG[key]);
    const bad = nested.filter((name) => !allowed.includes(name));
    assert.deepEqual(bad, [], `${key} sets unknown entries: ${bad.join(', ')}`);
  }
});

test('the patch and lib/defaults.js agree on the shipped policy', () => {
  const config = readPatchConfig(PATCH);
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      assert.deepEqual(config[key], { ...value }, `${key} diverged from the defaults`);
      continue;
    }
    assert.deepEqual(config[key], value, `${key} diverged from the defaults`);
  }
});

test('a patch that names a key the schema would reject fails loudly', () => {
  const options = { patch: join(ROOT, 'test', 'fixtures', 'bad.patch.yml'), files: [], elide: true };
  assert.throws(() => resolvePolicy(options), /unknown key "notARealSetting"/);
});

test('every field index.js validates is present in DEFAULT_CONFIG, and vice versa', () => {
  const source = readFileSync(join(ROOT, 'index.js'), 'utf8');
  const block = /export const FIELD_KINDS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(source);
  assert.ok(block !== null, 'FIELD_KINDS must stay a literal object so it can be read here');
  const declared = [...block[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*'/gm)].map((match) => match[1]);
  assert.ok(declared.length > 10, `expected to find the config fields, saw ${declared.length}`);
  const missing = declared.filter((key) => !(key in DEFAULT_CONFIG));
  assert.deepEqual(missing, [], `FIELD_KINDS declares fields with no default: ${missing.join(', ')}`);
  const extra = Object.keys(DEFAULT_CONFIG).filter((key) => !declared.includes(key));
  assert.deepEqual(extra, [], `DEFAULT_CONFIG has fields no validator covers: ${extra.join(', ')}`);
  // The plugin must not import a Harness package: a profile-installed bundle
  // resolves from the profile, where those do not exist. Node builtins are
  // fine — a bundle inside the profile still runs on Node.
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]);
  const foreign = imports.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));
  assert.deepEqual(foreign, [], 'index.js may import only its own files and node: builtins');
});

test('skipTools bypasses a result entirely', () => {
  const policy = { ...DEFAULT_CONFIG, skipTools: ['read'] };
  const content = [{ type: 'text', text: 'x'.repeat(50_000) }];
  const applied = applyPolicy(policy, 'read', content, false);
  assert.equal(applied.skipped, true);
  assert.equal(applied.content, content);
});

test('the error budget factor widens the budget for failed calls', () => {
  const policy = { ...DEFAULT_CONFIG, defaultMaxChars: 500, toolBudgets: {}, errorBudgetFactor: 3 };
  const text = incompressible(400);
  assert.ok(text.length > 1500, `fixture must exceed the 3x budget, got ${text.length}`);
  const ok = applyPolicy(policy, 'pwsh', [{ type: 'text', text }], false);
  const failed = applyPolicy(policy, 'pwsh', [{ type: 'text', text }], true);
  assert.ok(ok.elided && failed.elided, 'both exceed their budget and elide');
  assert.ok(
    failed.content[0].text.length > ok.content[0].text.length,
    'the failed call must retain more text than the successful one',
  );
  assert.ok(ok.content[0].text.length <= 500);
  assert.ok(failed.content[0].text.length <= 1500);
});

test('recovery none forbids elision, so nothing is ever dropped', () => {
  const policy = { ...DEFAULT_CONFIG, defaultMaxChars: 500, toolBudgets: {}, recovery: 'none' };
  const text = incompressible(400);
  const applied = applyPolicy(policy, 'pwsh', [{ type: 'text', text }], false);
  assert.equal(applied.elided, false);
  assert.equal(applied.content[0].text, text);
});

test('a read result recovers by naming its own path, a spill result by its locator', () => {
  const policy = { ...DEFAULT_CONFIG, readSourceRecovery: true };
  const readText = '<path>C:\\a b\\file.ts</path>\n<content>\n1: x\n</content>';
  assert.match(recoveryHint(policy, 'read', readText), /Re-read C:\\a b\\file\.ts with offset\/limit/);
  assert.equal(recoveryHint(policy, 'read', 'no path tag here'), undefined);
  const spillText = 'preview ...\n(Omitted 10 bytes. Full formatted result stored at: /tmp/x.txt. Use read.)';
  assert.equal(recoveryHint(policy, 'web_fetch', spillText), '');
});

test('elision preserves the plugin-visible contract of the content array', () => {
  const policy = { ...DEFAULT_CONFIG, defaultMaxChars: 400, toolBudgets: {} };
  const image = { type: 'image', attachment: { attachmentId: 'a' } };
  const text = incompressible(300);
  const applied = applyPolicy(policy, 'web_fetch', [{ type: 'text', text: 'head' }, image, { type: 'text', text }], false);
  assert.equal(applied.content.length, 3, 'a rich block must not be dropped or merged away');
  assert.equal(applied.content[1], image, 'rich blocks keep their position and identity');
  assert.equal(applied.content[0].text, 'head', 'a block under its share is kept whole');
  assert.ok(applied.content[2].text.length < text.length, 'the oversized block is bounded');
});

test('decodeLogBuffer reads a log built from many concatenated zstd frames', () => {
  const frames = [];
  for (let i = 0; i < 5; i++) frames.push(zlib.zstdCompressSync(Buffer.from(`{"i":${i}}\n`)));
  const decoded = decodeLogBuffer(Buffer.concat(frames));
  assert.equal(decoded, Array.from({ length: 5 }, (_, i) => `{"i":${i}}\n`).join(''));
});

test('decodeLogBuffer survives a payload that contains the zstd magic bytes', () => {
  const payload = Buffer.from(`{"type":"tool/result","text":"${'\\u28b52ffd'.repeat(20)}"}\n`);
  const buffer = Buffer.concat([zlib.zstdCompressSync(payload), zlib.zstdCompressSync(payload)]);
  assert.equal(decodeLogBuffer(buffer), payload.toString('utf8') + payload.toString('utf8'));
});

test('parseArgs rejects an unknown flag instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  const options = parseArgs(['--target', '55', '--budgets', 'pwsh:1000', '/tmp/sessions']);
  assert.equal(options.target, 55);
  assert.equal(options.budgets, 'pwsh:1000');
  assert.deepEqual(options.files, ['/tmp/sessions']);
});

test('resolving an empty config reproduces lib/defaults.js exactly', async () => {
  // `resolveConfig` is what `apply` calls, so an installed row with no config
  // must produce the documented policy and not a second set of numbers.
  const { resolveConfig } = await import('../index.js');
  const resolved = resolveConfig({});
  assert.equal(resolved.defaultMaxChars, DEFAULT_CONFIG.defaultMaxChars);
  assert.equal(resolved.recovery, DEFAULT_CONFIG.recovery);
  assert.deepEqual([...resolved.budgets], Object.entries(DEFAULT_CONFIG.toolBudgets));
  assert.deepEqual(resolved.transforms, DEFAULT_CONFIG.transforms);
  assert.deepEqual([...resolved.skipTools], [...DEFAULT_CONFIG.skipTools]);
  assert.deepEqual(resolved.hiddenTools, [...DEFAULT_CONFIG.hiddenTools]);
  assert.equal(resolved.errorBudgetFactor, DEFAULT_CONFIG.errorBudgetFactor);
  assert.equal(resolved.headRatio, DEFAULT_CONFIG.headRatio);
  assert.equal(resolved.tailRatio, DEFAULT_CONFIG.tailRatio);
});

test('resolveConfig rejects unknown fields and bad values instead of guessing', async () => {
  const { resolveConfig } = await import('../index.js');
  assert.throws(() => resolveConfig({ nonsense: 1 }), /unknown config field "nonsense"/);
  assert.throws(() => resolveConfig({ defaultMaxChars: -1 }), /non-negative integer/);
  assert.throws(() => resolveConfig({ defaultMaxChars: 1.5 }), /non-negative integer/);
  assert.throws(() => resolveConfig({ headRatio: 1 }), /number in \[0, 1\)/);
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /must be true or false/);
  assert.throws(() => resolveConfig({ recovery: 'maybe' }), /must be "spill" or "none"/);
  assert.throws(() => resolveConfig({ toolBudgets: { read: 'lots' } }), /toolBudgets\.read/);
  assert.throws(() => resolveConfig({ transforms: { teleport: true } }), /is not a transform/);
  assert.throws(() => resolveConfig({ hiddenTools: 'workflow' }), /must be a list of strings/);
});

test('a partial config overrides only what it names', async () => {
  const { resolveConfig } = await import('../index.js');
  const resolved = resolveConfig({ toolBudgets: { read: 999 }, hiddenTools: ['workflow', 'workflow'] });
  assert.equal(resolved.budgets.get('read'), 999);
  assert.equal(resolved.budgets.get('pwsh'), DEFAULT_CONFIG.toolBudgets.pwsh, 'other budgets keep their defaults');
  assert.equal(resolved.defaultMaxChars, DEFAULT_CONFIG.defaultMaxChars);
  assert.deepEqual(resolved.hiddenTools, ['workflow'], 'duplicates collapse');
});
