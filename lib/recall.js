/**
 * Matching a new user message against the workspace memory document.
 *
 * The point is to answer "have we already established this?" from a file that
 * costs a few hundred tokens, instead of from the transcript, which costs
 * thousands. Scoring is deliberately small and deterministic: term frequency
 * weighted by inverse document frequency across the document's own blocks, with
 * a boost for the user's verbatim wording, which is the closest thing to a
 * future query that exists.
 *
 * No model call, no embeddings, no network.
 *
 * @module dsh-token-frugal/recall
 */

/** Latin words that carry no retrieval signal. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were', 'are', 'is', 'be', 'been',
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'as', 'it', 'its', 'if', 'then', 'than', 'so', 'but',
  'not', 'no', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'just', 'also', 'into', 'out',
  'up', 'down', 'over', 'under', 'you', 'your', 'i', 'me', 'my', 'we', 'our', 'they', 'them', 'he', 'she',
  '请', '帮', '我', '你', '的', '了', '是', '在', '和', '与', '就', '都', '也', '还', '这', '那', '一个',
]);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const LATIN = /[a-z0-9_][a-z0-9_.-]*/g;

/**
 * Turn text into retrieval terms.
 *
 * Latin words are lowercased and stop-worded. CJK has no reliable spaces, so a
 * run of CJK characters contributes its adjacent bigrams — cheap, and good
 * enough that a repeated phrase matches — plus the single characters when the
 * run is short.
 *
 * @param text - the text to tokenize.
 * @returns the distinct terms.
 */
export function terms(text) {
  const out = new Set();
  const input = String(text ?? '').toLowerCase();

  for (const match of input.matchAll(LATIN)) {
    const word = match[0];
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    out.add(word);
  }

  // Walk CJK runs and emit bigrams.
  let run = '';
  const flush = () => {
    if (run.length === 1) { if (!STOPWORDS.has(run)) out.add(run); }
    else {
      for (let i = 0; i + 1 < run.length; i++) {
        const bigram = run.slice(i, i + 2);
        if (!STOPWORDS.has(bigram)) out.add(bigram);
      }
    }
    run = '';
  };
  for (const char of input) {
    if (CJK.test(char)) run += char;
    else flush();
  }
  flush();

  return [...out];
}

/** Term counts for one block, used for both scoring and length damping. */
function termCounts(block) {
  const counts = new Map();
  for (const term of terms(`${block.heading} ${block.text}`)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/**
 * Rank blocks against a query.
 * @param blocks - blocks from `parseMemo`.
 * @param query - the new text to match, typically the user's message.
 * @returns per-block scores with the terms that matched, best first.
 */
export function rank(blocks, query) {
  const queryTerms = terms(query);
  if (queryTerms.length === 0 || blocks.length === 0) return [];

  const counts = blocks.map(termCounts);
  const documentFrequency = new Map();
  for (const term of queryTerms) {
    let df = 0;
    for (const blockCounts of counts) if (blockCounts.has(term)) df += 1;
    documentFrequency.set(term, df);
  }

  const scored = [];
  for (const [index, block] of blocks.entries()) {
    const blockCounts = counts[index];
    const headingTerms = new Set(terms(block.heading));
    let score = 0;
    const matched = [];
    for (const term of queryTerms) {
      const frequency = blockCounts.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 1;
      // A term in every block says nothing; a rare one says a lot.
      const idf = Math.log(1 + blocks.length / df);
      const weight = (headingTerms.has(term) ? 2 : 1)
        * (block.kind === 'user' ? 1.6 : 1)
        * (1 + Math.log(frequency));
      score += idf * weight;
      matched.push(term);
    }
    if (score <= 0) continue;
    // Long blocks must earn their place rather than win on sheer size.
    const damped = score / (1 + Math.log(1 + block.text.length / 240));
    scored.push({ index, score: damped, rawScore: score, matchedTerms: matched, block });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored;
}

/**
 * Choose the excerpts worth injecting, within a character budget.
 *
 * Whole blocks are preferred. A single block larger than the entire budget is
 * trimmed to fit with an explicit marker, so the model always knows text was
 * cut rather than silently receiving a partial statement.
 *
 * @param blocks - blocks from `parseMemo`.
 * @param query - the new text to match.
 * @param options - `maxChars`, `maxBlocks`, `minScore`, `minMatchedTerms`.
 * @returns the chosen extracts, their total size, and the matched terms.
 */
export function selectExcerpts(blocks, query, options = {}) {
  const maxChars = options.maxChars ?? 1200;
  const maxBlocks = options.maxBlocks ?? 4;
  const minScore = options.minScore ?? 0.8;
  const minMatchedTerms = options.minMatchedTerms ?? 2;

  const ranked = rank(blocks, query).filter((entry) => entry.score >= minScore);
  const matchedTerms = new Set();
  for (const entry of ranked) for (const term of entry.matchedTerms) matchedTerms.add(term);
  // One shared word is a coincidence; injection needs corroboration.
  if (matchedTerms.size < minMatchedTerms) {
    return { excerpts: [], chars: 0, matchedTerms: [...matchedTerms], considered: ranked.length, skipped: 'too-few-terms' };
  }

  const excerpts = [];
  let used = 0;
  for (const entry of ranked.slice(0, maxBlocks)) {
    const text = entry.block.text;
    const room = maxChars - used;
    if (room <= 120) break;
    if (text.length <= room) {
      excerpts.push({ ...entry.block, score: entry.score, matchedTerms: entry.matchedTerms, trimmed: false });
      used += text.length;
      continue;
    }
    excerpts.push({
      ...entry.block,
      text: (() => {
        // The marker is part of the budget: slicing at `room - 60` and then
        // appending a longer marker would overshoot the cap it exists to hold.
        const marker = '\n… (excerpt trimmed by dsh-token-frugal; the rest is in the memory file)';
        const keep = Math.max(0, room - marker.length);
        return `${text.slice(0, keep)}${marker}`;
      })(),
      score: entry.score,
      matchedTerms: entry.matchedTerms,
      trimmed: true,
    });
    used = maxChars;
    break;
  }
  return {
    excerpts,
    chars: excerpts.reduce((total, excerpt) => total + excerpt.text.length, 0),
    matchedTerms: [...matchedTerms],
    considered: ranked.length,
    skipped: excerpts.length === 0 ? 'no-room' : undefined,
  };
}

/**
 * The injected message body: the recalled excerpts plus the instruction that
 * makes them worth their tokens.
 * @param selection - the result of {@link selectExcerpts}.
 * @param memoPath - the memory file the excerpts came from.
 * @returns the text to inject, or an empty string when nothing matched.
 */
export function renderRecall(selection, memoPath) {
  if (selection.excerpts.length === 0) return '';
  const body = selection.excerpts
    .map((excerpt) => {
      const where = excerpt.session === '' ? '' : ` · ${excerpt.session}`;
      return `**${excerpt.heading}**${where}\n${excerpt.text}`;
    })
    .join('\n\n');
  return [
    `<recalled-context source="${memoPath}">`,
    'Matches from this workspace\'s session memory, recorded from earlier turns and',
    'earlier conversations here. Prefer these over re-reading the transcript or',
    're-deriving what was already established. They are extracts, not the full record;',
    `read ${memoPath} when you need more.`,
    '',
    body,
    '</recalled-context>',
  ].join('\n');
}
