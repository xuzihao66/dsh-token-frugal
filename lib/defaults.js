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

/** The per-workspace memory document. */
export const DEFAULT_MEMO = Object.freeze({
  enabled: true,
  /** Relative to the session's workspace, so the record travels with the work. */
  path: '.dsh-token-frugal/memory.md',
  /** Longest user message stored verbatim; the session log keeps the whole one. */
  maxEntryChars: 2000,
});

/** Automatic matching of a new user message against the memory document. */
export const DEFAULT_RECALL = Object.freeze({
  enabled: true,
  /** Character budget for one injected recall block. */
  maxChars: 1200,
  maxBlocks: 4,
  minScore: 0.8,
  /** Distinct matched terms needed before an injection is worth its tokens. */
  minMatchedTerms: 2,
});

/** The path the composer panel uses to read and change the mode state. */
export const DEFAULT_BRIDGE = Object.freeze({
  path: '/dsh-token-frugal/modes',
});

/**
 * Initial saving-mode state. A key here overrides the value the v1 config keys
 * imply, so a profile can pin a mode from the patch as well as from the panel.
 */
export const DEFAULT_MODES = Object.freeze({});

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
  modes: DEFAULT_MODES,
  memo: DEFAULT_MEMO,
  recall: DEFAULT_RECALL,
  bridge: DEFAULT_BRIDGE,
});
