/**
 * Small subsequence-based fuzzy matcher.
 *
 * Inspired by VS Code / fzf's scoring model — no external dep. The shape we
 * need: given a query and a haystack, return (score, positions[]). Higher
 * score = better. positions[] is the haystack indices the query matched, so
 * the UI can render bold highlights.
 *
 * Scoring intuition:
 *  - +10 per matched char
 *  - +20 if it's the first char of a word (after space/_/-/./:/)
 *  - +5  for each consecutive run (after the first match)
 *  - +30 if the very first match is at index 0 (true prefix)
 *  - -1  per gap char (penalize sparse matches)
 *  - 1.5x multiplier when the query is a contiguous substring (the common case)
 *
 * Case-insensitive. Returns null when the query doesn't appear as a subsequence.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices in the (original) haystack where query chars matched. */
  positions: number[];
}

const WORD_BREAK = /[\s_\-./:]/;

export function fuzzyMatch(haystack: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();

  // Fast-path: contiguous substring match wins big.
  const idx = h.indexOf(q);
  if (idx >= 0) {
    const positions: number[] = [];
    for (let i = 0; i < q.length; i++) positions.push(idx + i);
    let score = 10 * q.length + 5 * (q.length - 1); // dense run bonus
    if (idx === 0) score += 30;
    if (idx > 0 && WORD_BREAK.test(h[idx - 1])) score += 20;
    return { score: Math.round(score * 1.5), positions };
  }

  // General subsequence match. Word-start bonus is granted only once (for
  // the first matched char) so a sparse but-word-aligned match like
  // "Can Our Notes Nag" can never out-score a true contiguous substring,
  // which always gets the 1.5x multiplier.
  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let lastMatchAt = -2;
  let wordStartCredited = false;
  for (let hi = 0; hi < h.length && qi < q.length; hi++) {
    if (h[hi] === q[qi]) {
      positions.push(hi);
      score += 10;
      if (hi === 0 && qi === 0) score += 30;
      if (!wordStartCredited && hi > 0 && WORD_BREAK.test(h[hi - 1])) {
        score += 20;
        wordStartCredited = true;
      }
      if (hi === lastMatchAt + 1) score += 5;
      lastMatchAt = hi;
      qi++;
    } else {
      score -= 1;
    }
  }
  if (qi < q.length) return null;
  return { score, positions };
}

/** Render helper: splits a string into matched / unmatched runs for highlighting. */
export interface Segment { text: string; matched: boolean }
export function highlightSegments(haystack: string, positions: number[]): Segment[] {
  if (!positions.length) return [{ text: haystack, matched: false }];
  const out: Segment[] = [];
  const set = new Set(positions);
  let buf = "";
  let bufMatched = false;
  for (let i = 0; i < haystack.length; i++) {
    const m = set.has(i);
    if (i === 0) { buf = haystack[i]; bufMatched = m; continue; }
    if (m === bufMatched) buf += haystack[i];
    else {
      out.push({ text: buf, matched: bufMatched });
      buf = haystack[i];
      bufMatched = m;
    }
  }
  if (buf) out.push({ text: buf, matched: bufMatched });
  return out;
}
