/**
 * What the plugin saved, in characters and in priced tokens.
 *
 * One record per scope: `session` counts this process's work, `cumulative`
 * counts every process and is persisted beside the mode state. Both are the
 * same shape, so the settings page renders them with one code path.
 *
 * The record is deliberately additive and self-sanitizing: a stat is written on
 * the hot path of every tool result, so nothing here may throw, and a corrupted
 * file must read back as zeroes rather than as a guess.
 *
 * @module dsh-token-frugal/stats
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHARS_PER_TOKEN } from './estimate.js';

/** Record schema version; a mismatch discards the file rather than guessing. */
export const STATS_VERSION = 1;

/** Name of the statistics file inside the profile (or DSH home) directory. */
export const STATS_FILE = 'dsh-token-frugal.stats.json';

/** Distinct tool names kept in one record; the rest fold into `unknown`. */
const MAX_TOOLS = 64;

/** Coerce one stored counter into a usable non-negative safe integer. */
function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A zeroed record: the shape every other function in this module expects. */
export function emptyStats() {
  return {
    calls: 0,
    rewritten: 0,
    elided: 0,
    aged: 0,
    before: 0,
    after: 0,
    spillFailures: 0,
    recallInjections: 0,
    recallChars: 0,
    catalogueTools: 0,
    catalogueTokens: 0,
    tools: {},
  };
}

/** The per-tool cell for a name, created on first use and bounded in number. */
function toolCell(stats, tool) {
  const key = typeof tool === 'string' && tool !== '' ? tool : 'unknown';
  const existing = stats.tools[key];
  if (existing !== undefined) return existing;
  // Past the cap every new name shares one cell, so a pathological tool set
  // cannot grow the persisted file without bound.
  const target = Object.keys(stats.tools).length >= MAX_TOOLS ? 'unknown' : key;
  const cell = stats.tools[target] ?? { calls: 0, rewritten: 0, before: 0, after: 0 };
  stats.tools[target] = cell;
  return cell;
}

/** Count one accepted tool result that the compressor looked at. */
export function recordCall(stats, tool) {
  stats.calls += 1;
  toolCell(stats, tool).calls += 1;
}

/** Fold one rewritten result into the record. */
export function recordRewrite(stats, tool, before, after, elided) {
  stats.rewritten += 1;
  if (elided) stats.elided += 1;
  stats.before += count(before);
  stats.after += count(after);
  const cell = toolCell(stats, tool);
  cell.rewritten += 1;
  cell.before += count(before);
  cell.after += count(after);
}

/**
 * Fold one result an older turn had to trade its body for a digest.
 *
 * Like {@link recordRewrite} it moves the saved-character totals, and unlike
 * it the result was already counted as a call: nothing new arrived, an old
 * node only became smaller for every request still to come.
 */
export function recordAged(stats, tool, before, after) {
  stats.aged += 1;
  stats.before += count(before);
  stats.after += count(after);
  const cell = toolCell(stats, tool);
  cell.before += count(before);
  cell.after += count(after);
}

/** Count one recall injection and the characters it appended. */
export function recordRecall(stats, chars) {
  stats.recallInjections += 1;
  stats.recallChars += count(chars);
}

/**
 * Record the catalogue saving measured when a restriction is applied.
 *
 * This is a per-request figure, not a total: the hidden schemas are removed
 * from every request the agent makes while the restriction is in place.
 */
export function recordCatalogue(stats, tools, tokens) {
  stats.catalogueTools = count(tools);
  stats.catalogueTokens = count(tokens);
}

/** Count one failed spill; the result then stays lossless-only. */
export function recordSpillFailure(stats) {
  stats.spillFailures += 1;
}

/** Characters the compressor removed. */
export function savedChars(stats) {
  return Math.max(0, stats.before - stats.after);
}

/** The same saving priced with the heuristic the Harness shows in context usage. */
export function savedTokens(stats) {
  return Math.round(savedChars(stats) / CHARS_PER_TOKEN);
}

