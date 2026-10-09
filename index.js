/**
 * `dsh-token-frugal` — cut the token cost of a long session without changing
 * what the model can accomplish.
 *
 * Three extension points, all inside the Harness event flow:
 *
 * 1. `tools/post-execute` — compress each accepted result's text before it is
 *    logged. The returned decision's `content` is what `dsh-agent-loop`
 *    appends as the `tool/result` event and what the model reads, so the
 *    model-visible and logged copies are the same bytes by construction.
 * 2. `agent/created` — hide configured tools from one agent through
 *    `ctx.tools.restrict()` on that agent's scoped context, and open this
 *    conversation's section in the workspace memory document.
 * 3. `agent/inbox/claimed` — match a new user message against that document and
 *    inject the best excerpts with `agent.inject()`. Injection is append-only
 *    and lands as an `agent/inbox/spliced` event, so recall never invalidates
 *    the request prefix the way rewriting history would.
 *
 * Plus one exact HTTP route, so the composer panel can read and change the
 * saving modes. The route is the bridge a profile-installed bundle can actually
 * use: `host.call` belongs to the sandboxed dynamic-package mechanism, and the
 * Client service catalog exposes no Host-facing call surface.
 *
 * Neither Harness capability is reimplemented: historical surface rewriting
 * stays with `dsh-compaction-tool-result-pruner`, and full-text retention stays
 * with `ctx.spillStore` — this plugin calls that service when its own elision
 * needs a recovery path, and degrades to lossless-only when it is absent.
 *
 * The module imports nothing but its own files and Node builtins. A
 * profile-installed bundle resolves from the profile's `node_modules`, where
 * the official `@deepseek-ai/*` packages do not exist, so the plugin validates
 * its own row config against `FIELD_KINDS` instead of exporting a schema.
 *
 * @module dsh-token-frugal
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { compressContent, compressContentToBudget } from './lib/compress.js';
import { contentChars } from './lib/estimate.js';
import { DEFAULT_BRIDGE, DEFAULT_CONFIG, DEFAULT_MEMO, DEFAULT_RECALL } from './lib/defaults.js';
import {
  MODE_IDS, effectivePolicy, modeAvailable, readState, resolveModes, sanitizeModePatch,
  stateDirectory, writeState,
} from './lib/modes.js';
import { appendBlock, extractPoints, parseMemo, summaryBlock, userBlock } from './lib/memo.js';
import { renderRecall, selectExcerpts } from './lib/recall.js';

/** Cordis plugin identity. */
export const name = 'token-frugal';
/** The tool registry for post-execute, and the optional route for the panel. */
export const inject = ['tools'];

/** The substring `dsh-spill-policy` always writes into its recovery notice. */
const SPILL_NOTICE = 'Full formatted result stored at:';
/** The path tag the `read` tool prefixes to a file's content. */
const READ_PATH = /^<path>([\s\S]*?)<\/path>/;
/** Largest memory document read back for matching, so a runaway file is bounded. */
const MEMO_READ_LIMIT = 512 * 1024;

/** Lossless transforms that may be toggled individually. */
const TRANSFORM_NAMES = Object.keys(DEFAULT_CONFIG.transforms);

/** Validators for the nested option objects. */
const MEMO_SPEC = Object.freeze({ enabled: 'boolean', path: 'string', maxEntryChars: 'integer' });
const RECALL_SPEC = Object.freeze({
  enabled: 'boolean', maxChars: 'integer', maxBlocks: 'integer', minScore: 'number', minMatchedTerms: 'integer',
});
const BRIDGE_SPEC = Object.freeze({ path: 'string' });

/**
 * How each configuration field is validated. This table is what a schemastery
 * `Config` would have expressed; it is written by hand because importing the
 * schema library would break the plugin's import from a profile.
 */
export const FIELD_KINDS = Object.freeze({
  enabled: 'boolean',
  defaultMaxChars: 'integer',
  toolBudgets: 'integerMap',
  errorBudgetFactor: 'numberAtLeastOne',
  skipTools: 'stringArray',
  minBlockChars: 'integer',
  minGainRatio: 'ratio',
  transforms: 'booleanMap',
  columnMinSpaces: 'integer',
  repeatedMinRun: 'integer',
  numericMinRun: 'integer',
  headRatio: 'ratio',
  tailRatio: 'ratio',
  structureAware: 'boolean',
  recovery: 'recoveryMode',
  readSourceRecovery: 'boolean',
  logStatsEvery: 'integer',
  hiddenTools: 'stringArray',
  modes: 'modeMap',
  memo: 'memoOptions',
  recall: 'recallOptions',
  bridge: 'bridgeOptions',
});

