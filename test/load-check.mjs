#!/usr/bin/env node
/**
 * Load check: prove the plugin mounts the way the Harness mounts it.
 *
 * This is the strongest verification available without installing the bundle
 * into a live profile. It imports the real `index.js` with a real
 * `@deepseek-ai/schemastery` build, validates the shipped `cordis.patch.yml`
 * against the exported `Config`, and drives `apply()` through a fake Cordis
 * context so the two extension points behave as the Harness would drive them.
 *
 * Inside a profile, `@deepseek-ai/schemastery` resolves from the dsh
 * installation and no arguments are needed:
 *
 *   node test/load-check.mjs
 *
 * Outside one, point it at any directory that holds the vendored core
 * packages, and it builds a throwaway sandbox in the temp directory:
 *
 *   node test/load-check.mjs --core-dir <dir containing @deepseek-ai/schemastery>
 *
 * Exit status is 0 when every check passes.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
/** Core packages the plugin's `Config` needs at import time. */
const CORE_PACKAGES = ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit'];

function parseArgs(list) {
  const options = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '--core-dir') options.coreDir = list[++i];
    else if (list[i] === '--from-asar') options.fromAsar = list[++i];
    else if (list[i] === '--plugin') options.plugin = list[++i];
    else throw new Error(`unknown argument ${list[i]}`);
  }
  return options;
}

/** Locate the installed Harness bundle so the core packages can be read out of it. */
function findAppAsar() {
  if (process.env.DSH_APP_ASAR !== undefined) return process.env.DSH_APP_ASAR;
  const candidates = [
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    process.env.HOME === undefined ? undefined : join(process.env.HOME, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Extract the core packages this check needs out of an Electron `app.asar`.
 * The archive is an 8-byte pickle header followed by a JSON directory; file
 * bodies follow, aligned to the header. Only the two packages above are read.
 * @param asarPath - the bundle to read.
 * @param destination - directory that will hold `<@scope>/<name>` subdirectories.
 */
function extractCoreFromAsar(asarPath, destination) {
  const buffer = readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(4);
  const jsonSize = buffer.readUInt32LE(8);
  const raw = buffer.toString('utf8', 16, 16 + jsonSize);
  // The header string is padded to a 4-byte boundary.
  const header = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
  const baseOffset = 8 + headerSize;
  const wanted = new Set(CORE_PACKAGES.map((name) => `dsh/node_modules/${name}`));
  let extracted = 0;
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      // Descend through any ancestor of a wanted package, and take its members.
      const relevant = [...wanted].some((root) => root === path || root.startsWith(`${path}/`) || path.startsWith(`${root}/`));
      if (!relevant) continue;
      if (child.files !== undefined) { walk(child, path); continue; }
      const start = baseOffset + Number(child.offset);
      const out = join(destination, path.slice('dsh/node_modules/'.length));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, buffer.subarray(start, start + (child.size ?? 0)));
      extracted += 1;
    }
  };
  walk(header, '');
  assert.ok(extracted > 0, `no core packages found inside ${asarPath}`);
  return extracted;
}

/**
 * Prepare a sandbox holding the plugin plus a resolvable copy of the core
 * packages, then import the plugin from there.
 * @returns the plugin module namespace and the sandbox root.
 */
async function loadPlugin(pluginRoot, options) {
  if (options.coreDir === undefined && options.fromAsar === undefined) {
    // Inside a Harness process the bare specifier resolves; plain node cannot
    // see into app.asar, so fall back to reading the bundle directly.
    try {
      return { module: await import(pathToFileURL(join(pluginRoot, 'index.js')).href), root: pluginRoot, sandbox: undefined };
    } catch (error) {
      if (!/Cannot find package|Cannot find module/.test(String(error.message))) throw error;
    }
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'token-frugal-loadcheck-'));
  const target = join(sandbox, 'plugin');
  mkdirSync(join(sandbox, 'node_modules', '@deepseek-ai'), { recursive: true });
  if (options.coreDir !== undefined) {
    for (const name of CORE_PACKAGES) {
      const source = join(resolve(options.coreDir), name.split('/')[1]);
      assert.ok(existsSync(source), `--core-dir must contain ${name} (looked in ${source})`);
      cpSync(source, join(sandbox, 'node_modules', name), { recursive: true });
    }
  } else {
    const asarPath = options.fromAsar ?? findAppAsar();
    assert.ok(
      asarPath !== undefined,
      'could not find app.asar; pass --from-asar <path>, --core-dir <dir>, or set DSH_APP_ASAR',
    );
    const count = extractCoreFromAsar(asarPath, join(sandbox, 'node_modules'));
    console.log(`extracted ${count} core file(s) from ${asarPath}`);
  }
  cpSync(pluginRoot, target, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes('node_modules'),
  });
  return { module: await import(pathToFileURL(join(target, 'index.js')).href), root: target, sandbox };
}

