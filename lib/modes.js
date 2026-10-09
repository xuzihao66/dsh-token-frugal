/**
 * The saving-mode registry behind the composer panel.
 *
 * A "mode" is one saving the user can turn on or off by hand. The patch's
 * `config` seeds the initial state, the panel overrides it at runtime, and the
 * choice is persisted next to the profile so it survives a restart without ever
 * rewriting the user's `cordis.patch.yml`.
 *
 * @module dsh-token-frugal/modes
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Every mode the panel can offer, in display order. */
export const MODE_IDS = Object.freeze([
  'terminal',
  'columns',
  'repeatedLines',
  'numericRuns',
  'json',
  'elide',
  'catalogue',
  'memo',
  'recall',
]);

/** The modes that are lossless by construction. */
export const LOSSLESS_MODES = Object.freeze(['terminal', 'columns', 'repeatedLines', 'numericRuns', 'json']);

/** State-file schema version; a mismatch discards the file rather than guessing. */
export const STATE_VERSION = 1;

/** Name of the state file inside the profile (or DSH home) directory. */
export const STATE_FILE = 'dsh-token-frugal.state.json';

/**
 * The initial mode state implied by a patch config.
 *
 * The v1 keys stay authoritative for their own mode, so an existing profile
 * keeps behaving exactly as before until the user touches the panel.
 *
 * @param config - the resolved plugin config.
 * @returns one boolean per mode id.
 */
export function resolveModes(config) {
  const transforms = config.transforms ?? {};
  const declared = config.modes ?? {};
  const initial = {
    terminal: transforms.terminal !== false,
    columns: transforms.columns !== false,
    repeatedLines: transforms.repeatedLines !== false,
    numericRuns: transforms.numericRuns !== false,
    json: transforms.json !== false,
    elide: config.recovery !== 'none',
    catalogue: Array.isArray(config.hiddenTools) && config.hiddenTools.length > 0,
    memo: config.memo?.enabled !== false,
    recall: config.recall?.enabled !== false,
  };
  const modes = {};
  for (const id of MODE_IDS) {
    modes[id] = typeof declared[id] === 'boolean' ? declared[id] : initial[id];
  }
  return modes;
}

/** Whether a mode does anything at all under this config. */
export function modeAvailable(id, config) {
  if (id === 'catalogue') return Array.isArray(config.hiddenTools) && config.hiddenTools.length > 0;
  return true;
}

/**
 * Fold a mode state into the option table the compressor consumes.
 * @param modes - the current mode state.
 * @returns the transforms map, the recovery choice, and the feature switches.
 */
export function effectivePolicy(modes) {
  return {
    transforms: {
      terminal: modes.terminal !== false,
      blankSpace: true,
      columns: modes.columns !== false,
      repeatedLines: modes.repeatedLines !== false,
      numericRuns: modes.numericRuns !== false,
      json: modes.json !== false,
    },
    recovery: modes.elide === false ? 'none' : 'spill',
    memo: modes.memo !== false,
    recall: modes.recall !== false,
    catalogue: modes.catalogue !== false,
  };
}

/**
 * Normalize an untrusted mode patch from the panel or the state file.
 * @param input - a partial mode map.
 * @returns the accepted booleans only.
 */
export function sanitizeModePatch(input) {
  const out = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!MODE_IDS.includes(key)) continue;
    if (typeof value !== 'boolean') continue;
    out[key] = value;
  }
  return out;
}

/** The directory that owns the state file, or undefined when there is none. */
export function stateDirectory(env = process.env) {
  const fromProfile = env.DSH_PROFILE_DIR;
  if (typeof fromProfile === 'string' && fromProfile !== '') return fromProfile;
  const home = env.DSH_HOME;
  if (typeof home === 'string' && home !== '') return join(home, 'profiles', env.DSH_PROFILE ?? 'default');
  return undefined;
}

/**
 * Read the persisted mode state.
 *
 * A missing, unreadable, or version-mismatched file yields nothing rather than
 * a guess, so a corrupt file cannot silently change the policy.
 *
 * @param dir - the directory holding the state file.
 * @returns the persisted mode patch, or undefined.
 */
export function readState(dir) {
  if (dir === undefined) return undefined;
  const path = join(dir, STATE_FILE);
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== STATE_VERSION) return undefined;
    const modes = sanitizeModePatch(parsed.modes);
    return Object.keys(modes).length === 0 ? undefined : modes;
  } catch {
    return undefined;
  }
}

/**
 * Persist the mode state.
 *
 * Written through a temporary file and renamed, so an interrupted write cannot
 * leave a half file that the next start reads as a policy change.
 *
 * @param dir - the directory holding the state file.
 * @param modes - the complete mode state.
 * @returns the path written, or undefined when persistence is unavailable.
 */
export function writeState(dir, modes) {
  if (dir === undefined) return undefined;
  const path = join(dir, STATE_FILE);
  const payload = `${JSON.stringify({ version: STATE_VERSION, modes: sanitizeModePatch(modes) }, null, 2)}\n`;
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, payload);
  renameSync(temporary, path);
  return path;
}
