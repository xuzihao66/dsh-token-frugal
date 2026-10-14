/**
 * The elision-depth tiers behind the panel's 高等 grade.
 *
 * One number — the character budget a tool result is cut down to — dominates
 * everything else this plugin can do. A tool result is re-sent on every later
 * model request in its session, so a character removed at the source keeps
 * being worth that character for the rest of the session.
 *
 * `tools/measure-tokens.mjs` measures each tier over the same frozen corpus
 * (1946 requests across the 13 replayed sessions, 3.49M tool-result
 * characters, baseline 482,206,961 prompt tokens). The share below is the share
 * of *billed* prompt tokens, with a cache miss priced at ten times a cache read
 * — the ratio the provider publishes. A share that counts raw tokens
 * overstates every tier: a rewrite that lands in old history invalidates the
 * provider's cached prefix from that position on, and pays for it again.
 *
 * standard 47.2% of tool-result characters removed        21.8% of the bill
 * deep     63.8%                                          29.5%
 * extreme  78.8%                                          32.1%
 *
 * The deeper tiers also carry an aging rule: once a result has fallen out of
 * the newest `keepFull`, only a `lateLimit`-character digest of it is re-sent,
 * carrying the same recovery hint as an arrival-time elision. Fresh results are
 * the ones a model still reasons from, so this spends the budget where it is
 * worth least — and because a digest lands near the tail, the cache break it
 * causes is a short one.
 *
 *   deep    newest 2 results whole, older ones 300 chars  27.15% -> 29.5%
 *   extreme newest 1 result whole, older ones 200 chars   31.55% -> 32.1%
 *
 * Measured, not chosen. The re-prefill cost is the whole story: with `keepFull`
 * at three or more each digest's cache break costs more than the digest saves,
 * and a rule that cuts old results to 100 characters is a net loss, because a
 * budget below the marker's own size cannot carry the pointer back and so
 * refuses to elide at all (the first cut at this feature, newest 3 whole plus
 * 600-char digests, priced at 25.5% — worse than no aging). `--aging-keep` and
 * `--aging-limit` re-run the search.
 *
 * Two things this measurement does not price: the model re-running a tool
 * because a digest was too thin, and the value of context it no longer has. The
 * digest names the way back, and `standard` keeps every result whole, which is
 * why the deeper tiers are a choice rather than a default.
 *
 * A tier only moves the budget table. It never changes which transforms run,
 * and it never makes `elide` cut something it cannot hand back: an unrecoverable
 * result stays whole no matter how deep the tier is (see `recoveryHint` in
 * `index.js`).
 *
 * @module dsh-token-frugal/depths
 */

/** The tier a profile starts on: exactly the budgets shipped in `defaults.js`. */
export const DEFAULT_ELISION_DEPTH = 'standard';

/**
 * The tiers, in panel order, with the numbers `README.md` quotes.
 *
 * `defaultMaxChars: undefined` on the standard tier means "keep whatever the
 * row configured", so an existing profile is untouched until the user picks a
 * deeper tier. The deeper tiers override it deliberately: a tier is a statement
 * about how far to cut, not about which default a profile happens to carry.
 * Their `budgets` merge over the configured table, so a tool a tier does not
 * name keeps its own budget.
 */
export const ELISION_DEPTHS = Object.freeze([
  Object.freeze({
    id: 'standard',
    defaultMaxChars: undefined,
    budgets: Object.freeze({}),
    promptReductionPercent: 21.8,
  }),
  Object.freeze({
    id: 'deep',
    aging: Object.freeze({ keepFull: 2, lateLimit: 300 }),
    defaultMaxChars: 1000,
    budgets: Object.freeze({
      read: 1500, web_fetch: 2000, web_search: 1500,
      pwsh: 800, bash: 800, grep: 800, glob: 800,
    }),
    promptReductionPercent: 29.5,
  }),
  Object.freeze({
    id: 'extreme',
    aging: Object.freeze({ keepFull: 1, lateLimit: 200 }),
    defaultMaxChars: 500,
    budgets: Object.freeze({
      read: 800, web_fetch: 1000, web_search: 800,
      pwsh: 400, bash: 400, grep: 400, glob: 400,
    }),
    promptReductionPercent: 32.1,
  }),
]);

/** Every known tier id, for the bridge and the state file. */
export const ELISION_DEPTH_IDS = Object.freeze(ELISION_DEPTHS.map((depth) => depth.id));

/**
 * The tier for an id, falling back to the default for anything unknown.
 * @param id - a tier id, possibly unset or read from an older state file.
 * @returns the tier.
 */
export function depthFor(id) {
  return ELISION_DEPTHS.find((depth) => depth.id === id) ?? ELISION_DEPTHS[0];
}

/**
 * Accept an untrusted tier id, and nothing else.
 * @param value - a value from the panel, the state file, or a patch.
 * @returns the id when it names a tier, otherwise undefined.
 */
export function sanitizeDepth(value) {
  return typeof value === 'string' && ELISION_DEPTH_IDS.includes(value) ? value : undefined;
}

/**
 * Apply a tier to a resolved config, leaving the config itself untouched.
 * @param id - the tier id; an unknown id means the default tier.
 * @param resolved - the resolved row configuration.
 * @returns the tier id and the budget table to enforce.
 */
export function applyDepth(id, resolved) {
  const depth = depthFor(id);
  const budgets = new Map(resolved.budgets);
  for (const [tool, chars] of Object.entries(depth.budgets)) budgets.set(tool, chars);
  return {
    depth: depth.id,
    aging: depth.aging,
    defaultMaxChars: depth.defaultMaxChars ?? resolved.defaultMaxChars,
    budgets,
  };
}
