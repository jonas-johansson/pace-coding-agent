/**
 * Lightweight fuzzy subsequence matcher used by interactive pickers.
 *
 * A query matches a candidate when its characters appear in the candidate in
 * order (case-insensitive). The returned score rewards consecutive runs,
 * matches at word boundaries, and matches near the start of the candidate so
 * that the most relevant results can be sorted to the top.
 */

export type FuzzyMatch = {
  /** Higher is a better match. */
  score: number;
  /** Indices in the candidate string that matched, in ascending order. */
  positions: number[];
};

const BOUNDARY_CHARS = new Set(["/", "-", ".", "_", " ", ":"]);

/**
 * Returns match details if every character of `query` appears in `text` in
 * order, otherwise `undefined`. An empty query matches everything with a
 * neutral score so callers can preserve the original ordering.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  if (query.length === 0) {
    return { score: 0, positions: [] };
  }

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];

  let score = 0;
  let queryIndex = 0;
  let previousMatch = -2;
  let streak = 0;

  for (let textIndex = 0; textIndex < t.length && queryIndex < q.length; textIndex++) {
    if (t[textIndex] !== q[queryIndex]) {
      continue;
    }

    positions.push(textIndex);

    // Reward consecutive matches with a growing streak bonus.
    if (textIndex === previousMatch + 1) {
      streak += 1;
      score += 5 + streak * 2;
    } else {
      streak = 0;
      score += 1;
    }

    // Reward matches that begin a new "word" (after a separator or at start).
    const previousChar = textIndex > 0 ? t[textIndex - 1] : "/";
    if (BOUNDARY_CHARS.has(previousChar)) {
      score += 8;
    }

    // Reward matches near the front of the candidate.
    score += Math.max(0, 6 - textIndex);

    previousMatch = textIndex;
    queryIndex += 1;
  }

  if (queryIndex < q.length) {
    return undefined;
  }

  return { score, positions };
}
