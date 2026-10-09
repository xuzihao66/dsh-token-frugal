/**
 * The per-workspace memory document.
 *
 * One markdown file per workspace, one `## session` section per conversation,
 * one `### ` block per recorded item. It exists so a later turn (or a later
 * conversation in the same workspace) can recall what was already said without
 * re-reading the parts of the transcript that answer the question — the thing
 * that actually costs input tokens in a long session.
 *
 * Everything here is pure string work: no model call, no I/O, no Cordis. The
 * `user` blocks keep the user's own wording verbatim, because a future query
 * resembles a past input far more closely than it resembles a summary of one.
 *
 * @module dsh-token-frugal/memo
 */

/** Heading of the document as a whole. */
export const MEMO_TITLE = '# dsh-token-frugal session memory';

/** Marker line before each block's body, read back by {@link parseMemo}. */
const BLOCK_HEADING = /^### (.+)$/;

/** Lines that usually carry a conclusion rather than an intermediate step. */
const SIGNAL = /(\b(done|added|fixed|removed|renamed|created|updated|changed|implemented|verified|result|summary|conclusion|TODO|note)\b|完成|已|结论|总结|因此|所以|新增|修复|删除|验证|注意|待办)/i;

/** Fence opener/closer, so a summary never quotes a wall of code. */
const FENCE = /^\s*(```|~~~)/;

/** Collapse runs of whitespace and clamp one line. */
function cleanLine(line, limit) {
  const text = line.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Extract a short, bounded digest of one assistant reply.
 *
 * Deliberately extractive: it picks lines that already read like conclusions
 * and falls back to the opening sentence, so recording a turn costs no model
 * tokens at all.
 *
 * @param text - the assistant's text for the turn, already concatenated.
 * @param options - `maxPoints` and `maxChars` bound the result.
 * @returns the digest lines, without their leading markers.
 */
export function extractPoints(text, options = {}) {
  const maxPoints = options.maxPoints ?? 5;
  const maxChars = options.maxChars ?? 480;
  const lineLimit = options.lineLimit ?? 220;
  if (typeof text !== 'string' || text.trim() === '') return [];

  const lines = text.split('\n');
  const points = [];
  let inFence = false;
  for (const raw of lines) {
    if (FENCE.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const line = cleanLine(raw, lineLimit);
    if (line === '' || line.startsWith('|')) continue;
    // Bullets and numbered items are already the author's own key points.
    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const body = cleanLine(bullet[1], lineLimit);
      if (body !== '' && body.length > 3) points.push(body);
      continue;
    }
    if (SIGNAL.test(line) && line.length > 8) points.push(line.replace(/^#+\s*/, ''));
  }

  // Nothing looked like a conclusion: keep the opening sentence, which almost
  // always states what the turn was about.
  if (points.length === 0) {
    const flat = text.replace(/\s+/g, ' ').trim();
    const sentence = /^(.{20,400}?[.。!?！？])(\s|$)/.exec(flat);
    points.push(sentence === null ? cleanLine(flat, lineLimit) : cleanLine(sentence[1], lineLimit));
  }

  const seen = new Set();
  const out = [];
  let used = 0;
  for (const point of points) {
    const key = point.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (used + point.length + 3 > maxChars) break;
    out.push(point);
    used += point.length + 3;
    if (out.length >= maxPoints) break;
  }
  return out;
}

/** `2026-10-08 06:11 UTC`, stable and sortable in the file. */
export function stamp(time = Date.now()) {
  const iso = new Date(time).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The `## session` heading for one conversation.
 * @param sessionId - the session id.
 * @param cwd - the workspace the session runs in, or undefined.
 * @param time - creation time.
 * @returns the heading line.
 */
export function sessionHeading(sessionId, cwd, time = Date.now()) {
  const where = cwd === undefined ? '' : ` · ${cwd}`;
  return `## ${sessionId} — ${stamp(time)}${where}`;
}

/**
 * A verbatim user-input block.
 * @param text - the user's message text.
 * @param options - `time` and `maxChars`.
 * @returns the block, or an empty string when there is nothing to record.
 */
export function userBlock(text, options = {}) {
  const body = String(text ?? '').trim();
  if (body === '') return '';
  const maxChars = options.maxChars ?? 2000;
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (truncated in memory; the full text stays in the session log)` : body;
  return `### user · ${stamp(options.time)}\n\n${clipped}\n`;
}

/**
 * A digest block for one completed turn.
 * @param lines - the digest lines from {@link extractPoints}.
 * @param options - `turn` and `time`.
 * @returns the block, or an empty string when there is nothing worth keeping.
 */
export function summaryBlock(lines, options = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const turn = options.turn === undefined ? '' : ` turn ${options.turn}`;
  const body = lines.map((line) => `- ${line}`).join('\n');
  return `### summary${turn} · ${stamp(options.time)}\n\n${body}\n`;
}

/**
 * Append a block to the document, creating the title when the file is new.
 * @param markdown - the current document, or an empty string.
 * @param block - the block to append.
 * @returns the next document; unchanged when the block is empty.
 */
export function appendBlock(markdown, block) {
  if (typeof block !== 'string' || block.trim() === '') return markdown;
  const head = markdown === undefined || markdown.trim() === ''
    ? `${MEMO_TITLE}\n\n`
    : `${markdown.replace(/\s*$/, '')}\n\n`;
  return `${head}${block.trim()}\n`;
}

/**
 * Split a document into its scorable blocks.
 *
 * Each block carries the `## session` heading it belongs to, so an excerpt can
 * be attributed without guessing.
 *
 * @param markdown - the document text.
 * @returns blocks in file order.
 */
export function parseMemo(markdown) {
  const blocks = [];
  if (typeof markdown !== 'string') return blocks;
  let session = '';
  let current = null;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      // Close the pending block before switching sections: dropping it here
      // would silently lose the last entry of every session but the final one.
      if (current !== null) blocks.push(current);
      current = null;
      // Attribute by the session id alone: the timestamp and workspace that
      // follow it in the heading are noise inside an injected excerpt.
      session = line.slice(3).split(' — ')[0].trim();
      continue;
    }
    const heading = BLOCK_HEADING.exec(line);
    if (heading !== null) {
      if (current !== null) blocks.push(current);
      current = { session, heading: heading[1].trim(), lines: [] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (current !== null) blocks.push(current);
  return blocks.map((block) => ({
    session: block.session,
    heading: block.heading,
    // `user` blocks are verbatim and must keep their paragraph breaks; other
    // blocks are digests and read fine collapsed.
    text: block.heading.startsWith('user')
      ? block.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      : block.lines.join('\n').replace(/\s+/g, ' ').trim(),
    kind: block.heading.startsWith('user') ? 'user' : 'summary',
  })).filter((block) => block.text !== '');
}

/**
 * Render one block back to markdown, for quoting into context.
 * @param block - a block from {@link parseMemo}.
 * @returns the markdown lines.
 */
export function renderBlock(block) {
  const where = block.session === '' ? '' : ` (${block.session})`;
  return `**${block.heading}**${where}\n${block.text}`;
}
