/** F-0012: literal find/replace over active subtitle text. No user input is treated as a regex. */

export interface FindableChunk {
  id: string;
  text: string;
  deleted?: boolean;
  isBlankSpacer?: boolean;
}

export interface FindMatch {
  chunkId: string;
  start: number;
  end: number;
  text: string;
}

export interface TextUpdate {
  id: string;
  text: string;
}

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds every literal occurrence in each non-deleted subtitle sentence.
 * Matches never cross sentence boundaries; indices are UTF-16 code units, matching textarea selection.
 */
export function findMatches(
  chunks: readonly FindableChunk[],
  query: string,
  matchCase = false,
): FindMatch[] {
  if (!query) return [];
  const expression = new RegExp(escapeRegExp(query), matchCase ? 'g' : 'gi');
  const matches: FindMatch[] = [];
  for (const chunk of chunks) {
    if (chunk.deleted || chunk.isBlankSpacer) continue;
    expression.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = expression.exec(chunk.text))) {
      matches.push({ chunkId: chunk.id, start: found.index, end: found.index + found[0].length, text: found[0] });
      if (found[0].length === 0) expression.lastIndex += 1;
    }
  }
  return matches;
}

/** Replaces one match. Invalid or stale ranges return the original text. */
export function replaceMatch(text: string, match: Pick<FindMatch, 'start' | 'end'>, replacement: string): string {
  if (match.start < 0 || match.end < match.start || match.end > text.length) return text;
  return text.slice(0, match.start) + replacement + text.slice(match.end);
}

/**
 * Applies all matches, right-to-left per sentence so earlier indices remain valid.
 * Returns one update per affected sentence; unchanged sentences are omitted.
 */
export function replaceAllMatches(
  chunks: readonly FindableChunk[],
  matches: readonly FindMatch[],
  replacement: string,
): TextUpdate[] {
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
  const grouped = new Map<string, FindMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.chunkId) ?? [];
    list.push(match);
    grouped.set(match.chunkId, list);
  }
  const updates: TextUpdate[] = [];
  for (const [id, list] of grouped) {
    const chunk = byId.get(id);
    if (!chunk || chunk.deleted || chunk.isBlankSpacer) continue;
    let text = chunk.text;
    for (const match of [...list].sort((a, b) => b.start - a.start)) {
      text = replaceMatch(text, match, replacement);
    }
    if (text !== chunk.text) updates.push({ id, text });
  }
  return updates;
}

/** A cheap stale check: only the sentences a preview would touch. */
export function baseForMatches(chunks: readonly FindableChunk[], matches: readonly FindMatch[]): string {
  const ids = new Set(matches.map(match => match.chunkId));
  return JSON.stringify(chunks.filter(chunk => ids.has(chunk.id)).map(chunk => [chunk.id, chunk.text]));
}