/** The fraction of inspected characters that was removed, in [0, 1]. */
export function savedRatio(stats) {
  if (stats.before <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - stats.after / stats.before));
}

/** A flat, JSON-safe summary of one record. */
export function summarizeStats(stats) {
  return {
    calls: stats.calls,
    rewritten: stats.rewritten,
    elided: stats.elided,
    aged: stats.aged,
    before: stats.before,
    after: stats.after,
    savedChars: savedChars(stats),
    savedTokens: savedTokens(stats),
    savedRatio: savedRatio(stats),
    spillFailures: stats.spillFailures,
    recallInjections: stats.recallInjections,
    recallChars: stats.recallChars,
    catalogueTools: stats.catalogueTools,
    catalogueTokens: stats.catalogueTokens,
  };
}

/** Per-tool rows, biggest saving first, bounded for the wire. */
export function toolRows(stats, limit = 24) {
  return Object.entries(stats.tools)
    .map(([tool, cell]) => ({
      tool,
      calls: cell.calls,
      rewritten: cell.rewritten,
      before: cell.before,
      after: cell.after,
      savedChars: Math.max(0, cell.before - cell.after),
      savedTokens: Math.round(Math.max(0, cell.before - cell.after) / CHARS_PER_TOKEN),
      savedRatio: cell.before > 0 ? Math.max(0, Math.min(1, 1 - cell.after / cell.before)) : 0,
    }))
    .sort((left, right) => right.savedChars - left.savedChars || right.calls - left.calls)
    .slice(0, limit);
}

/** Coerce an untrusted value into a complete record. */
export function sanitizeStats(input) {
  const source = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
  const stats = emptyStats();
  for (const key of ['calls', 'rewritten', 'elided', 'aged', 'before', 'after', 'spillFailures',
    'recallInjections', 'recallChars', 'catalogueTools', 'catalogueTokens']) {
    stats[key] = count(source[key]);
  }
  const tools = typeof source.tools === 'object' && source.tools !== null && !Array.isArray(source.tools)
    ? source.tools
    : {};
  for (const [name, value] of Object.entries(tools).slice(0, MAX_TOOLS)) {
    const cell = value !== null && typeof value === 'object' ? value : {};
    stats.tools[name] = {
      calls: count(cell.calls),
      rewritten: count(cell.rewritten),
      before: count(cell.before),
      after: count(cell.after),
    };
  }
  return stats;
}

/** The statistics file's path, or undefined when there is no profile directory. */
export function statsFilePath(dir) {
  return dir === undefined ? undefined : join(dir, STATS_FILE);
}

/**
 * Read the persisted record.
 *
 * A missing, unreadable, or version-mismatched file reads as zeroes: losing the
 * history is acceptable, inventing one is not.
 *
 * @param dir - the directory holding the statistics file.
 * @returns a complete record.
 */
export function readStats(dir) {
  const path = statsFilePath(dir);
  if (path === undefined) return emptyStats();
  try {
    if (!existsSync(path)) return emptyStats();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== STATS_VERSION) return emptyStats();
    return sanitizeStats(parsed.stats);
  } catch {
    return emptyStats();
  }
}

/**
 * Persist the record through a temporary file and a rename, so an interrupted
 * write cannot leave a half file behind. A failure returns undefined instead of
 * throwing: this runs on the tool-result path, where a statistics fault must
 * never turn a successful tool call into an error.
 *
 * @param dir - the directory holding the statistics file.
 * @param stats - the complete record.
 * @returns the path written, or undefined when it could not be written.
 */
export function writeStats(dir, stats) {
  const path = statsFilePath(dir);
  if (path === undefined) return undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload = `${JSON.stringify({ version: STATS_VERSION, stats: sanitizeStats(stats) }, null, 2)}\n`;
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, payload);
    renameSync(temporary, path);
    return path;
  } catch {
    return undefined;
  }
}
