// F-0025: keyword emphasis data model, offset reconciliation, batching, and AI recommendation contract.
import { z } from 'zod';

export const KEYWORD_PROMPT_VERSION = 'f0025-v1';
export const MAX_KEYWORDS_PER_CUE = 8;

export const subtitleKeywordSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  source: z.enum(['manual', 'ai']).optional(),
}).refine(kw => kw.end > kw.start, 'Keyword range must be non-empty');

export type SubtitleKeyword = z.infer<typeof subtitleKeywordSchema>;

/** Sort non-overlapping keywords and discard any whose substring no longer matches `text`. */
export function reconcileChunkKeywords(
  keywords: readonly SubtitleKeyword[] | undefined,
  text: string,
): SubtitleKeyword[] | undefined {
  if (!keywords?.length || !text) return undefined;
  const valid = keywords
    .filter(kw =>
      Number.isInteger(kw.start) && Number.isInteger(kw.end)
      && kw.start >= 0 && kw.end <= text.length && kw.end > kw.start
      && text.slice(kw.start, kw.end) === kw.text,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!valid.length) return undefined;
  const deduped: SubtitleKeyword[] = [];
  let lastEnd = 0;
  for (const kw of valid) {
    if (kw.start < lastEnd) continue;
    deduped.push({ start: kw.start, end: kw.end, text: kw.text, ...(kw.source ? { source: kw.source } : {}) });
    lastEnd = kw.end;
  }
  return deduped.length ? deduped : undefined;
}

/** Trim outer whitespace on a user selection and toggle/replace overlapping keywords cleanly. */
export function toggleChunkKeyword(
  keywords: readonly SubtitleKeyword[] | undefined,
  text: string,
  rawStart: number,
  rawEnd: number,
  source: 'manual' | 'ai' = 'manual',
): SubtitleKeyword[] | undefined {
  let start = Math.max(0, Math.min(rawStart, rawEnd));
  let end = Math.min(text.length, Math.max(rawStart, rawEnd));
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  if (end <= start) return reconcileChunkKeywords(keywords, text);

  const current = reconcileChunkKeywords(keywords, text) ?? [];
  const exactIndex = current.findIndex(kw => kw.start === start && kw.end === end);
  if (exactIndex >= 0) {
    const next = current.filter((_, index) => index !== exactIndex);
    return next.length ? next : undefined;
  }
  const nonOverlapping = current.filter(kw => kw.end <= start || kw.start >= end);
  const next = [...nonOverlapping, { start, end, text: text.slice(start, end), source }]
    .sort((a, b) => a.start - b.start);
  return next.length ? next : undefined;
}

export function addChunkKeyword(
  keywords: readonly SubtitleKeyword[] | undefined,
  text: string,
  rawStart: number,
  rawEnd: number,
  source: 'manual' | 'ai' = 'manual',
): SubtitleKeyword[] | undefined {
  let start = Math.max(0, Math.min(rawStart, rawEnd));
  let end = Math.min(text.length, Math.max(rawStart, rawEnd));
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  if (end <= start) return reconcileChunkKeywords(keywords, text);

  const current = reconcileChunkKeywords(keywords, text) ?? [];
  if (current.some(kw => kw.start === start && kw.end === end)) return current;
  const nonOverlapping = current.filter(kw => kw.end <= start || kw.start >= end);
  const next = [...nonOverlapping, { start, end, text: text.slice(start, end), source }]
    .sort((a, b) => a.start - b.start);
  return next.length ? next : undefined;
}

export function removeChunkKeyword(
  keywords: readonly SubtitleKeyword[] | undefined,
  text: string,
  start: number,
  end: number,
): SubtitleKeyword[] | undefined {
  const current = reconcileChunkKeywords(keywords, text);
  if (!current) return undefined;
  const next = current.filter(kw => !(kw.start === start && kw.end === end));
  return next.length ? next : undefined;
}

export interface KeywordToken {
  text: string;
  start: number;
  end: number;
  selectable: boolean;
}

/** Break a subtitle line into clickable word/phrase segments for 1-click keyword marking. */
export function tokenizeSubtitleForKeywords(text: string): KeywordToken[] {
  if (!text) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const tokens: KeywordToken[] = [];
  for (const seg of segmenter.segment(text)) {
    const tokenText = seg.segment;
    const start = seg.index;
    const end = start + tokenText.length;
    const selectable = Boolean(tokenText.trim()) && !/^[\p{P}\s]+$/u.test(tokenText);
    tokens.push({ text: tokenText, start, end, selectable });
  }
  return tokens;
}

// ---------- AI Keyword Recommendation Contract ----------

export const keywordSuggestItemSchema = z.strictObject({
  id: z.string().min(1).max(300),
  text: z.string().min(1).max(20000),
});
export type KeywordSuggestItem = z.infer<typeof keywordSuggestItemSchema>;

export const keywordSuggestRequestSchema = z.strictObject({
  base: z.string().min(1).max(256),
  language: z.string().max(64).optional(),
  items: z.array(keywordSuggestItemSchema).min(1).max(100),
});
export type KeywordSuggestRequest = z.infer<typeof keywordSuggestRequestSchema>;