/** Reject a value that is not a non-negative safe integer. */
function checkCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`token-frugal: ${label} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Reject a value that is not a finite number in [0, 1). */
function checkRatio(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`token-frugal: ${label} must be a number in [0, 1) (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Reject a value that is not a non-negative finite number. */
function checkNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`token-frugal: ${label} must be a non-negative number (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Reject a value that is not a non-empty string. */
function checkString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`token-frugal: ${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Reject a value that is not a boolean. */
function checkBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`token-frugal: ${label} must be true or false (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Reject a value that is not a list of strings. */
function checkStrings(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`token-frugal: ${label} must be a list of strings (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Validate one nested option object against its spec. */
function checkOptions(value, label, spec) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`token-frugal: ${label} must be a mapping of setting names to values`);
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const kind = spec[key];
    if (kind === undefined) {
      throw new Error(`token-frugal: ${label}.${key} is not a setting (known: ${Object.keys(spec).join(', ')})`);
    }
    out[key] = kind === 'boolean' ? checkBoolean(entry, `${label}.${key}`)
      : kind === 'integer' ? checkCount(entry, `${label}.${key}`)
        : kind === 'number' ? checkNumber(entry, `${label}.${key}`)
          : checkString(entry, `${label}.${key}`);
  }
  return out;
}

/**
 * Validate one supplied field against its declared kind.
 * @param key - the field name.
 * @param value - the supplied value.
 * @returns the validated value.
 */
function checkField(key, value) {
  switch (FIELD_KINDS[key]) {
    case 'boolean':
      return checkBoolean(value, key);
    case 'integer':
      return checkCount(value, key);
    case 'ratio':
      return checkRatio(value, key);
    case 'numberAtLeastOne':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        throw new Error(`token-frugal: ${key} must be a number >= 1 (got ${JSON.stringify(value)})`);
      }
      return value;
    case 'stringArray':
      return [...new Set(checkStrings(value, key))];
    case 'recoveryMode':
      if (value !== 'spill' && value !== 'none') {
        throw new Error(`token-frugal: ${key} must be "spill" or "none" (got ${JSON.stringify(value)})`);
      }
      return value;
    case 'integerMap': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`token-frugal: ${key} must be a map of tool name to character budget`);
      }
      const result = {};
      for (const [tool, chars] of Object.entries(value)) result[tool] = checkCount(chars, `${key}.${tool}`);
      return result;
    }
    case 'booleanMap': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`token-frugal: ${key} must be a map of transform name to true or false`);
      }
      const result = {};
      for (const [transform, enabled] of Object.entries(value)) {
        if (!TRANSFORM_NAMES.includes(transform)) {
          throw new Error(`token-frugal: ${key}.${transform} is not a transform (known: ${TRANSFORM_NAMES.join(', ')})`);
        }
        result[transform] = checkBoolean(enabled, `${key}.${transform}`);
      }
      return result;
    }
    case 'modeMap': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`token-frugal: ${key} must be a map of mode id to true or false`);
      }
      const result = {};
      for (const [mode, enabled] of Object.entries(value)) {
        if (!MODE_IDS.includes(mode)) {
          throw new Error(`token-frugal: ${key}.${mode} is not a saving mode (known: ${MODE_IDS.join(', ')})`);
        }
        result[mode] = checkBoolean(enabled, `${key}.${mode}`);
      }
      return result;
    }
    case 'memoOptions':
      return checkOptions(value, key, MEMO_SPEC);
    case 'recallOptions':
      return checkOptions(value, key, RECALL_SPEC);
    case 'bridgeOptions':
      return checkOptions(value, key, BRIDGE_SPEC);
    default:
      throw new Error(`token-frugal: no validator for field "${key}"`);
  }
}

/**
 * Merge a row's config over the defaults and validate it. A key the plugin does
 * not declare is an error rather than a silent no-op, which is what a schema
 * would have enforced; the row then fails to activate with that message.
 * @param config - the loader row's `config`, if any.
 * @returns the resolved budget table, switches, and v2 feature settings.
 */
