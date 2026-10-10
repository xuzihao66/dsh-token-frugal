#!/usr/bin/env node
/**
 * Integration check: prove both halves mount the way the Harness mounts them.
 *
 * The Host half imports nothing outside its own files and Node builtins, so
 * this runs with no arguments, no extraction step, and no dependency on the
 * installed Harness:
 *
 *   node test/load-check.mjs
 *
 * It covers:
 *
 *   - the exported surface and the shipped patch against `resolveConfig`
 *   - `tools/post-execute`: lossless-only without a recovery path, `read`
 *     elision with its own path, pass-through of decisions the plugin does not
 *     own, and fault isolation
 *   - `agent/created` + `agent/inbox/claimed` + `session/event`: the memory
 *     document is created, filled with verbatim input and a turn digest, and
 *     matched on the next message, which injects through `agent.inject`
 *   - the mode route: GET reports the modes, POST changes and persists one
 *   - the Client half: its module id, its `slots` dependency, and the exact
 *     slot registration the page will consume
 *
 * Exit status is 0 when every check passes.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const load = (relative) => import(pathToFileURL(join(ROOT, relative)).href);

const plugin = await load('index.js');
const { readPatchConfig } = await load('tools/measure-tokens.mjs');
const { MODE_IDS } = await load('lib/modes.js');

// ---------------------------------------------------------------------------
// exports and config
// ---------------------------------------------------------------------------
assert.equal(plugin.name, 'token-frugal');
assert.deepEqual(plugin.inject, ['tools']);
assert.equal(typeof plugin.apply, 'function');
assert.equal(typeof plugin.resolveConfig, 'function');
console.log(`exports ok: name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`);

const workspace = mkdtempSync(join(tmpdir(), 'tf-load-'));
process.env.DSH_PROFILE_DIR = workspace;
const rowConfig = readPatchConfig(join(ROOT, 'cordis.patch.yml'));
assert.ok(rowConfig !== undefined, 'cordis.patch.yml must yield a config block');
const resolved = plugin.resolveConfig(rowConfig);
assert.equal(resolved.defaultMaxChars, 1500);
assert.equal(resolved.budgets.get('read'), 3000);
assert.equal(resolved.memo.path, '.dsh-token-frugal/memory.md');
assert.equal(resolved.recall.maxChars, 1200);
assert.equal(resolved.bridge.path, '/dsh-token-frugal/modes');
console.log(`config validated from the patch: ${Object.keys(plugin.FIELD_KINDS).length} validated fields, memo=${resolved.memo.path}`);

for (const [label, config] of [
  ['unknown field', { notARealSetting: 1 }],
  ['unknown mode', { modes: { teleport: true } }],
  ['unknown memo key', { memo: { nope: 1 } }],
  ['unknown recall key', { recall: { nope: 1 } }],
  ['unknown bridge key', { bridge: { nope: 1 } }],
  ['wrong mode type', { modes: { json: 'yes' } }],
  ['wrong recall type', { recall: { maxChars: -5 } }],
]) {
  let message;
  try { plugin.resolveConfig({ ...rowConfig, ...config }); } catch (error) { message = error.message; }
  assert.ok(message !== undefined, `${label} must be refused`);
  assert.match(message, /token-frugal:/);
}
console.log('undeclared fields, modes, and wrong types are all refused');

// ---------------------------------------------------------------------------
// a fake Cordis context, agent, and HTTP exchange
// ---------------------------------------------------------------------------
const listeners = new Map();
const routes = new Map();
const injections = [];
const warnings = [];
const infos = [];
const injected = [];

const fire = (event, ...args) => {
  const handlers = listeners.get(event) ?? [];
  assert.ok(handlers.length > 0, `no listener registered for ${event}`);
  for (const handler of handlers) handler(...args);
};

const sessionId = 'session-load-1';
const agent = {
  id: sessionId,
  session: { header: { id: sessionId, cwd: workspace } },
  inject: (message) => { injected.push(message); },
  ctx: { tools: { restrict: () => () => {} }, effect: (fn) => { fn(); return () => {}; } },
};

const ctx = {
  on: (event, handler) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    return () => {};
  },
  effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
  // `inject` is how the plugin must acquire the web server: this row activates
  // as soon as `tools` is ready, which can precede the server's listen. A
  // one-shot `ctx.get('webServer')` lost the route in that ordering, which the
  // live check caught as a 404.
  inject: (deps, callback) => {
    injections.push([...deps]);
    if (deps.includes('webServer')) {
      callback({
        webServer: {
          register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); },
        },
      });
    }
    return () => {};
  },
  get: () => undefined,
  logger: {
    warn: (line) => warnings.push(line),
    info: (line) => infos.push(line),
    debug: () => {},
  },
  tools: { schemas: () => [], restrict: () => () => {} },
};

plugin.apply(ctx, rowConfig);
assert.ok(infos.some((line) => line.includes('token-frugal: ready')), 'the startup line is missing');
assert.ok(listeners.has('tools/post-execute'));
assert.ok(listeners.has('agent/created'));
assert.ok(listeners.has('agent/inbox/claimed'));
assert.ok(listeners.has('session/event'));
assert.ok(
  injections.some((deps) => deps.includes('webServer')),
  'the web server must be acquired through ctx.inject, not a one-shot ctx.get',
);
console.log('apply() registered post-execute, agent/created, inbox/claimed, session/event, and the route');

// ---------------------------------------------------------------------------
// tools/post-execute
// ---------------------------------------------------------------------------
const next = async () => ({ kind: 'accept' });
const contentOf = (decision, original) => (decision.content ?? original.content)[0].text;
const exec = { name: 'pwsh', callId: 'call_1', arguments: {}, signal: undefined, agent: undefined };

const oversized = Array.from({ length: 400 }, (_, i) => `row ${i} ${String(i * 7919).padStart(7)}    ${'q'.repeat(18)}      x${(i * i) % 977}   `).join('\n');
const result = { isError: false, value: null, content: [{ type: 'text', text: oversized }] };
const lossless = await listeners.get('tools/post-execute')[0](exec, result, next);
const losslessText = contentOf(lossless, result);
assert.ok(losslessText.length < oversized.length, 'lossless compression must shrink the result');
assert.ok(losslessText.length > 1500, `the fixture must stay over budget, got ${losslessText.length}`);
assert.ok(!losslessText.includes('elided by dsh-token-frugal'), 'no recovery path means no elision');
console.log(`lossless only, no recovery path: ${oversized.length} -> ${losslessText.length} chars, nothing dropped`);

const readText = `<path>C:\\x\\big.ts</path>\n<type>file</type>\n<content>\n${Array.from({ length: 400 }, (_, i) => `${i + 1}: const v${i} = g(${i * 31}); // ${'n'.repeat(24)}`).join('\n')}\n</content>`;
const readDecision = await listeners.get('tools/post-execute')[0](
  { ...exec, name: 'read' },
  { isError: false, value: null, content: [{ type: 'text', text: readText }] },
  next,
);
const readAfter = contentOf(readDecision, { content: [{ type: 'text', text: readText }] });
assert.ok(readAfter.includes('elided by dsh-token-frugal') && readAfter.includes('offset/limit'));
console.log(`read elided to ${readAfter.length} chars with a re-read hint`);

const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] };
assert.equal(await listeners.get('tools/post-execute')[0](exec, result, async () => blocked), blocked);
assert.equal((await listeners.get('tools/post-execute')[0](exec, result, async () => ({ kind: 'accept', value: { ok: true } }))).value.ok, true);
const hostile = { isError: false, value: null, content: [{ type: 'text', get text() { throw new Error('boom'); } }] };
assert.equal((await listeners.get('tools/post-execute')[0](exec, hostile, next)).kind, 'accept');
assert.ok(warnings.some((line) => line.includes('compression skipped')));
console.log('block and value decisions pass through; a fault degrades to the original decision');

// ---------------------------------------------------------------------------
// the memory document and recall
// ---------------------------------------------------------------------------
const memoPath = join(workspace, resolved.memo.path);
fire('agent/created', { agent });
assert.ok(existsSync(memoPath), `the memory document must exist at ${memoPath}`);
const created = readFileSync(memoPath, 'utf8');
assert.match(created, /# dsh-token-frugal session memory/);
assert.match(created, new RegExp(`## ${sessionId} `));
console.log(`memory document created: ${memoPath}`);

const userLine = '请记住：重试策略实现在 dispatcher 里，超时参数在 timeoutPolicy。';
fire('agent/inbox/claimed', { agent, message: { content: [{ type: 'text', text: userLine }] }, turn: 1 });
assert.ok(readFileSync(memoPath, 'utf8').includes(userLine), 'the user text is recorded verbatim');
assert.equal(injected.length, 0, 'nothing to recall yet');
console.log('user input recorded verbatim; no recall on an empty document');

fire('session/event', { id: sessionId, header: { cwd: workspace } }, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '- 已完成重试策略迁移\n- 已用 29 个测试验证' }] } },
});
fire('session/event', { id: sessionId, header: { cwd: workspace } }, { type: 'turn/end', data: { turn: 1 } });
const withDigest = readFileSync(memoPath, 'utf8');
assert.ok(withDigest.includes('### summary turn 1'), 'the turn digest block is recorded');
assert.ok(withDigest.includes('已完成重试策略迁移'), 'the digest quotes the reply, not the prompt');
console.log('turn digest recorded from the assistant reply');

fire('agent/inbox/claimed', {
  agent,
  message: { content: [{ type: 'text', text: '重试策略在哪个文件里实现？超时参数怎么配？' }] },
  turn: 2,
});
assert.equal(injected.length, 1, `expected exactly one recall injection, got ${injected.length}`);
assert.equal(injected[0].role, 'user');
assert.equal(typeof injected[0].id, 'string');
const recalled = injected[0].content[0].text;
assert.match(recalled, /<recalled-context source=/);
assert.match(recalled, /Prefer these over re-reading the transcript/);
assert.match(recalled, /重试策略/);
console.log(`recall injected ${recalled.length} chars for a matching follow-up`);

fire('agent/inbox/claimed', {
  agent,
  message: { content: [{ type: 'text', text: '重试策略在哪个文件里实现？超时参数怎么配？' }] },
  turn: 3,
});
assert.equal(injected.length, 1, 'the same extracts are never injected twice in a row');
console.log('a repeated match is suppressed rather than re-injected');

// ---------------------------------------------------------------------------
// the mode route
// ---------------------------------------------------------------------------
const route = routes.get(resolved.bridge.path);
assert.ok(route !== undefined, 'the mode route must be registered');
assert.equal(route.kind, 'exact');

const exchange = () => {
  const state = { status: 0, headers: null, body: '' };
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers; },
    end(payload) { state.body = payload ?? ''; },
    get json() { return JSON.parse(state.body); },
  };
};

const getResponse = exchange();
await route.handler({ method: 'GET' }, getResponse);
assert.equal(getResponse.state.status, 200);
assert.equal(getResponse.state.headers['cache-control'], 'no-store');
assert.equal(getResponse.json.modes.length, MODE_IDS.length);
assert.ok(getResponse.json.modes.every((mode) => typeof mode.on === 'boolean' && typeof mode.available === 'boolean'));
assert.equal(getResponse.json.version, 2);
console.log(`GET ${resolved.bridge.path} -> ${MODE_IDS.length} modes`);

const postResponse = exchange();
await route.handler({
  method: 'POST',
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ modes: { json: false, terminal: false } })); },
}, postResponse);
assert.equal(postResponse.state.status, 200);
assert.deepEqual(postResponse.json.changed, { json: false, terminal: false });
const statePath = join(workspace, 'dsh-token-frugal.state.json');
assert.ok(existsSync(statePath), `the choice must be persisted at ${statePath}`);
assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).modes.json, false);
assert.ok(infos.some((line) => line.includes('modes changed via panel')));

const afterToggle = exchange();
await route.handler({ method: 'GET' }, afterToggle);
assert.equal(afterToggle.json.modes.find((mode) => mode.id === 'json').on, false);
console.log('POST toggled two modes, persisted them, and GET reports them off');

const badResponse = exchange();
await route.handler({
  method: 'POST',
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ modes: { teleport: true } })); },
}, badResponse);
assert.equal(badResponse.state.status, 400, 'an unknown mode must be a 400, not a silent no-op');

const methodResponse = exchange();
await route.handler({ method: 'DELETE' }, methodResponse);
assert.equal(methodResponse.state.status, 405);
console.log('an unknown mode is rejected, and an unsupported method gets 405');

// ---------------------------------------------------------------------------
// the Client half
// ---------------------------------------------------------------------------
const registrations = [];
let loadedModule = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loadedModule = spec; },
  },
};
try {
  await load('client.js');
} finally {
  delete globalThis.window;
}
assert.ok(loadedModule !== null, 'client.js must register a module with the page loader');
assert.equal(loadedModule.id, 'dsh-token-frugal', 'the module id must equal the package name');
assert.equal(typeof loadedModule.factory, 'function');

// React hooks are positional: seed one cell per hook the panel calls, in call
// order (its state, then the open/busy/error toggles), so it can really render.
const hookCells = [{ modes: getResponse.json.modes, profileDir: 'C:/profile' }, true, '', ''];
let hookCursor = 0;
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => { const cell = hookCursor++; if (hookCells[cell] === undefined) hookCells[cell] = typeof initial === 'function' ? initial() : initial; return [hookCells[cell], () => {}]; },
  useEffect: () => {},
  useCallback: (fn) => fn,
};
let requiredNames = [];
const clientPlugin = loadedModule.factory((name) => {
  requiredNames.push(name);
  assert.equal(name, 'react', 'the Client half may require React and nothing else');
  return fakeReact;
});
assert.ok(clientPlugin.inject.includes('slots'));
clientPlugin.apply({
  get: () => undefined,
  slots: {
    inject: (slot, register) => { assert.equal(slot, 'conversation.composer.dock'); register(); },
    register: (options, component) => { registrations.push({ options, component }); },
  },
});
assert.equal(registrations.length, 1);
assert.equal(registrations[0].options.name, 'conversation.composer.dock');
assert.equal(typeof registrations[0].options.id, 'string');
assert.equal(typeof registrations[0].options.order, 'number');
assert.equal(typeof registrations[0].component, 'function', 'the slot must receive a component');
assert.deepEqual(requiredNames, ['react']);

// The panel must actually build its element tree: a render fault is invisible to
// every check above, and a lossy re-encode of the client half shows up here.
hookCursor = 0;
const tree = registrations[0].component({});
const panelNodes = [];
const collectNodes = (node) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { node.forEach(collectNodes); return; }
  if (typeof node !== 'object') return;
  panelNodes.push(node);
  // This stub React does not expand function components, so call them: the tree
  // we inspect must be the one a browser would build.
  if (typeof node.type === 'function') { collectNodes(node.type(node.props)); return; }
  collectNodes(node.children);
};
collectNodes(tree);

const switches = panelNodes.filter((node) => node.props.role === 'switch');
assert.equal(switches.length, MODE_IDS.length, 'the expanded panel shows one switch per mode');
assert.equal(
  switches.filter((node) => node.props['aria-checked'] === 'true').length,
  getResponse.json.modes.filter((mode) => mode.on && mode.available !== false).length,
  'the switches must reflect the modes the route reported',
);

const grid = panelNodes.find((node) => node.props.style?.display === 'grid');
assert.ok(grid !== undefined, 'the modes must be laid out in a grid, not one long column');
assert.match(String(grid.props.style.gridTemplateColumns), /minmax/, 'the grid must be multi-column');

const panelCopy = JSON.stringify(panelNodes.map((node) => node.children));
assert.ok(panelCopy.includes('已开'), 'the panel copy must be the pinned Chinese text');
assert.ok(panelCopy.includes('会话记忆'), 'every mode must carry its Chinese label');
assert.ok(!panelCopy.includes('\uFFFD'), 'the panel copy must not contain replacement characters');
assert.ok(!readFileSync(join(ROOT, 'client.js'), 'utf8').includes('\uFFFD'), 'client.js must stay valid UTF-8');
console.log(`client panel ok: ${switches.length} switches in a grid, Chinese copy intact`);
console.log(`client half ok: id=${loadedModule.id} slot=${registrations[0].options.name} entry=${registrations[0].options.id}`);

rmSync(workspace, { recursive: true, force: true });
console.log('\nLOAD CHECK PASSED');
