/**
 * The fixed-density token heuristic, mirrored from
 * `@deepseek-ai/dsh-token-meter/estimate` so an offline report prices content
 * with the same numbers the Harness shows in `contextBreakdown`.
 *
 * Kept dependency-free on purpose: the plugin must not import a Harness
 * package (profiles resolve those from the dsh installation, and an offline
 * script may run without one).
 *
 * @module dsh-token-frugal/estimate
 */

/** Fixed text-density estimate used until exact tokenization is needed. */
export const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags. */
export const BLOCK_OVERHEAD = 4;
/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4;

/** Price one model-visible message under the fixed heuristic. */
export function estimateMessage(message) {
  if (message === undefined || message === null) return 0;
  const content = message.content;
  if (!Array.isArray(content)) return 0;
  if (message.role === 'system') {
    if (content.length === 0) return 0;
    let characters = 0;
    for (const block of content) {
      characters += block?.type === 'text' ? block.text.length : JSON.stringify(block).length;
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
  }
  return estimateContent(content) + ROLE_OVERHEAD;
}

/** Price content blocks recursively under the fixed-density heuristic. */
export function estimateContent(blocks) {
  let tokens = 0;
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
        break;
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD;
        break;
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
    }
  }
  return tokens;
}

/** Price the tool-schema part of a canonical request envelope. */
export function estimateToolsTokens(schemas) {
  if (schemas === undefined || schemas === null || schemas.length === 0) return 0;
  return Math.ceil(JSON.stringify(schemas).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

/** Sum the text characters a content array carries. */
export function contentChars(blocks) {
  let characters = 0;
  for (const block of blocks ?? []) {
    if (block?.type === 'text') characters += block.text.length;
  }
  return characters;
}