export function resolveConfig(config) {
  const supplied = config ?? {};
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
    throw new Error('token-frugal: config must be a mapping of field names to values');
  }
  for (const key of Object.keys(supplied)) {
    if (!(key in FIELD_KINDS)) {
      throw new Error(`token-frugal: unknown config field "${key}" (known: ${Object.keys(FIELD_KINDS).join(', ')})`);
    }
  }
  const checked = {};
  for (const [key, value] of Object.entries(supplied)) checked[key] = checkField(key, value);
  const merged = { ...DEFAULT_CONFIG, ...checked };
  return {
    enabled: merged.enabled,
    defaultMaxChars: merged.defaultMaxChars,
    budgets: new Map(Object.entries({ ...DEFAULT_CONFIG.toolBudgets, ...(checked.toolBudgets ?? {}) })),
    errorBudgetFactor: merged.errorBudgetFactor,
    skipTools: new Set(merged.skipTools),
    minBlockChars: merged.minBlockChars,
    minGainRatio: merged.minGainRatio,
    transforms: { ...DEFAULT_CONFIG.transforms, ...(checked.transforms ?? {}) },
    columnMinSpaces: merged.columnMinSpaces,
    repeatedMinRun: merged.repeatedMinRun,
    numericMinRun: merged.numericMinRun,
    headRatio: merged.headRatio,
    tailRatio: merged.tailRatio,
    structureAware: merged.structureAware,
    recovery: merged.recovery,
    readSourceRecovery: merged.readSourceRecovery,
    logStatsEvery: merged.logStatsEvery,
    hiddenTools: merged.hiddenTools,
    modes: { ...DEFAULT_CONFIG.modes, ...(checked.modes ?? {}) },
    memo: { ...DEFAULT_MEMO, ...(checked.memo ?? {}) },
    recall: { ...DEFAULT_RECALL, ...(checked.recall ?? {}) },
    bridge: { ...DEFAULT_BRIDGE, ...(checked.bridge ?? {}) },
  };
}

/** Resolve the memory file for a workspace path. */
function memoFileFor(resolved, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  const configured = resolved.memo.path;
  return isAbsolute(configured) ? configured : join(cwd, configured);
}