const options = parseArgs(process.argv.slice(2));
const pluginRoot = options.plugin === undefined ? PLUGIN_ROOT : resolve(options.plugin);
let sandbox;
let sandboxNeedsCleanup = false;

try {
  const loaded = await loadPlugin(pluginRoot, options);
  const plugin = loaded.module;
  sandbox = loaded.sandbox;
  sandboxNeedsCleanup = sandbox !== undefined;
  const root = loaded.root;

  assert.equal(plugin.name, 'token-frugal');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.resolveConfig, 'function');
  console.log(`exports ok: name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`);

  // --- the shipped patch must satisfy the plugin's own config validation ---
  const { readPatchConfig, resolvePolicy } = await import(pathToFileURL(join(pluginRoot, 'tools', 'measure-tokens.mjs')).href);
  const patchPath = join(root, 'cordis.patch.yml');
  const rowConfig = readPatchConfig(patchPath);
  assert.ok(rowConfig !== undefined, 'cordis.patch.yml must yield a config block');

  const validated = plugin.resolveConfig(rowConfig);
  assert.equal(validated.enabled, true);
  assert.equal(validated.transforms.json, true);
  console.log(`config validated from the patch: defaultMaxChars=${validated.defaultMaxChars} read=${validated.budgets.get('read')}`);

  const bare = plugin.resolveConfig({});
  assert.equal(bare.recovery, 'spill');
  assert.equal(bare.budgets.get('read'), 3000);
  assert.equal(bare.defaultMaxChars, 1500);
  console.log(`defaults resolve for an empty config; ${Object.keys(plugin.FIELD_KINDS).length} fields are validated`);

  // A typo in the patch must fail activation with a clear message, which is
  // what a schemastery `Config` would have done before it was removed to keep
  // this plugin importable from a profile.
  let rejected;
  try { plugin.resolveConfig({ ...rowConfig, notARealSetting: 1 }); } catch (error) { rejected = error.message; }
  assert.match(String(rejected), /unknown config field "notARealSetting"/);
  console.log('an undeclared config field is refused:', String(rejected).slice(0, 60));

  // The offline policy loader must agree with the plugin about the fields.
  let loaderRejected = false;
  const badPatch = join(sandbox ?? tmpdir(), 'bad.patch.yml');
  writeFileSync(badPatch, '- insert:\n    - id: token-frugal\n      name: dsh-token-frugal\n      config:\n        notARealSetting: 1\n');
  try { resolvePolicy({ patch: badPatch, files: [], elide: true }); } catch { loaderRejected = true; }
  assert.equal(loaderRejected, true, 'the policy loader must refuse a key the plugin does not declare');
  console.log('the policy loader refuses the same field');

  // --- drive apply() through a fake Cordis context -------------------------
  const listeners = new Map();
  const warned = [];
  const infos = [];
  const fakeCtx = {
    on(event, handler) { listeners.set(event, handler); },
    effect() { return () => {}; },
    get() { return undefined; },
    logger: { warn: (line) => warned.push(line), info: (line) => infos.push(line), debug: () => {} },
    tools: { schemas: () => [] },
  };
  plugin.apply(fakeCtx, rowConfig);
  assert.ok(listeners.has('tools/post-execute'), 'the post-execute listener must be registered');
  assert.ok(infos.some((line) => line.includes('token-frugal: ready')), 'the startup line is missing');
  assert.ok(!listeners.has('agent/created'), 'no agent/created listener is needed while hiddenTools is empty');
  console.log('apply() registered tools/post-execute');

  const next = async () => ({ kind: 'accept' });
  /** The content the loop would log: the decision's replacement, or the original. */
  const contentOf = (decision, original) => (decision.content ?? original.content)[0].text;

  // Losslessly compressible (padding and repeated lines) but with unique
  // payload lines, so the result stays well over any budget.
  const oversized = Array.from({ length: 400 }, (_, i) => `row ${i} ${String(i * 7919).padStart(7)}    ${'q'.repeat(18)}      x${(i * i) % 977}   `).join('\n');
  const exec = { name: 'pwsh', callId: 'call_1', arguments: {}, signal: undefined, agent: undefined };
  const result = { isError: false, value: null, content: [{ type: 'text', text: oversized }] };

  const lossless = await listeners.get('tools/post-execute')(exec, result, next);
  const losslessText = contentOf(lossless, result);
  assert.ok(losslessText.length < oversized.length, 'lossless compression must shrink the result');
  assert.ok(losslessText.length > 1500, `the fixture must stay over budget, got ${losslessText.length}`);
  assert.ok(
    !losslessText.includes('elided by dsh-token-frugal'),
    'without a recovery path the plugin must not drop unrecoverable text',
  );
  console.log(`lossless only, no recovery path: ${oversized.length} -> ${losslessText.length} chars, nothing dropped`);

  // A `read` result is recoverable from its own path, so elision is allowed.
  const readText = `<path>C:\\x\\big.ts</path>\n<type>file</type>\n<content>\n${Array.from({ length: 400 }, (_, i) => `${i + 1}: const v${i} = g(${i * 31}); // ${'n'.repeat(24)}`).join('\n')}\n</content>`;
  const readDecision = await listeners.get('tools/post-execute')(
    { ...exec, name: 'read' },
    { isError: false, value: null, content: [{ type: 'text', text: readText }] },
    next,
  );
  const readAfter = contentOf(readDecision, { content: [{ type: 'text', text: readText }] });
  assert.ok(readAfter.length < readText.length, 'an oversized read must shrink');
  assert.ok(readAfter.includes('elided by dsh-token-frugal'), 'read elision needs no spill backend');
  assert.ok(readAfter.includes('C:\\x\\big.ts') && readAfter.includes('offset/limit'), 'the marker must name the file and the recovery move');
  console.log(`read elided: ${readText.length} -> ${readAfter.length} chars`);
  console.log(`marker: ${readAfter.split('\n').find((line) => line.includes('elided by'))}`);

  // Decisions the plugin does not own must pass through untouched.
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] };
  assert.equal(await listeners.get('tools/post-execute')(exec, result, async () => blocked), blocked);
  const replaced = await listeners.get('tools/post-execute')(exec, result, async () => ({ kind: 'accept', value: { ok: true } }));
  assert.equal(replaced.value.ok, true);
  console.log('block and value-replacement decisions pass through');

  // A compression fault must never turn a successful call into an error.
  const hostile = { isError: false, value: null, content: [{ type: 'text', get text() { throw new Error('boom'); } }] };
  const survived = await listeners.get('tools/post-execute')(exec, hostile, next);
  assert.equal(survived.kind, 'accept');
  assert.ok(warned.some((line) => line.includes('compression skipped')), 'the fault must be logged');
  console.log('a compression fault degrades to the original decision');

  // hiddenTools must register the agent/created half and survive an agent
  // whose scoped context cannot accept a restriction.
  const hiddenCtx = {
    ...fakeCtx,
    on(event, handler) { listeners.set(`hidden:${event}`, handler); },
    tools: {
      schemas: () => [{ name: 'workflow' }, { name: 'subagent_fork' }],
      restrict: () => { throw new Error('scope rejected'); },
    },
  };
  plugin.apply(hiddenCtx, { ...rowConfig, hiddenTools: ['workflow', 'nope'] });
  assert.ok(listeners.has('hidden:agent/created'), 'hiddenTools must register agent/created');
  await listeners.get('hidden:agent/created')({ agent: { id: 'session-1', ctx: { tools: {}, effect: (fn) => { fn(); return () => {}; } } } });
  assert.ok(warned.some((line) => line.includes('nope')), 'an unknown hidden tool must be reported');
  assert.ok(warned.some((line) => line.includes('could not hide tools')), 'a refused restriction must not break agent creation');
  console.log('hiddenTools reports unknown names and survives a refused restriction');

  console.log('\nLOAD CHECK PASSED');
} finally {
  if (sandboxNeedsCleanup && sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true });
}
