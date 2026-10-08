/**
 * Deterministic, structure-aware compression for tool-result text.
 *
 * Every transform here is computed locally from the text itself: no model
 * call, no network, no clock, no randomness. Each one either drops bytes that
 * carry no information (terminal control sequences, column padding, blank
 * runs, repeated lines, JSON indentation) or replaces a run of lines with an
 * explicit marker that states what was removed (`xN`, `a -> b step s`,
 * `N lines elided`) so the elision stays auditable and, for the arithmetic
 * case, exactly reversible.
 *
 * The library is deliberately free of Cordis and Harness imports so it can be
 * unit-tested and benchmarked offline.
 *
 * @module dsh-token-frugal/compress
 */

// ---------------------------------------------------------------------------
// terminal noise
// ---------------------------------------------------------------------------

/** CSI, OSC, and single-character escape sequences emitted by terminals. */
const ANSI_ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
/** Remaining C0/C1 controls with no text meaning (`\n` and `\t` survive). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Remove terminal control sequences and collapse carriage-return overwrites to
 * the final visible segment, which is what a terminal would have shown.
 * @param text - raw tool output.
 * @returns text with no escape sequences and no bare carriage returns.
 */
export function stripTerminalNoise(text) {
  const withoutEscapes = text.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '');
  if (!withoutEscapes.includes('\r')) return withoutEscapes;
  // A CRLF is a line break; a bare CR repaints the line from column 0.
  const normalized = withoutEscapes.replace(/\r\n/g, '\n');
  if (!normalized.includes('\r')) return normalized;
  return normalized
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      for (let i = segments.length - 1; i >= 0; i--) if (segments[i] !== '') return segments[i];
      return '';
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// whitespace
// ---------------------------------------------------------------------------

/**
 * Drop trailing blanks per line and collapse blank-line runs.
 * @param text - input text.
 * @param options - `maxBlankLines` is the largest run kept (default 1).
 * @returns normalized text, or the input when nothing changed.
 */
export function normalizeBlankSpace(text, options = {}) {
  const maxBlankLines = options.maxBlankLines ?? 1;
  const lines = text.split('\n');
  let changed = false;
  const trimmed = lines.map((line) => {
    const next = line.replace(/[ \t]+$/, '');
    if (next !== line) changed = true;
    return next;
  });
  const out = [];
  let blanks = 0;
  for (const line of trimmed) {
    if (line === '') {
      blanks += 1;
      if (blanks > maxBlankLines) { changed = true; continue; }
    } else blanks = 0;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
    changed = true;
  }
  return changed ? out.join('\n') : text;
}

/**
 * Collapse runs of alignment padding inside a line to one space, preserving
 * leading indentation. Terminal tables and `Format-Table` output are mostly
 * padding; indentation is structural and is never touched.
 * @param text - input text.
 * @param options - `minSpaces` is the smallest collapsible run (default 3).
 * @returns text with collapsed inter-column runs.
 */
