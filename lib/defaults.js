/**
 * The shipped default policy, as plain JSON.
 *
 * Both halves of the deliverable read this one object: `index.js` seeds its
 * Cordis `Config` schema from it, and `tools/measure-tokens.mjs` prices a
 * replay with it. Keeping one source of truth is what makes the reported
 * numbers describe the policy that actually mounts.
 *
 * @module dsh-token-frugal/defaults
 */

/**
 * Tool names whose output is mostly formatting, so it gets a tighter budget.
 * These are the values measured to clear the 40% prompt-reduction target with
 * margin on the recorded corpus; `README.md` lists the looser and more
 * aggressive profiles side by side.
 */
export const DEFAULT_TOOL_BUDGETS = Object.freeze({
  read: 3000,
  web_fetch: 4000,
  web_search: 3000,
  pwsh: 1200,
  bash: 1200,
  grep: 1500,
  glob: 1500,
  cordis_inspect_query: 2000,
  cordis_inspect_list: 2000,
  plugin_manager: 2000,
});

/** Every lossless transform, enabled. */
export const DEFAULT_TRANSFORMS = Object.freeze({
  terminal: true,
  blankSpace: true,
  columns: true,
  repeatedLines: true,
  numericRuns: true,
  json: true,
});

/** The complete default row configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  defaultMaxChars: 1500,
  toolBudgets: DEFAULT_TOOL_BUDGETS,
  errorBudgetFactor: 2,
  skipTools: Object.freeze([]),
  minBlockChars: 320,
  minGainRatio: 0.02,
  transforms: DEFAULT_TRANSFORMS,
  columnMinSpaces: 3,
  repeatedMinRun: 3,
  numericMinRun: 6,
  headRatio: 0.45,
  tailRatio: 0.35,
  structureAware: true,
  recovery: 'spill',
  readSourceRecovery: true,
  logStatsEvery: 25,
  hiddenTools: Object.freeze([]),
});
