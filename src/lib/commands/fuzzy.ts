// Small subsequence fuzzy scorer for the command palette (#13).
// No external dependency; good enough for a handful of commands.

export interface FuzzyMatch {
  score: number;
  matchIndices: number[];
}

/**
 * Score `target` against `query` using subsequence matching.
 * Returns null when every query char cannot be found in order.
 * Higher score = better match. Consecutive matches and word-start
 * hits are weighted up.
 */
export function fuzzyMatch(target: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, matchIndices: [] };
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  const indices: number[] = [];
  let ti = 0;
  let score = 0;
  let prevIdx = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q.charAt(qi);
    let found = -1;
    while (ti < t.length) {
      if (t.charAt(ti) === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    indices.push(found);
    // Consecutive bonus.
    if (found === prevIdx + 1) score += 5;
    // Word-start bonus (start of string or after space/punct).
    if (found === 0 || /[\s\-_/]/.test(t.charAt(found - 1))) score += 3;
    score += 1;
    prevIdx = found;
    ti = found + 1;
  }
  // Shorter targets score a little higher when matches are otherwise equal.
  score -= t.length * 0.01;
  return { score, matchIndices: indices };
}