export const keywordSuggestInputSchema = z.strictObject({
  configId: z.uuid(),
  request: keywordSuggestRequestSchema,
});
export type KeywordSuggestInput = z.infer<typeof keywordSuggestInputSchema>;

export interface KeywordSuggestionItemResult {
  id: string;
  keywords: SubtitleKeyword[];
}

export interface KeywordSuggestResult {
  version: 1;
  base: string;
  promptVersion: string;
  items: KeywordSuggestionItemResult[];
}

export type KeywordContractErrorCode =
  | 'INVALID_RESPONSE'
  | 'STALE_BASE'
  | 'UNKNOWN_ID'
  | 'DUPLICATE_ID'
  | 'INVALID_KEYWORDS'
  | 'SUBSTRING_NOT_FOUND'
  | 'TOO_MANY_KEYWORDS';

export class KeywordContractError extends Error {
  readonly code: KeywordContractErrorCode;
  constructor(code: KeywordContractErrorCode, message: string) {
    super(message);
    this.name = 'KeywordContractError';
    this.code = code;
  }
}

export function splitKeywordBatches(
  items: readonly KeywordSuggestItem[],
  maxItems = 25,
  maxChars = 2400,
): KeywordSuggestItem[][] {
  if (!items.length) return [];
  const batches: KeywordSuggestItem[][] = [];
  let current: KeywordSuggestItem[] = [];
  let chars = 0;
  for (const item of items) {
    const nextChars = chars + item.text.length;
    if (current.length && (current.length >= maxItems || nextChars > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Deterministic base fingerprint covering active subtitles' id and exact text. */
export function createKeywordBase(items: readonly { id: string; text: string }[]): string {
  const payload = JSON.stringify(items.map(item => [item.id, item.text]));
  let h1 = 2166136261;
  let h2 = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    const code = payload.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619);
    h2 = Math.imul(h2 ^ (code + i), 16777619);
  }
  return `kw-${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}-${items.length}`;
}

function findNonOverlappingOccurrence(
  source: string,
  needle: string,
  occupied: Array<{ start: number; end: number }>,
): { start: number; end: number } | null {
  let from = 0;
  while (from <= source.length - needle.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) return null;
    const end = index + needle.length;
    const overlaps = occupied.some(range => !(end <= range.start || index >= range.end));
    if (!overlaps) return { start: index, end };
    from = index + 1;
  }
  return null;
}

/**
 * Validate AI keyword recommendation output against the exact sent request.
 * The model returns exact substrings; this validator grounds them to non-overlapping character ranges.
 */
export function validateKeywordModelResponse(
  parsed: unknown,
  request: KeywordSuggestRequest,
): KeywordSuggestionItemResult[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KeywordContractError('INVALID_RESPONSE', 'AI keyword response must be a JSON object');
  }
  const obj = parsed as { version?: unknown; base?: unknown; items?: unknown };
  if (obj.version !== 1 || typeof obj.base !== 'string' || !Array.isArray(obj.items)) {
    throw new KeywordContractError('INVALID_RESPONSE', 'AI keyword response is missing required fields');
  }
  if (obj.base !== request.base) {
    throw new KeywordContractError('STALE_BASE', 'AI keyword response base does not match the current text');
  }

  const byId = new Map(request.items.map(item => [item.id, item]));
  const seen = new Set<string>();
  const results: KeywordSuggestionItemResult[] = [];

  for (const entry of obj.items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new KeywordContractError('INVALID_RESPONSE', 'AI keyword item must be an object');
    }
    const raw = entry as { id?: unknown; keywords?: unknown };
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id || !byId.has(id)) {
      throw new KeywordContractError('UNKNOWN_ID', `Unknown subtitle id in AI keyword response: ${id || '(empty)'}`);
    }
    if (seen.has(id)) {
      throw new KeywordContractError('DUPLICATE_ID', `Duplicate subtitle id in AI keyword response: ${id}`);
    }
    seen.add(id);

    if (!Array.isArray(raw.keywords)) {
      throw new KeywordContractError('INVALID_KEYWORDS', `Keywords must be an array for subtitle ${id}`);
    }
    if (raw.keywords.length > MAX_KEYWORDS_PER_CUE) {
      throw new KeywordContractError('TOO_MANY_KEYWORDS', `Too many keywords for subtitle ${id}`);
    }

    const sourceText = byId.get(id)!.text;
    const occupied: Array<{ start: number; end: number }> = [];
    const mapped: SubtitleKeyword[] = [];

    for (const kwRaw of raw.keywords) {
      if (typeof kwRaw !== 'string' || !kwRaw.trim()) {
        throw new KeywordContractError('INVALID_KEYWORDS', `Invalid empty keyword for subtitle ${id}`);
      }
      const trimmed = kwRaw.trim();
      const match = findNonOverlappingOccurrence(sourceText, trimmed, occupied);
      if (!match) {
        throw new KeywordContractError(
          'SUBSTRING_NOT_FOUND',
          `Recommended keyword "${trimmed}" does not match subtitle ${id}`,
        );
      }
      occupied.push(match);
      mapped.push({ start: match.start, end: match.end, text: trimmed, source: 'ai' });
    }

    mapped.sort((a, b) => a.start - b.start);
    if (mapped.length) {
      results.push({ id, keywords: mapped });
    }
  }

  return results;
}