/** Read the memory document, bounded, tolerating every failure. */
function readMemo(path) {
  try {
    if (path === undefined || !existsSync(path)) return '';
    if (statSync(path).size > MEMO_READ_LIMIT) return readFileSync(path, 'utf8').slice(-MEMO_READ_LIMIT);
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The `## session` heading for one conversation. */
function sessionHeadingBlock(sessionId, cwd) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const where = typeof cwd === 'string' && cwd !== '' ? ` · ${cwd}` : '';
  return `## ${sessionId} — ${stamp} UTC${where}`;
}

/** Append one block, tolerating every failure. */
function recordBlock(path, block, logger) {
  if (path === undefined || typeof block !== 'string' || block.trim() === '') return false;
  try {
    appendFileSync(path, `${block.trim()}\n\n`);
    return true;
  } catch (error) {
    logger?.warn?.(`token-frugal: could not append to ${path} (${String(error)})`);
    return false;
  }
}

/** A JSON response, mirroring the shape the shipped routes use. */
function sendJson(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/** Read a bounded JSON request body. */
async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Concatenate a message's text blocks. */
function textOfMessage(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** A comparison key for one chunk of text: whitespace-flat, case-folded, bounded. */
function normalizeKey(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300);
}

/**
 * Mount every half of the plugin.
 * @param ctx - plugin context; `tools` is injected, `webServer` optional.
 * @param config - the row's configuration, validated here.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;

  // -------------------------------------------------------------------------
  // mode state: patch config, overlaid by the panel's persisted choice
  // -------------------------------------------------------------------------
  const stateDir = stateDirectory();
  const persisted = readState(stateDir);
  let modes = { ...resolveModes(resolved), ...persisted };
  let policy = effectivePolicy(modes);
  const modeSummary = () => ({
    modes: MODE_IDS.map((id) => ({ id, on: modes[id] !== false, available: modeAvailable(id, resolved) })),
    profileDir: stateDir ?? null,
    recallBudget: resolved.recall.maxChars,
  });

  for (const [label, value] of [['headRatio', resolved.headRatio], ['tailRatio', resolved.tailRatio]]) {
    if (value === 0) ctx.logger.warn(`token-frugal: ${label} is 0; that end of every elided result is dropped entirely`);
  }
  if (resolved.headRatio + resolved.tailRatio >= 1) {
    ctx.logger.warn('token-frugal: headRatio + tailRatio >= 1 leaves no room for the elision marker; defaults apply per call');
  }

  // -------------------------------------------------------------------------
  // 1. tools/post-execute — compress the result that becomes the log event
  // -------------------------------------------------------------------------
  const stats = { calls: 0, rewritten: 0, elided: 0, before: 0, after: 0, spillFailures: 0 };
  const baseOptions = () => ({
    transforms: policy.transforms,
    minBlockChars: resolved.minBlockChars,
    minGainRatio: resolved.minGainRatio,
    columnMinSpaces: resolved.columnMinSpaces,
    repeatedMinRun: resolved.repeatedMinRun,
    numericMinRun: resolved.numericMinRun,
  });

  /**
   * The recovery guidance injected into an elision marker, or `undefined` when
   * this result cannot be elided without losing text permanently.
   * @param exec - the tool call being finalized.
   * @param content - the result's content, before compression.
   * @returns a marker hint, or `undefined` to forbid elision.
   */
  async function recoveryHint(exec, content) {
    if (policy.recovery === 'none') return undefined;
    const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
    // A result that already carries a spill notice has a locator on it; the
    // retained preview can shrink without stranding the full text.
    if (text.includes(SPILL_NOTICE)) return '';
    if (exec.name === 'read' && resolved.readSourceRecovery) {
      const path = READ_PATH.exec(text)?.[1];
      if (path !== undefined) return `Re-read ${path} with offset/limit for the elided lines.`;
      return undefined;
    }
    const store = ctx.get('spillStore');
    const sessionId = exec.agent?.session?.header?.id;
    if (store === undefined || sessionId === undefined) return undefined;
    try {
      const ref = await store.saveText({
        owner: { sessionId },
        source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
        suggestedName: `${exec.name}.txt`,
        content: text,
      });
      return `Full text saved at ${ref.locator}: ${ref.retrievalHint}`;
    } catch (error) {
      stats.spillFailures += 1;
      ctx.logger.warn(`token-frugal: spill of ${exec.name} failed (${String(error)}); keeping the result lossless-only`);
      return undefined;
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept') return decision;
    // A value replacement re-renders content from the new value; rewriting it
    // here would fight the definition that owns the projection.
    if (Object.hasOwn(decision, 'value')) return decision;
    if (resolved.skipTools.has(exec.name)) return decision;
    const content = decision.content ?? result.content;
    if (!Array.isArray(content) || content.length === 0) return decision;
    stats.calls += 1;

    try {
      const options = baseOptions();
      // Pass 1 — lossless structure-aware compression. Always safe.
      const lossless = compressContent(content, { ...options, maxChars: undefined });
      const afterLossless = contentChars(lossless.blocks);

      const budget = result.isError
        ? Math.round((resolved.budgets.get(exec.name) ?? resolved.defaultMaxChars) * resolved.errorBudgetFactor)
        : (resolved.budgets.get(exec.name) ?? resolved.defaultMaxChars);

      let blocks = lossless.blocks;
      let elided = false;
      // Pass 2 — budgeted elision, only when the bytes stay recoverable.
      if (afterLossless > budget) {
        const hint = await recoveryHint(exec, content);
        if (hint !== undefined) {
          exec.signal?.throwIfAborted?.();
          const bounded = compressContentToBudget(blocks, budget, {
            ...options,
            headRatio: resolved.headRatio,
            tailRatio: resolved.tailRatio,
            structureAware: resolved.structureAware,
            recoveryHint: hint,
          });
          if (bounded.after < afterLossless) {
            blocks = bounded.blocks;
            elided = true;
          }
        }
      }

      const after = contentChars(blocks);
      const before = contentChars(content);
      if (after >= before) return decision;
      stats.rewritten += 1;
      if (elided) stats.elided += 1;
      stats.before += before;
      stats.after += after;
      if (resolved.logStatsEvery > 0 && stats.rewritten % resolved.logStatsEvery === 0) {
        ctx.logger.debug(
          `token-frugal: ${stats.rewritten}/${stats.calls} results rewritten, `
          + `${stats.elided} elided, ${stats.before} -> ${stats.after} chars `
          + `(${(100 * (1 - stats.after / stats.before)).toFixed(1)}% saved)`,
        );
      }
      return {
        kind: 'accept',
        content: blocks,
        ...(decision.additionalContexts !== undefined && decision.additionalContexts.length > 0
          ? { additionalContexts: decision.additionalContexts }
          : {}),
      };
    } catch (error) {
      // A compression fault must never turn a successful tool call into an
      // error, so the original decision is returned untouched.
      ctx.logger.warn(`token-frugal: ${exec.name} compression skipped (${String(error)})`);
      return decision;
    }
  });

  // -------------------------------------------------------------------------
  // 2. agent/created — tool-catalogue visibility and the memory document
  // -------------------------------------------------------------------------
  const owned = new Map();
  const sessions = new Map();

  const catalogueDisposer = (agent) => {
    const agentCtx = agent?.ctx;
    if (agentCtx?.tools === undefined) return undefined;
    try {
      const visible = new Set(ctx.tools.schemas(agent).map((schema) => schema.name));
      const deny = resolved.hiddenTools.filter((tool) => visible.has(tool));
      const missing = resolved.hiddenTools.filter((tool) => !visible.has(tool));
      if (missing.length > 0) ctx.logger.warn(`token-frugal: hiddenTools names unknown tool(s) ${missing.join(', ')}; ignoring them`);
      if (deny.length === 0) return undefined;
      return agentCtx.effect(() => agentCtx.tools.restrict({ deny }), { label: `token-frugal: hide ${deny.join(', ')}` });
    } catch (error) {
      ctx.logger.warn(`token-frugal: could not hide tools for agent ${agent?.id}: ${String(error)}`);
      return undefined;
    }
  };

  const initializeSession = (agent) => {
    const sessionId = agent?.id;
    const cwd = agent?.session?.header?.cwd;
    const memoPath = memoFileFor(resolved, cwd);
    const entry = { memoPath, cwd, turn: 0, assistant: '', injected: new Set(), recorded: false };
    sessions.set(sessionId, entry);
    // An `agent/created` listener that throws rolls back agent creation, so
    // every failure here degrades to "no restriction" with a warning.
    if (policy.catalogue) {
      const dispose = catalogueDisposer(agent);
      if (dispose !== undefined) owned.set(sessionId, dispose);
    }
    if (!resolved.memo.enabled || !policy.memo || memoPath === undefined) return;
    try {
      if (!existsSync(memoPath)) {
        mkdirSync(dirname(memoPath), { recursive: true });
        writeFileSync(memoPath, appendBlock('', sessionHeadingBlock(sessionId, cwd)));
      } else if (!readFileSync(memoPath, 'utf8').includes(`## ${sessionId} `)) {
        appendFileSync(memoPath, `\n${sessionHeadingBlock(sessionId, cwd)}\n\n`);
      }
      entry.recorded = true;
    } catch (error) {
      ctx.logger.warn(`token-frugal: memory unavailable at ${memoPath} (${String(error)})`);
    }
  };

  ctx.on('agent/created', ({ agent }) => initializeSession(agent));

  // Adopt agents that already exist under this composition, so the panel's
  // "no restart" promise holds for the session the user is looking at rather
  // than only for conversations started afterwards.
  for (const live of ctx.get('agents')?.list?.() ?? []) initializeSession(live);

  ctx.on('agent/disposed', ({ agent }) => {
    owned.get(agent?.id)?.();
    owned.delete(agent?.id);
    sessions.delete(agent?.id);
  });

  /** Re-apply or lift the catalogue restriction when the mode changes. */
  const applyCatalogue = (on) => {
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      const existing = owned.get(agent.id);
      if (on && existing === undefined) {
        const dispose = catalogueDisposer(agent);
        if (dispose !== undefined) owned.set(agent.id, dispose);
      } else if (!on && existing !== undefined) {
        existing();
        owned.delete(agent.id);
      }
    }
  };
  ctx.effect(() => () => {
    for (const dispose of owned.values()) dispose();
    owned.clear();
  });

  // -------------------------------------------------------------------------
  // 3. agent/inbox/claimed — record the input, then recall matching context
  // -------------------------------------------------------------------------
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const entry = sessions.get(agent?.id);
    if (entry === undefined) return;
    const text = textOfMessage(message);
    if (text.trim() === '') return;
    entry.turn = turn;
    if (entry.recorded && policy.memo) {
      recordBlock(entry.memoPath, userBlock(text, { maxChars: resolved.memo.maxEntryChars }), ctx.logger);
    }
    if (!resolved.recall.enabled || !policy.recall || entry.memoPath === undefined) return;
    try {
      const all = parseMemo(readMemo(entry.memoPath));
      if (all.length === 0) return;
      // Never quote the message that was just recorded: it is already in the
      // transcript the model is reading, so injecting it is pure cost.
      const currentKey = normalizeKey(text);
      const usable = all.filter((block) => !(block.kind === 'user' && normalizeKey(block.text) === currentKey));
      // Notes from *other* conversations in this workspace are the ones that
      // carry information this session has never seen; this session's own
      // blocks are only a fallback for when compaction has pruned them.
      const crossSession = usable.filter((block) => block.session !== agent.id);
      const blocks = crossSession.length > 0 ? crossSession : usable;
      if (blocks.length === 0) return;
      const selection = selectExcerpts(blocks, text, resolved.recall);
      if (selection.excerpts.length === 0) return;
      // Never inject the same extracts twice in a row: a repeated block is a
      // pure cost with no new information.
      const key = selection.excerpts.map((excerpt) => `${excerpt.heading}|${excerpt.text.length}`).join('~');
      if (entry.injected.has(key)) {
        ctx.logger.debug('token-frugal: recall matched but was already injected; skipping');
        return;
      }
      const rendered = renderRecall(selection, entry.memoPath);
      if (rendered === '') return;
      entry.injected.add(key);
      // Append-only: an `agent/inbox/spliced` event the model sees next step, so
      // the request prefix stays intact for the provider's cache.
      agent.inject?.({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: rendered }] });
      ctx.logger.debug(
        `token-frugal: recalled ${selection.excerpts.length} block(s), ${selection.chars} chars, `
        + `terms=[${selection.matchedTerms.slice(0, 8).join(',')}]`,
      );
    } catch (error) {
      ctx.logger.warn(`token-frugal: recall skipped (${String(error)})`);
    }
  });

  // -------------------------------------------------------------------------
  // 4. session/event — digest each completed turn into the memory document
  // -------------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const entry = sessions.get(session?.id);
    if (entry === undefined || !entry.recorded || !policy.memo) return;
    if (event?.type === 'assistant/message') {
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text !== '') entry.assistant += `${text}\n`;
      return;
    }
    if (event?.type !== 'turn/end') return;
    const points = extractPoints(entry.assistant);
    entry.assistant = '';
    // A new turn's digest changes what is worth re-injecting.
    entry.injected.clear();
    if (points.length === 0) return;
    recordBlock(entry.memoPath, summaryBlock(points, { turn: event.data?.turn }), ctx.logger);
  });

  // -------------------------------------------------------------------------
  // 5. the panel bridge — an exact HTTP route the Client half fetches
  // -------------------------------------------------------------------------
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    ctx.logger.warn('token-frugal: no webServer service; the composer panel cannot reach this plugin');
  } else {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: resolved.bridge.path,
      handler: async (request, response) => {
        try {
          if (request.method === 'GET') {
            sendJson(response, 200, { ...modeSummary(), version: 2 });
            return;
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' });
            response.end();
            return;
          }
          const body = await readJsonBody(request);
          const patch = sanitizeModePatch(body?.modes);
          if (Object.keys(patch).length === 0) {
            sendJson(response, 400, { error: 'no valid mode values in "modes"' });
            return;
          }
          const previous = { ...modes };
          modes = { ...modes, ...patch };
          policy = effectivePolicy(modes);
          if (Object.hasOwn(patch, 'catalogue')) applyCatalogue(policy.catalogue);
          const path = writeState(stateDir, modes);
          ctx.logger.info(
            `token-frugal: modes changed via panel (${Object.entries(patch).map(([key, on]) => `${key}=${on}`).join(' ')}), `
            + `${path === undefined ? 'NOT persisted (no profile directory)' : `persisted to ${path}`}`,
          );
          sendJson(response, 200, { ...modeSummary(), changed: patch, previous, persistedTo: path ?? null });
        } catch (error) {
          sendJson(response, 400, { error: String(error?.message ?? error) });
        }
      },
    }), 'token-frugal: mode route');
  }

  if (resolved.logStatsEvery > 0) {
    const budgets = [...resolved.budgets].map(([tool, chars]) => `${tool}=${chars}`).join(' ');
    const on = MODE_IDS.filter((id) => modes[id] !== false && modeAvailable(id, resolved));
    ctx.logger.info(
      `token-frugal: ready (defaultMaxChars=${resolved.defaultMaxChars} budgets= ${budgets}) `
      + `modes=[${on.join(',')}] memo=${resolved.memo.enabled ? resolved.memo.path : 'off'} `
      + `recall=${resolved.recall.enabled ? `${resolved.recall.maxChars}chars` : 'off'} bridge=${resolved.bridge.path}`,
    );
  }
}
