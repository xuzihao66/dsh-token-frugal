#!/usr/bin/env node
/**
 * Measure what `dsh-token-frugal` changes, from recorded sessions.
 *
 * The script replays each durable session log twice — once as recorded and once
 * with the plugin's configured compression applied to every `tool/result` —
 * and prices both with the same fixed-density heuristic the Harness uses for
 * its `contextBreakdown` projection (`ceil(chars / 4)` plus per-block and
 * per-role framing; see `lib/estimate.js`). It reports:
 *
 *   - prompt tokens per model request, before and after;
 *   - the cache-eligible token share of each request, before and after, which
 *     is the part a provider's prefix cache can reuse;
 *   - the provider-reported cache hit rate actually observed in the log;
 *   - the tool-catalogue token cost, and what `hiddenTools` would remove.
 *
 * The surface is rebuilt from `surfaceOp` records, so replacements, resumes,
 * and compaction are priced the way the loop actually assembles a request.
 *
 * Output is bounded on purpose: stdout prints at most `--max-lines` lines and
 * `--json <path>` writes the full report to a file, so running this cannot
 * flood the context that invoked it.
 *
 * Usage:
 *   node tools/measure-tokens.mjs [options] [session-log-or-directory ...]
 *
 * @module dsh-token-frugal/tools/measure-tokens
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import zlib from 'node:zlib';
import { compressText, compressContent, compressContentToBudget } from '../lib/compress.js';
import { estimateMessage, estimateToolsTokens, contentChars } from '../lib/estimate.js';
import { DEFAULT_CONFIG } from '../lib/defaults.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

const USAGE = `Measure the token effect of dsh-token-frugal on recorded sessions.

  node tools/measure-tokens.mjs [options] [session-log-or-directory ...]

  --json <path>         write the full report as JSON
  --max-lines <n>       stdout line budget (default 100)
  --target <percent>    reduction target for the verdict (default 40)
  --patch <path>        bundle patch to read the policy from
  --no-patch            use lib/defaults.js and ignore the patch
  --config <path>       read the policy from a JSON file
  --budgets <a:1,b:2>   override per-tool character budgets
  --default-max-chars <n>
  --no-elide            lossless transforms only; nothing is ever dropped
  --only <tool>         restrict the per-tool table
  --compare-placement   also model rewriting history late instead of at source
  --include-live        include the session that is still being written
  --quiet               suppress the stdout summary

Exit status is 0 when the target is met, 2 when it is not, 1 on a usage error.
`;

// ---------------------------------------------------------------------------
// session logs
// ---------------------------------------------------------------------------

/**
 * Decode a `session.v4.jsonl.zstd` buffer. The Harness appends one zstd frame
 * per durable flush, so frames are decoded individually and concatenated.
 * @param buffer - the log file's bytes.
 * @returns the decoded JSONL text.
 */
function decodeLogBuffer(buffer) {
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) starts.push(i);
  }
  if (starts.length === 0) return zlib.zstdDecompressSync(buffer).toString('utf8');
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    let decoded;
    for (let j = k + 1; j <= starts.length; j++) {
      const end = j < starts.length ? starts[j] : buffer.length;
      try { decoded = zlib.zstdDecompressSync(buffer.subarray(starts[k], end)); break; } catch { /* extend the slice */ }
    }
    if (decoded !== undefined) parts.push(decoded);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Decode one session log file. */
function decodeLog(path) {
  return decodeLogBuffer(readFileSync(path));
}

/** Parse one session log into its durable events. */
function readEvents(path) {
  const events = [];
  for (const line of decodeLog(path).split('\n')) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line)); } catch { /* a torn final line is not fatal */ }
  }
  return events;
}

/**
 * Find every session log under the given paths, or this machine's default root.
 * @param inputs - explicit files or directories; the default root otherwise.
 * @param options - `exclude` drops any path containing that id (the session
 *   running this measurement is still being appended to, which would make the
 *   result depend on when it was taken).
 * @returns the log paths, sorted.
 */
