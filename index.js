/**
 * `dsh-token-frugal` — cut the token cost of a long session's tool output and
 * tool catalogue without changing what the model can accomplish.
 *
 * Two extension points, both inside the Harness event flow:
 *
 * 1. `tools/post-execute` — compress each accepted result's text before it is
 *    logged. The returned decision's `content` is what `dsh-agent-loop`
 *    appends as the `tool/result` event and what the model reads, so the
 *    model-visible and logged copies are the same bytes by construction.
 * 2. `agent/created` — hide configured tools from one agent through
 *    `ctx.tools.restrict()` on that agent's scoped context. A changed visible
 *    set is recorded by the loop as `tool-addition` / `tool-removal` developer
 *    blocks, so the log and the model agree there too.
 *
 * Neither half reimplements a Harness capability: historical surface rewriting
 * stays with `dsh-compaction-tool-result-pruner`, and full-text retention stays
 * with `ctx.spillStore` — this plugin calls that service when its own elision
 * needs a recovery path, and degrades to lossless-only when it is absent.
 *
 * The module imports nothing but its own files, not even a Harness package. A
 * profile-installed bundle resolves from the profile's `node_modules`, so a
 * bare `@deepseek-ai/*` specifier fails to import there — only bundles inside
 * the dsh installation can reach those. The price of that constraint is that
 * this plugin cannot export a schemastery `Config`, so it validates its own row
 * config against `FIELD_KINDS` instead, and the fields live in
 * `lib/defaults.js` so the measurement script prices the same policy that
 * mounts.
 *
 * @module dsh-token-frugal
 */
import { compressContent, compressContentToBudget } from './lib/compress.js';
import { contentChars } from './lib/estimate.js';
import { DEFAULT_CONFIG } from './lib/defaults.js';

/** Cordis plugin identity. */
export const name = 'token-frugal';
/** Both halves need the registry: `tools/post-execute` and `tools.restrict`. */
export const inject = ['tools'];

/** The substring `dsh-spill-policy` always writes into its recovery notice. */
const SPILL_NOTICE = 'Full formatted result stored at:';
/** The path tag the `read` tool prefixes to a file's content. */
const READ_PATH = /^<path>([\s\S]*?)<\/path>/;

/** Lossless transforms that may be toggled individually. */
const TRANSFORM_NAMES = Object.keys(DEFAULT_CONFIG.transforms);

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

/** Reject a value that is not a list of strings. */
function checkStrings(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`token-frugal: ${label} must be a list of strings (got ${JSON.stringify(value)})`);
  }
  return value;
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
      if (typeof value !== 'boolean') throw new Error(`token-frugal: ${key} must be true or false (got ${JSON.stringify(value)})`);
      return value;
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
        if (typeof enabled !== 'boolean') {
          throw new Error(`token-frugal: ${key}.${transform} must be true or false (got ${JSON.stringify(enabled)})`);
        }
        result[transform] = enabled;
      }
      return result;
    }
    default:
      throw new Error(`token-frugal: no validator for field "${key}"`);
  }
}

/**
 * Merge a row's config over the defaults and validate it. A key the plugin does
 * not declare is an error rather than a silent no-op, which is what a schema
 * would have enforced; the row then fails to activate with that message.
 * @param config - the loader row's `config`, if any.
 * @returns the resolved budget table and switches.
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
  };
}

/**
 * Mount both halves of the plugin.
 * @param ctx - plugin context; `tools` is injected.
 * @param config - the row's configuration, validated here.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;

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
  const baseOptions = {
    transforms: resolved.transforms,
    minBlockChars: resolved.minBlockChars,
    minGainRatio: resolved.minGainRatio,
    columnMinSpaces: resolved.columnMinSpaces,
    repeatedMinRun: resolved.repeatedMinRun,
    numericMinRun: resolved.numericMinRun,
  };

  /**
   * The recovery guidance injected into an elision marker, or `undefined` when
   * this result cannot be elided without losing text permanently.
   * @param exec - the tool call being finalized.
   * @param content - the result's content, before compression.
   * @returns a marker hint, or `undefined` to forbid elision.
   */
  async function recoveryHint(exec, content) {
    if (resolved.recovery === 'none') return undefined;
    const text = content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');
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
      // Pass 1 — lossless structure-aware compression. Always safe.
      const lossless = compressContent(content, { ...baseOptions, maxChars: undefined });
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
            ...baseOptions,
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
  // 2. agent/created — per-agent tool-schema visibility
  // -------------------------------------------------------------------------
  if (resolved.hiddenTools.length > 0) {
    const owned = new Map();
    ctx.on('agent/created', ({ agent }) => {
      const agentCtx = agent?.ctx;
      if (agentCtx?.tools === undefined) {
        ctx.logger.warn('token-frugal: agent has no scoped context; hiddenTools not applied');
        return;
      }
      // An `agent/created` listener that throws rolls back agent creation, so
      // every failure here degrades to "no restriction" with a warning.
      try {
        const visible = new Set(ctx.tools.schemas(agent).map((schema) => schema.name));
        const deny = resolved.hiddenTools.filter((tool) => visible.has(tool));
        const missing = resolved.hiddenTools.filter((tool) => !visible.has(tool));
        if (missing.length > 0) ctx.logger.warn(`token-frugal: hiddenTools names unknown tool(s) ${missing.join(', ')}; ignoring them`);
        if (deny.length === 0) return;
        const dispose = agentCtx.effect(() => agentCtx.tools.restrict({ deny }), {
          label: `token-frugal: hide ${deny.join(', ')}`,
        });
        owned.set(agent.id, dispose);
      } catch (error) {
        ctx.logger.warn(`token-frugal: could not hide tools for agent ${agent?.id}: ${String(error)}`);
      }
    });
    ctx.on('agent/disposed', ({ agent }) => {
      owned.get(agent?.id)?.();
      owned.delete(agent?.id);
    });
    // The agent-scoped registrations live as long as the agent; unloading this
    // plugin must lift them too.
    ctx.effect(() => () => {
      for (const dispose of owned.values()) dispose();
      owned.clear();
    });
    ctx.logger.info(`token-frugal: hiding ${resolved.hiddenTools.join(', ')} from every agent's tool catalogue`);
  }

  if (resolved.logStatsEvery > 0) {
    const budgets = [...resolved.budgets].map(([tool, chars]) => `${tool}=${chars}`).join(' ');
    ctx.logger.info(
      `token-frugal: ready (defaultMaxChars=${resolved.defaultMaxChars} recovery=${resolved.recovery} `
      + `skip=[${[...resolved.skipTools].join(',')}] ${budgets})`,
    );
  }
}