export function collapseColumnPadding(text, options = {}) {
  const minSpaces = options.minSpaces ?? 3;
  const run = new RegExp(`[ \\t]{${minSpaces},}`, 'g');
  return text
    .split('\n')
    .map((line) => {
      const lead = /^[ \t]*/.exec(line)[0];
      const rest = line.slice(lead.length);
      if (!run.test(rest)) return line;
      run.lastIndex = 0;
      return lead + rest.replace(run, ' ');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// repeated lines
// ---------------------------------------------------------------------------

/**
 * Fold runs of byte-identical consecutive lines into one line plus an `xN`
 * marker. The marker carries the count, so no information is lost.
 * @param text - input text.
 * @param options - `minRun` is the smallest folded run (default 3).
 * @returns text with folded runs, or the input when nothing was worth folding.
 */
export function foldRepeatedLines(text, options = {}) {
  const minRun = options.minRun ?? 3;
  const lines = text.split('\n');
  const out = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j += 1;
    const run = j - i;
    if (run >= minRun && line !== '') {
      // Compare trimmed lengths: the marker is indented to the line's own level
      // so a folded nested block still reads as part of its parent.
      const indent = /^[ \t]*/.exec(line)[0];
      const marker = `${indent}... (x${run} identical)`;
      if (line.length * (run - 1) > marker.length) {
        out.push(line, marker);
        changed = true;
        i = j;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return changed ? out.join('\n') : text;
}

/** Split a line into its non-numeric skeleton and the integers it carries. */
function numericShape(line) {
  const numbers = [];
  let index = 0;
  let skeleton = '';
  const re = /\d+/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    skeleton += line.slice(index, match.index) + '\u0000';
    numbers.push(Number(match[0]));
    index = match.index + match[0].length;
  }
  skeleton += line.slice(index);
  return { skeleton, numbers };
}

/**
 * Fold an arithmetic progression of lines — build counters, timestamps,
 * progress ticks — into its two endpoints plus an explicit
 * `first -> last step s` marker. Because the run is verified to be an
 * arithmetic progression over an identical skeleton, the marker plus the
 * endpoints reconstruct every folded line exactly.
 * @param text - input text.
 * @param options - `minRun` is the smallest folded run (default 6).
 * @returns text with folded progressions, or the input when none qualified.
 */
export function foldNumericRuns(text, options = {}) {
  const minRun = options.minRun ?? 6;
  const lines = text.split('\n');
  const shapes = lines.map(numericShape);
  const out = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const base = shapes[i];
    if (base.numbers.length === 0 || lines[i] === '') { out.push(lines[i]); i += 1; continue; }
    // Grow a run while exactly one integer moves by one constant step.
    let j = i + 1;
    let slot = -1;
    let step = 0;
    while (j < lines.length) {
      const next = shapes[j];
      if (next.numbers.length !== base.numbers.length || next.skeleton !== base.skeleton) break;
      let differing = -1;
      for (let k = 0; k < next.numbers.length; k++) {
        if (next.numbers[k] !== shapes[j - 1].numbers[k]) {
          if (differing !== -1) { differing = -1; break; }
          differing = k;
        }
      }
      if (differing === -1) break;
      const delta = next.numbers[differing] - shapes[j - 1].numbers[differing];
      if (slot === -1) { slot = differing; step = delta; }
      else if (differing !== slot || delta !== step) break;
      if (step === 0) break;
      j += 1;
    }
    const run = j - i;
    if (run >= minRun) {
      const first = shapes[i].numbers[slot];
      const last = shapes[j - 1].numbers[slot];
      const indent = /^[ \t]*/.exec(lines[i])[0];
      const marker = `${indent}... (${first} -> ${last} step ${step}; ${run - 2} line(s) folded)`;
      out.push(lines[i], marker, lines[j - 1]);
      changed = true;
      i = j;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return changed ? out.join('\n') : text;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Re-encode a homogeneous array of flat objects as a labelled table.
 * Only used when every row has the same keys and only scalar values, so the
 * table is a lossless re-encoding rather than a summary.
 * @param value - the parsed JSON value.
 * @param options - `tabularMinRows` and `tabularMaxColumns` bound the shape.
 * @returns the table text, or `undefined` when the value does not qualify.
 */
function tryTabular(value, options) {
  const minRows = options.tabularMinRows ?? 8;
  const maxColumns = options.tabularMaxColumns ?? 16;
  if (!Array.isArray(value) || value.length < minRows) return undefined;
  const first = value[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return undefined;
  const keys = Object.keys(first);
  if (keys.length < 2 || keys.length > maxColumns) return undefined;
  const cell = (input) => {
    if (input === null) return 'null';
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (typeof input === 'string') return /[\t\n]/.test(input) ? JSON.stringify(input) : input;
    return undefined;
  };
  const rows = [];
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined;
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== keys.length) return undefined;
    const cells = [];
    for (const key of keys) {
      if (!Object.hasOwn(row, key)) return undefined;
      const text = cell(row[key]);
      if (text === undefined) return undefined;
      cells.push(text);
    }
    rows.push(cells.join('\t'));
  }
  return [
    `[${value.length} rows, ${keys.length} columns: ${keys.join(', ')}]`,
    keys.join('\t'),
    ...rows,
  ].join('\n');
}

/**
 * Minify a JSON payload, or re-encode a homogeneous flat array as a table.
 * Non-JSON text, truncated JSON, and payloads that do not get smaller are
 * returned unchanged.
 * @param text - input text.
 * @param options - tabular qualification bounds.
 * @returns the compressed JSON text, or `undefined` when nothing applies.
 */
export function compressJson(text, options = {}) {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return undefined;
  let value;
  try { value = JSON.parse(trimmed); } catch { return undefined; }
  if (typeof value !== 'object' || value === null) return undefined;

  if (options.tabular !== false) {
    const table = tryTabular(value, options);
    if (table !== undefined && table.length < trimmed.length) return table;
  }
  const compact = JSON.stringify(value);
  return compact.length < trimmed.length ? compact : undefined;
}

// ---------------------------------------------------------------------------
// budgeted head/tail elision
// ---------------------------------------------------------------------------

/** Lines that carry the outcome of a run rather than its bulk. */
const SIGNAL_LINE = /(^|\s)(error|errors|err|warn|warning|fail|failed|failure|fatal|panic|exception|traceback|refused|denied|timeout|timed out|cannot|unable|undefined|null pointer|conflict|deprecated|ERROR|FAIL|WARN)(\s|:|$)/;

/**
 * Select the signal lines from a middle segment within a character budget,
 * preserving their original order.
 * @param lines - candidate middle lines.
 * @param budget - maximum characters of selected lines.
 * @returns selected lines.
 */
function selectSignalLines(lines, budget) {
  const selected = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) continue;
    if (!SIGNAL_LINE.test(line)) continue;
    selected.push(line);
    used += line.length + 1;
  }
  return selected;
}

/**
 * Bound text to `maxChars` by keeping a structured head and tail and stating
 * exactly what was dropped. Unlike a blind character slice, an over-budget
 * middle is first scanned for error-bearing lines, which are retained.
 * @param text - text already past the lossless transforms.
 * @param options - budget, head/tail split, and signal retention limits.
 * @returns the bounded text, or `undefined` when it already fits.
 */
export function elideToBudget(text, options) {
  const maxChars = options.maxChars;
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) return undefined;
  if (text.length <= maxChars) return undefined;
  const headRatio = options.headRatio ?? 0.45;
  const tailRatio = options.tailRatio ?? 0.35;
  const keepSignal = options.structureAware !== false;
  const lines = text.split('\n');
  const headBudget = Math.floor(maxChars * headRatio);
  const tailBudget = Math.floor(maxChars * tailRatio);

  const head = [];
  let used = 0;
  let headEnd = 0;
  while (headEnd < lines.length) {
    const cost = lines[headEnd].length + 1;
    if (used + cost > headBudget) break;
    head.push(lines[headEnd]);
    used += cost;
    headEnd += 1;
  }
  const tail = [];
  let tailUsed = 0;
  let tailStart = lines.length;
  while (tailStart > headEnd) {
    const cost = lines[tailStart - 1].length + 1;
    if (tailUsed + cost > tailBudget) break;
    tailStart -= 1;
    tail.push(lines[tailStart]);
    tailUsed += cost;
  }
  tail.reverse();
  const middle = lines.slice(headEnd, tailStart);
  const elidedLines = lines.length - head.length - tail.length;
  if (elidedLines <= 0) return undefined;

  const elidedChars = text.length - (head.join('\n').length + tail.join('\n').length);
  const rawHint = typeof options.recoveryHint === 'string' ? options.recoveryHint.trim() : '';
  const hint = rawHint === '' ? '' : ` ${rawHint}`;
  const marker = `... [${elidedLines} line(s), ${elidedChars} char(s) elided by dsh-token-frugal.${hint}] ...`;

  const budgetLeft = maxChars - (head.join('\n').length + tail.join('\n').length + marker.length + 4);
  const signal = keepSignal && budgetLeft > 0 ? selectSignalLines(middle, Math.floor(budgetLeft)) : [];
  const parts = [...head, marker];
  if (signal.length > 0) parts.push('... [retained middle lines matching error/warning patterns] ...', ...signal);
  parts.push(...tail);
  const out = parts.join('\n');
  if (out.length >= text.length) return undefined;
  // A pathological line layout can still exceed the budget; a hard slice keeps
  // the bound absolute but is only reached once structure was already tried.
  return out.length <= maxChars
    ? out
    : `${out.slice(0, maxChars - 20)}\n... [truncated to budget] ...`;
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

/** Per-transform switches, all enabled by default. */
export const DEFAULT_TRANSFORMS = Object.freeze({
  terminal: true,
  blankSpace: true,
  columns: true,
  repeatedLines: true,
  numericRuns: true,
  json: true,
});

/**
 * Run every enabled transform once over one text block.
 * @param text - raw tool-result text.
 * @param options - transform switches and their bounds; `maxChars` bounds the
 *   final size and `structureAware` keeps error lines from an elided middle.
 * @returns the compressed text, or the input when the result did not shrink.
 */
export function compressText(text, options = {}) {
  if (typeof text !== 'string' || text === '') return text;
  const on = { ...DEFAULT_TRANSFORMS, ...(options.transforms ?? {}) };
  const minBlockChars = options.minBlockChars ?? 320;
  const minGainRatio = options.minGainRatio ?? 0.02;
  if (text.length < minBlockChars && (options.maxChars ?? Infinity) >= text.length) return text;

  let out = text;
  if (on.terminal) out = stripTerminalNoise(out);
  if (on.json) out = compressJson(out, options) ?? out;
  if (on.blankSpace) out = normalizeBlankSpace(out, { maxBlankLines: options.maxBlankLines ?? 1 });
  if (on.columns) out = collapseColumnPadding(out, { minSpaces: options.columnMinSpaces ?? 3 });
  if (on.repeatedLines) out = foldRepeatedLines(out, { minRun: options.repeatedMinRun ?? 3 });
  if (on.numericRuns) out = foldNumericRuns(out, { minRun: options.numericMinRun ?? 6 });
  const bounded = elideToBudget(out, {
    maxChars: options.maxChars,
    headRatio: options.headRatio,
    tailRatio: options.tailRatio,
    structureAware: options.structureAware,
    recoveryHint: options.recoveryHint,
  });
  if (bounded !== undefined) out = bounded;

  if (out.length >= text.length) return text;
  if ((text.length - out.length) / text.length < minGainRatio) return text;
  return out;
}

/**
 * Compress every text block of one content array, leaving rich blocks
 * (`image`, `file`, and any future block type) untouched and in order.
 * @param blocks - the tool result's content blocks.
 * @param options - see {@link compressText}.
 * @returns the next content array and the measured effect.
 */
export function compressContent(blocks, options = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  let before = 0;
  let after = 0;
  let changed = false;
  const next = list.map((block) => {
    if (block?.type !== 'text') return block;
    before += block.text.length;
    const compressed = compressText(block.text, options);
    after += compressed.length;
    if (compressed !== block.text) changed = true;
    return compressed === block.text ? block : { type: 'text', text: compressed };
  });
  return { blocks: changed ? next : list, changed, before, after };
}

/**
 * Bound a whole content array to a character budget while keeping its block
 * structure: each text block receives an equal share, and a block already
 * smaller than its share is kept whole. Splitting one budget across blocks
 * instead of concatenating them is what stops an elision from moving text
 * across an image.
 * @param blocks - content blocks, already passed through the lossless pass.
 * @param budget - total character budget for all text blocks.
 * @param options - see {@link compressText}.
 * @returns the next content array and the measured effect.
 */
export function compressContentToBudget(blocks, budget, options = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const textBlocks = list.filter((block) => block?.type === 'text').length;
  if (textBlocks === 0 || !Number.isSafeInteger(budget) || budget <= 0) {
    return { blocks: list, changed: false, before: 0, after: 0 };
  }
  const share = Math.max(1, Math.floor(budget / textBlocks));
  return compressContent(list, { ...options, maxChars: share });
}