function findLogs(inputs, options = {}) {
  const roots = inputs.length > 0
    ? inputs
    : [process.env.DSH_SESSION_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')];
  const found = [];
  const walk = (path, depth) => {
    let info;
    try { info = statSync(path); } catch { return; }
    if (info.isFile()) {
      if ((path.endsWith('.jsonl.zstd') || path.endsWith('.jsonl')) && !(options.exclude !== undefined && path.includes(options.exclude))) found.push(path);
      return;
    }
    if (!info.isDirectory() || depth > 4) return;
    for (const entry of readdirSync(path)) walk(join(path, entry), depth + 1);
  };
  for (const root of roots) walk(resolve(root), 0);
  return found.sort();
}

// ---------------------------------------------------------------------------
// policy: defaults < bundle patch < JSON config < CLI flags
// ---------------------------------------------------------------------------

/**
 * Read the row `config` out of a bundle patch without a YAML dependency. Only
 * the shape this plugin's own patch uses is understood — scalars, one-level
 * maps, inline and block lists — and an unknown key is reported rather than
 * guessed at.
 * @param path - the patch file.
 * @returns the parsed config, or `undefined` when there is none.
 */
function readPatchConfig(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return undefined; }
  const config = {};
  let inRow = false;
  let configIndent = -1;
  let nested = null;
  let nestedIndent = -1;
  const scalar = (raw) => {
    const value = raw.trim();
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (/^\[.*\]$/.test(value)) {
      const inner = value.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map((part) => scalar(part));
    }
    // An inline map (`modes: {}`, `transforms: { json: false }`), which is how a
    // one-line override is most naturally written.
    if (/^\{.*\}$/.test(value)) {
      const inner = value.slice(1, -1).trim();
      if (inner === '') return {};
      const out = {};
      for (const pair of inner.split(',')) {
        const at = pair.indexOf(':');
        if (at === -1) continue;
        out[pair.slice(0, at).trim().replace(/^['"]|['"]$/g, '')] = scalar(pair.slice(at + 1));
      }
      return out;
    }
    return value.replace(/^['"]|['"]$/g, '');
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^-?\s*id:\s*token-frugal\s*$/.test(trimmed)) { inRow = true; continue; }
    if (!inRow) continue;
    if (trimmed.startsWith('- ')) {
      if (nested !== null) {
        if (!Array.isArray(config[nested])) config[nested] = [];
        config[nested].push(scalar(trimmed.slice(2)));
      }
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
    if (match === null) continue;
    const [, key, rest] = match;
    if (key === 'config') { configIndent = indent; continue; }
    if (configIndent === -1) continue;
    if (indent <= configIndent) break; // the row's config block ended
    if (rest === '') {
      nested = key;
      nestedIndent = indent;
      if (config[key] === undefined || Array.isArray(config[key])) config[key] = {};
      continue;
    }
    if (nested !== null && indent > nestedIndent) {
      config[nested][key] = scalar(rest);
      continue;
    }
    nested = null;
    nestedIndent = -1;
    config[key] = scalar(rest);
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

/** Merge the policy sources in precedence order. */
function resolvePolicy(options) {
  const policy = {
    ...DEFAULT_CONFIG,
    toolBudgets: { ...DEFAULT_CONFIG.toolBudgets },
    transforms: { ...DEFAULT_CONFIG.transforms },
    skipTools: [...DEFAULT_CONFIG.skipTools],
    hiddenTools: [...DEFAULT_CONFIG.hiddenTools],
  };
  let source = 'lib/defaults.js';
  const apply = (from, label) => {
    for (const [key, value] of Object.entries(from)) {
      if (!(key in policy)) {
        throw new Error(`token-frugal: ${label} sets unknown key "${key}"; refusing to measure a policy the plugin would reject`);
      }
      if (key === 'toolBudgets' || key === 'transforms') Object.assign(policy[key], value);
      else policy[key] = value;
    }
    source = label;
  };
  if (options.patch !== false) {
    const patchPath = typeof options.patch === 'string' ? options.patch : join(HERE, '..', 'cordis.patch.yml');
    const fromPatch = readPatchConfig(patchPath);
    if (fromPatch !== undefined) apply(fromPatch, patchPath);
  }
  if (typeof options.config === 'string') {
    apply(JSON.parse(readFileSync(options.config, 'utf8')), options.config);
  }
  if (typeof options.budgets === 'string') {
    for (const pair of options.budgets.split(',')) {
      const [tool, chars] = pair.split(':');
      policy.toolBudgets[tool.trim()] = Number(chars);
    }
    source = `${source} + --budgets`;
  }
  if (Number.isSafeInteger(options.defaultMaxChars)) {
    policy.defaultMaxChars = options.defaultMaxChars;
    source = `${source} + --default-max-chars`;
  }
  if (options.elide === false) {
    policy.recovery = 'none';
    source = `${source} + --no-elide`;
  }
  return { policy, source };
}

/** The option table `compressText` is driven with. */
function compressOptions(policy) {
  return {
    transforms: policy.transforms,
    minBlockChars: policy.minBlockChars,
    minGainRatio: policy.minGainRatio,
    columnMinSpaces: policy.columnMinSpaces,
    repeatedMinRun: policy.repeatedMinRun,
    numericMinRun: policy.numericMinRun,
    headRatio: policy.headRatio,
    tailRatio: policy.tailRatio,
    structureAware: policy.structureAware,
  };
}

/**
 * How the plugin would treat one result, mirroring `index.js`: the lossless
 * pass, then a budgeted elision whose marker names the recovery path. The
 * content array's structure is preserved throughout.
 * @returns the resulting content, whether elision fired, and the char effect.
 */
function applyPolicy(policy, name, content, isError) {
  const options = compressOptions(policy);
  const before = contentChars(content);
  if (policy.skipTools.includes(name)) return { content, elided: false, skipped: true, before, after: before };

  const lossless = compressContent(content, { ...options, maxChars: undefined });
  let blocks = lossless.blocks;
  let elided = false;
  const budget = Math.round(
    (policy.toolBudgets[name] ?? policy.defaultMaxChars) * (isError ? policy.errorBudgetFactor : 1),
  );
  if (policy.recovery !== 'none' && lossless.after > budget) {
    const hint = recoveryHint(policy, name, textOf(content));
    if (hint !== undefined) {
      const bounded = compressContentToBudget(blocks, budget, { ...options, recoveryHint: hint });
      if (bounded.after < lossless.after) { blocks = bounded.blocks; elided = true; }
    }
  }
  return { content: blocks, elided, skipped: false, before, after: contentChars(blocks) };
}

/** Concatenate a content array's text, as the plugin does for its notice and path checks. */
function textOf(content) {
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
}

/**
 * The recovery hint the plugin would put in an elision marker, or `undefined`
 * when it would refuse to elide because the text could not be recovered.
 * @param policy - the resolved policy.
 * @param name - the tool name.
 * @param text - the result text before compression.
 * @returns the marker hint, or `undefined`.
 */
function recoveryHint(policy, name, text) {
  if (text.includes('Full formatted result stored at:')) return '';
  if (name === 'read' && policy.readSourceRecovery) {
    const path = /^<path>([\s\S]*?)<\/path>/.exec(text)?.[1];
    return path === undefined ? undefined : `Re-read ${path} with offset/limit for the elided lines.`;
  }
  // A live run calls ctx.spillStore.saveText here and names the locator it
  // returns; a replay has no backend, so the hint stands in for that locator.
  return 'Full text was saved by the spill backend; use its locator above.';
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

/**
 * Apply one surface event to the live node list, in place.
 * `append` pushes; a `replace` intent swaps the cited range for the new event.
 */
function applySurfaceOp(nodes, event) {
  const op = event.surfaceOp;
  if (op === undefined || op === 'append') { nodes.push(event); return; }
  if (typeof op !== 'object' || op.op !== 'replace') return;
  const first = nodes.findIndex((node) => node.seq >= op.startSeq);
  if (first === -1) { nodes.push(event); return; }
  let count = 0;
  while (first + count < nodes.length && nodes[first + count].seq <= op.endSeq) count += 1;
  nodes.splice(first, count, event);
}

/** A surface node's model-visible message. */
function messageOf(event) {
  if (event.type === 'user/message') return event.data;
  return event.data?.message;
}

/** Common prefix length of two arrays. */
function sharedPrefix(previous, current) {
  let i = 0;
  while (i < previous.length && i < current.length && previous[i] === current[i]) i += 1;
  return i;
}

/**
 * Replay one session, pricing every model request with and without the policy.
 * @param events - the session's durable events.
 * @param policy - the resolved policy.
 * @returns per-request measurements, per-tool aggregates, usage, and schemas.
 */
function replay(events, policy) {
  const callNames = new Map();
  const calls = new Map();
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    callNames.set(event.data?.callId, event.data?.name);
    calls.set(event.data?.name, (calls.get(event.data?.name) ?? 0) + 1);
  }

  const requests = [];
  const toolStats = new Map();
  const schemas = new Map();
  // One application per node: a node is re-priced on every later request, but
  // it is compressed once, and the per-tool table counts nodes, not visits.
  const applied = new Map();
  const nodes = [];
  let tools = [];
  let toolsKey = '[]';

  for (const event of events) {
    if (event.type === 'request/header') {
      tools = event.data?.header?.tools ?? [];
      toolsKey = JSON.stringify(tools);
      for (const schema of tools) {
        const chars = JSON.stringify(schema).length;
        if (chars > (schemas.get(schema.name) ?? 0)) schemas.set(schema.name, chars);
      }
      continue;
    }
    if (SURFACE.has(event.type)) {
      applySurfaceOp(nodes, event);
      continue;
    }
    if (event.type !== 'step/start') continue;

    const seqs = [];
    const baselinePrices = [];
    const optimizedPrices = [];
    for (const node of nodes) {
      const original = messageOf(node);
      if (original === undefined) continue;
      let optimized = original;
      if (node.type === 'tool/result') {
        let entry = applied.get(node.seq);
        if (entry === undefined) {
          const name = callNames.get(original.toolCallId) ?? 'unknown';
          const content = original.content ?? [];
          const result = applyPolicy(policy, name, content, original.isError === true);
          const stat = toolStats.get(name) ?? { results: 0, elided: 0, beforeChars: 0, afterChars: 0, beforeTokens: 0, afterTokens: 0 };
          stat.results += 1;
          if (result.elided) stat.elided += 1;
          stat.beforeChars += result.before;
          stat.afterChars += result.after;
          stat.beforeTokens += estimateMessage(original);
          const compressedMessage = { ...original, content: result.content };
          stat.afterTokens += estimateMessage(compressedMessage);
          toolStats.set(name, stat);
          entry = { optimized: compressedMessage };
          applied.set(node.seq, entry);
        }
        optimized = entry.optimized;
      }
      seqs.push(node.seq);
      baselinePrices.push(estimateMessage(original));
      optimizedPrices.push(estimateMessage(optimized));
    }
    const baseline = baselinePrices.reduce((a, b) => a + b, 0);
    const optimized = optimizedPrices.reduce((a, b) => a + b, 0);
    const toolTokens = estimateToolsTokens(tools);
    const previous = requests.at(-1);
    let baselineEligible = toolTokens;
    let optimizedEligible = toolTokens;
    let toolsChanged = false;
    if (previous !== undefined) {
      const shared = sharedPrefix(previous.seqs, seqs);
      toolsChanged = previous.toolsKey !== toolsKey;
      const toolReuse = toolsChanged ? 0 : toolTokens;
      baselineEligible = toolReuse + previous.baselinePrices.slice(0, shared).reduce((a, b) => a + b, 0);
      optimizedEligible = toolReuse + previous.optimizedPrices.slice(0, shared).reduce((a, b) => a + b, 0);
    }
    requests.push({
      seqs,
      baselinePrices,
      optimizedPrices,
      toolsKey,
      toolTokens,
      toolsChanged,
      baseline,
      optimized,
      baselineEligible,
      optimizedEligible,
    });
  }

  const usage = events
    .filter((event) => event.type === 'assistant/message' && event.data?.usage !== undefined)
    .map((event) => event.data.usage);
  return { requests, toolStats, usage, schemas, calls };
}

/** Fold one session's replay into the running report. */
function accumulate(report, path, result, options) {
  const session = {
    session: path.split(/[\\/]/).slice(-2, -1)[0] ?? path,
    requests: 0,
    baselineTokens: 0,
    optimizedTokens: 0,
    baselineEligible: 0,
    optimizedEligible: 0,
    lateEligible: 0,
    toolEnvelopeChanges: 0,
    observed: { attempts: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  };
  for (const request of result.requests) {
    session.requests += 1;
    session.baselineTokens += request.baseline + request.toolTokens;
    session.optimizedTokens += request.optimized + request.toolTokens;
    session.baselineEligible += Math.min(request.baselineEligible, request.baseline + request.toolTokens);
    session.optimizedEligible += Math.min(request.optimizedEligible, request.optimized + request.toolTokens);
    if (request.toolsChanged) session.toolEnvelopeChanges += 1;
    if (options.comparePlacement) {
      // Model the alternative placement: the same reduction delivered by
      // rewriting history once, late. That single rewrite destroys the prefix
      // the previous request established, so the request that lands it pays a
      // full uncached prefill instead of a cache read.
      if (!session.lateLanded && request.optimized < request.baseline) {
        session.lateLanded = true;
        session.lateEligible += request.toolTokens;
        session.lateRewriteTokens = request.baseline + request.toolTokens;
      } else {
        session.lateEligible += Math.min(request.optimizedEligible, request.optimized + request.toolTokens);
      }
    }
  }
  for (const entry of result.usage) {
    session.observed.attempts += 1;
    session.observed.inputTokens += entry.inputTokens ?? 0;
    session.observed.cacheReadTokens += entry.cacheReadTokens ?? 0;
    session.observed.outputTokens += entry.outputTokens ?? 0;
  }
  report.sessions.push(session);
  for (const [name, stat] of result.toolStats) {
    const aggregate = report.tools.get(name) ?? { results: 0, elided: 0, beforeChars: 0, afterChars: 0, beforeTokens: 0, afterTokens: 0 };
    for (const key of Object.keys(aggregate)) aggregate[key] += stat[key];
    report.tools.set(name, aggregate);
  }
  for (const [name, chars] of result.schemas) {
    if (chars > (report.schemas.get(name) ?? 0)) report.schemas.set(name, chars);
  }
  for (const [name, count] of result.calls) report.calls.set(name, (report.calls.get(name) ?? 0) + count);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** Parse the command line. */
function parseArgs(list) {
  const options = { files: [], elide: true, maxLines: 100, target: 40, comparePlacement: false };
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === '--json') options.json = list[++i];
    else if (arg === '--max-lines') options.maxLines = Number(list[++i]);
    else if (arg === '--target') options.target = Number(list[++i]);
    else if (arg === '--patch') options.patch = list[++i];
    else if (arg === '--no-patch') options.patch = false;
    else if (arg === '--config') options.config = list[++i];
    else if (arg === '--budgets') options.budgets = list[++i];
    else if (arg === '--default-max-chars') options.defaultMaxChars = Number(list[++i]);
    else if (arg === '--no-elide') options.elide = false;
    else if (arg === '--only') options.only = list[++i];
    else if (arg === '--compare-placement') options.comparePlacement = true;
    else if (arg === '--include-live') options.includeLive = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  return options;
}

/** Run one measurement and print the bounded summary. */
function main(options) {
  const { policy, source } = resolvePolicy(options);
  // A session that is still being appended to would make the result depend on
  // when the measurement was taken, so it is excluded unless asked for.
  const live = process.env.DSH_SESSION_ID;
  const exclude = options.includeLive === true ? undefined : live;
  const logs = findLogs(options.files, { exclude });
  if (logs.length === 0) {
    process.stderr.write('token-frugal: no session logs found; pass a session directory or file\n');
    process.exit(1);
  }

  const report = { generatedAt: new Date().toISOString(), policySource: source, policy, logs, sessions: [], tools: new Map(), schemas: new Map(), calls: new Map() };
  for (const log of logs) {
    let events;
    try { events = readEvents(log); } catch (error) {
      process.stderr.write(`token-frugal: skipping ${log}: ${String(error)}\n`);
      continue;
    }
    if (events.length === 0 || events[0].type !== 'session') continue;
    accumulate(report, log, replay(events, policy), options);
  }

  // -------------------------------------------------------------------------
  // report
  // -------------------------------------------------------------------------

  const sum = (key) => report.sessions.reduce((total, session) => total + (session[key] ?? 0), 0);
  const totals = {
    requests: sum('requests'),
    baselineTokens: sum('baselineTokens'),
    optimizedTokens: sum('optimizedTokens'),
    baselineEligible: sum('baselineEligible'),
    optimizedEligible: sum('optimizedEligible'),
    lateEligible: sum('lateEligible'),
    toolEnvelopeChanges: sum('toolEnvelopeChanges'),
  };
  const pct = (before, after) => (before === 0 ? 0 : (1 - after / before) * 100);
  const reduction = pct(totals.baselineTokens, totals.optimizedTokens);
  const toolChars = { before: 0, after: 0 };
  for (const stat of report.tools.values()) { toolChars.before += stat.beforeChars; toolChars.after += stat.afterChars; }
  const observedInput = report.sessions.reduce((a, s) => a + s.observed.inputTokens, 0);
  const observedCache = report.sessions.reduce((a, s) => a + s.observed.cacheReadTokens, 0);
  const observedAttempts = report.sessions.reduce((a, s) => a + s.observed.attempts, 0);
  const observedRate = observedInput + observedCache === 0 ? 0 : (observedCache / (observedInput + observedCache)) * 100;

  report.targets = { percent: options.target, met: reduction >= options.target };
  report.totals = {
    ...totals,
    toolCharsBefore: toolChars.before,
    toolCharsAfter: toolChars.after,
    toolCharReductionPercent: Number(pct(toolChars.before, toolChars.after).toFixed(2)),
    reductionPercent: Number(reduction.toFixed(2)),
    cacheHitRateBefore: totals.baselineTokens === 0 ? 0 : Number(((totals.baselineEligible / totals.baselineTokens) * 100).toFixed(2)),
    cacheHitRateAfter: totals.optimizedTokens === 0 ? 0 : Number(((totals.optimizedEligible / totals.optimizedTokens) * 100).toFixed(2)),
    observed: { attempts: observedAttempts, inputTokens: observedInput, cacheReadTokens: observedCache, cacheHitRate: Number(observedRate.toFixed(2)) },
  };
  report.toolSchemas = [...report.schemas]
    .map(([name, chars]) => ({
      name,
      chars,
      tokens: Math.ceil(chars / 4) + 4,
      calls: report.calls.get(name) ?? 0,
      hidden: (policy.hiddenTools ?? []).includes(name),
    }))
    .sort((a, b) => b.chars - a.chars);

  const out = [];
  const push = (line) => out.push(String(line).slice(0, 240));
  const hidden = policy.hiddenTools ?? [];
  const hiddenTokens = report.toolSchemas.filter((entry) => entry.hidden).reduce((a, e) => a + e.tokens, 0);
  const catalogueTokens = report.toolSchemas.reduce((a, e) => a + e.tokens, 0);

  push('dsh-token-frugal measurement');
  push(`  policy        ${source}`);
  push(`  sessions      ${report.sessions.length} replayed from ${logs.length} log file(s)`);
  if (exclude !== undefined) push(`  excluded      the in-flight session ${exclude} (still being written; --include-live to include it)`);
  push(`  requests      ${totals.requests}`);
  push(`  elision       ${policy.recovery === 'none' ? 'disabled (lossless transforms only)' : 'enabled, with a recovery hint in every marker'}`);
  push('');
  push('Tool output, before -> after');
  push(`  chars     ${String(toolChars.before).padStart(9)} -> ${String(toolChars.after).padStart(9)}  ${pct(toolChars.before, toolChars.after).toFixed(1)}%`);
  const perToolBudget = Math.max(0, options.maxLines - 32);
  const toolRows = [...report.tools]
    .filter(([name]) => options.only === undefined || name === options.only)
    .sort((a, b) => b[1].beforeChars - a[1].beforeChars);
  for (const [name, stat] of toolRows.slice(0, perToolBudget)) {
    push(
      `    ${name.padEnd(22)} chars ${String(stat.beforeChars).padStart(8)} -> ${String(stat.afterChars).padStart(8)}`
      + ` ${pct(stat.beforeChars, stat.afterChars).toFixed(1).padStart(5)}%`
      + `  tokens ${String(stat.beforeTokens).padStart(7)} -> ${String(stat.afterTokens).padStart(7)}`
      + `  n=${String(stat.results).padStart(3)} elided=${String(stat.elided).padStart(3)}`,
    );
  }
  push('');
  push('Model requests, before -> after (estimated prompt tokens)');
  push(`  prompt tokens     ${String(totals.baselineTokens).padStart(10)} -> ${String(totals.optimizedTokens).padStart(10)}  ${reduction.toFixed(2)}%`);
  push(`  cache-eligible    ${String(totals.baselineEligible).padStart(10)} -> ${String(totals.optimizedEligible).padStart(10)}  ${pct(totals.baselineEligible, totals.optimizedEligible).toFixed(2)}%`);
  push(`  uncached (miss)   ${String(totals.baselineTokens - totals.baselineEligible).padStart(10)} -> ${String(totals.optimizedTokens - totals.optimizedEligible).padStart(10)}  ${pct(totals.baselineTokens - totals.baselineEligible, totals.optimizedTokens - totals.optimizedEligible).toFixed(2)}%`);
  push(`  cache hit rate    ${report.totals.cacheHitRateBefore.toFixed(2)}% -> ${report.totals.cacheHitRateAfter.toFixed(2)}%   (cache-eligible share of the prompt)`);
  push(`  tool envelope     changed ${totals.toolEnvelopeChanges} time(s) during the replay`);
  if (options.comparePlacement) {
    const late = totals.baselineTokens === 0 ? 0 : (totals.lateEligible / totals.baselineTokens) * 100;
    const rewriteTokens = report.sessions.reduce((a, s) => a + (s.lateRewriteTokens ?? 0), 0);
    push(`  late rewrite      ${String(totals.lateEligible).padStart(10)} eligible -> hit rate ${late.toFixed(2)}%   (one rewrite pass per session)`);
    push(`  rewrite cost      ${rewriteTokens} prompt tokens leave the cache, once per session;`);
    push('                    the source-side placement never pays it');
  }
  push('');
  push('Per session, before -> after');
  for (const session of report.sessions) {
    push(
      `    ${session.session.slice(0, 34).padEnd(34)} req ${String(session.requests).padStart(4)}`
      + `  prompt ${String(session.baselineTokens).padStart(9)} -> ${String(session.optimizedTokens).padStart(9)}`
      + ` ${pct(session.baselineTokens, session.optimizedTokens).toFixed(1).padStart(5)}%`
      + `  cache ${(session.baselineTokens === 0 ? 0 : (session.baselineEligible / session.baselineTokens) * 100).toFixed(1)}%`
      + ` -> ${(session.optimizedTokens === 0 ? 0 : (session.optimizedEligible / session.optimizedTokens) * 100).toFixed(1)}%`,
    );
  }
  push('');
  push('Provider usage recorded in the same logs');
  push(`  attempts ${observedAttempts}   uncached input ${observedInput}   cache read ${observedCache}`);
  push(`  observed cache hit rate ${observedRate.toFixed(2)}%   (cacheRead / (cacheRead + uncached input))`);
  push('');
  push('Tool catalogue');
  push(`  tools recorded ${report.toolSchemas.length}, catalogue ${catalogueTokens} tokens, largest schema ${report.toolSchemas[0]?.chars ?? 0} chars`);
  const neverCalled = report.toolSchemas.filter((entry) => entry.calls === 0);
  const neverCalledTokens = neverCalled.reduce((a, e) => a + e.tokens, 0);
  const spentOnUnused = neverCalledTokens * totals.requests;
  push(`  never called in ${totals.requests} recorded request(s): ${neverCalled.length} tool(s), ${neverCalledTokens} tokens per request`);
  push(`  that is ${spentOnUnused} prompt tokens (${((spentOnUnused / totals.baselineTokens) * 100).toFixed(2)}% of the baseline) paid for schemas nothing used`);
  if (neverCalled.length > 0) {
    push(`  largest: ${neverCalled.slice(0, 8).map((e) => `${e.name}(${e.tokens})`).join(' ')}`);
    push('  To drop them, set hiddenTools in cordis.patch.yml to the names you accept losing.');
  }
  if (hidden.length === 0) {
    push('  hiddenTools is empty, so the catalogue is untouched.');
  } else {
    push(`  hiddenTools ${hidden.join(', ')} -> removes ${hiddenTokens} tokens from every request`);
  }
  push('');
  push(`Verdict: ${reduction.toFixed(2)}% prompt-token reduction against a ${options.target}% target -> ${report.targets.met ? 'MET' : 'NOT MET'}`);
  push('Basis: the fixed-density estimate for the system prompt, every surface message, and the');
  push('tool-schema envelope, summed over each recorded model request. Character budgets');
  push('approximate tokens; provider-reported usage stays authoritative for billing.');

  if (options.json !== undefined) {
    writeFileSync(options.json, `${JSON.stringify({
      ...report,
      tools: Object.fromEntries(report.tools),
      schemas: Object.fromEntries(report.schemas),
    }, null, 2)}\n`);
    push(`Full report written to ${options.json}`);
  }

  if (!options.quiet) {
    process.stdout.write(`${out.slice(0, options.maxLines).join('\n')}\n`);
    if (out.length > options.maxLines) {
      process.stdout.write(`... ${out.length - options.maxLines} more line(s) suppressed (--max-lines ${options.maxLines}; --json for everything)\n`);
    }
  }
  return report.targets.met ? 0 : 2;
}

// Only act as a CLI when this file is the entry point: importing it as a
// library must never parse the importer's argv.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`token-frugal: ${String(error.message)}\n\n${USAGE}`);
    process.exit(1);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  try {
    process.exit(main(options));
  } catch (error) {
    process.stderr.write(`token-frugal: ${String(error.message)}\n`);
    process.exit(1);
  }
}

export { readPatchConfig, resolvePolicy, applyPolicy, recoveryHint, decodeLog, decodeLogBuffer, findLogs, parseArgs };
