// F-0020: suggest subtitle sentence splits on existing word boundaries. Pure data in, suggestions out;
// no model, no RPC and no timing is invented for words that do not have timestamps.
import { joinWordTexts } from '../text/joinWords.ts';

export const MIN_SPLIT_CHARS = 8;
export const MAX_SPLIT_CHARS = 60;
export const DEFAULT_SPLIT_CHARS = 20;
const DEFAULT_PAUSE_SEC = 0.35;
const MIN_PIECE_CHARS = 3;
const EPSILON = 0.02;
const STRONG_ENDERS = ['。', '！', '？', '!', '?', '…', '；', ';'];
const SOFT_ENDERS = ['，', ',', '、', '：', ':'];

export interface SplitSourceChunk {
  id: string;
  text: string;
  timestamp: [number, number];
  deleted?: boolean;
  wordIds?: string[];
  secondText?: string;
  keywords?: readonly unknown[];
  isBlankSpacer?: boolean;
}

export interface SplitSourceWord {
  id: string;
  text: string;
  timestamp: [number, number];
  deleted?: boolean;
}

export interface SplitPiece {
  text: string;
  timestamp: [number, number];
  wordIds: string[];
  forced: boolean;
  limited: boolean;
}

export interface SplitSuggestion {
  chunkId: string;
  before: string;
  pieces: SplitPiece[];
  reason: 'length' | 'punctuation';
}

export interface SplitSkipped {
  noWords: number;
  mismatch: number;
  translated: number;
  keyworded: number;
  dubbed: number;
  short: number;
}

export interface SplitAnalysis {
  maxChars: number;
  base: string;
  suggestions: SplitSuggestion[];
  skipped: SplitSkipped;
  overLimit: number;
}

export interface SplitOptions {
  maxChars?: number;
  pauseThresholdSec?: number;
  translatedChunkIds?: ReadonlySet<string>;
  dubbingChunkIds?: ReadonlySet<string>;
}

export interface SplitPlanPiece {
  text: string;
  timestamp: [number, number];
  wordIds: string[];
}

export interface SplitPlan {
  chunkId: string;
  pieces: SplitPlanPiece[];
}

export type SplitPlanError = 'empty' | 'unknown' | 'deleted' | 'protected' | 'invalid-pieces' | 'invalid-time' | 'word-mismatch';

export const normalizeMaxChars = (value: number | undefined) => {
  const next = Number.isFinite(value) ? Math.round(value as number) : DEFAULT_SPLIT_CHARS;
  return Math.min(MAX_SPLIT_CHARS, Math.max(MIN_SPLIT_CHARS, next));
};

/** Analysis is only valid while the exact subtitle and word snapshot it was computed from is still current. */
export const splitBase = (chunks: readonly unknown[], wordChunks: readonly unknown[]) => JSON.stringify([chunks, wordChunks]);
export const isSplitBaseCurrent = (base: string, chunks: readonly unknown[], wordChunks: readonly unknown[]) =>
  splitBase(chunks, wordChunks) === base;

/** Visible characters: whitespace is not displayed and must not influence the line limit. */
export const countChars = (text: string) => Array.from(text.replace(/\s+/gu, '')).length;

/** Compare text and words without whitespace; punctuation still has to match so splits never drop it. */
const sameVisibleText = (left: string, right: string) => left.replace(/\s+/gu, '') === right.replace(/\s+/gu, '');

const endsWithAny = (text: string, enders: readonly string[]) => {
  const trimmed = text.trimEnd();
  return enders.some(ender => trimmed.endsWith(ender));
};

const validSpan = (value: [number, number] | undefined): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'number' && Number.isFinite(item))
  && value[0] >= 0 && value[1] > value[0];

function buildPieces(words: SplitSourceWord[], groups: SplitSourceWord[][], forced: boolean[], maxChars: number): SplitPiece[] {
  return groups.map((group, index) => {
    const text = joinWordTexts(group.map(word => word.text));
    return {
      text,
      timestamp: [group[0].timestamp[0], group[group.length - 1].timestamp[1]],
      wordIds: group.map(word => word.id),
      forced: forced[index] ?? false,
      limited: countChars(text) > maxChars + 2,
    };
  });
}

function validatePieces(chunk: SplitSourceChunk, pieces: SplitPiece[], words: SplitSourceWord[]): boolean {
  if (pieces.length < 2) return false;
  if (!sameVisibleText(pieces.map(piece => piece.text).join(''), chunk.text)) return false;
  const byId = new Map(words.map(word => [word.id, word]));
  const covered: string[] = [];
  let previousStart = -Infinity;
  for (const piece of pieces) {
    if (!piece.text.trim() || !validSpan(piece.timestamp)) return false;
    if (piece.timestamp[0] < chunk.timestamp[0] - EPSILON || piece.timestamp[1] > chunk.timestamp[1] + EPSILON) return false;
    if (piece.timestamp[0] < previousStart - EPSILON) return false;
    previousStart = piece.timestamp[0];
    for (const id of piece.wordIds) {
      const word = byId.get(id);
      if (!word || !validSpan(word.timestamp)) return false;
      if (word.timestamp[0] < piece.timestamp[0] - EPSILON || word.timestamp[1] > piece.timestamp[1] + EPSILON) return false;
      covered.push(id);
    }
  }
  const expected = chunk.wordIds ?? [];
  if (covered.length !== expected.length) return false;
  return expected.every((id, index) => covered[index] === id);
}

function splitChunk(chunk: SplitSourceChunk, words: SplitSourceWord[], maxChars: number, pauseSec: number): SplitSuggestion | null {
  const groups: SplitSourceWord[][] = [];
  const forced: boolean[] = [];
  let current: SplitSourceWord[] = [];
  let currentChars = 0;
  const flush = (isForced: boolean) => {
    if (!current.length) return;
    groups.push(current);
    forced.push(isForced);
    current = [];
    currentChars = 0;
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    current.push(word);
    currentChars += countChars(word.text);
    const next = words[index + 1];
    if (!next) { flush(false); break; }
    if (currentChars >= maxChars || (currentChars + countChars(next.text) > maxChars && currentChars >= MIN_PIECE_CHARS)) {
      flush(true); continue;
    }
    if (endsWithAny(word.text, STRONG_ENDERS)) { flush(false); continue; }
    if (endsWithAny(word.text, SOFT_ENDERS) && currentChars >= Math.max(4, Math.ceil(maxChars / 2))) { flush(false); continue; }
    if (next.timestamp[0] - word.timestamp[1] >= pauseSec && currentChars >= 4) { flush(false); }
  }

  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const tailChars = countChars(joinWordTexts(last.map(word => word.text)));
    const previous = groups[groups.length - 2];
    const previousChars = countChars(joinWordTexts(previous.map(word => word.text)));
    if (tailChars < MIN_PIECE_CHARS && previousChars + tailChars <= maxChars + 2) {
      groups.splice(groups.length - 2, 2, [...previous, ...last]);
      forced.splice(forced.length - 2, 2, false);
    }
  }
  if (groups.length < 2) return null;

  const pieces = buildPieces(words, groups, forced, maxChars);
  if (!validatePieces(chunk, pieces, words)) return null;
  const reason = pieces.some(piece => piece.forced) ? 'length' : 'punctuation';
  return { chunkId: chunk.id, before: chunk.text, pieces, reason };
}

/**
 * Build preview-only suggestions. Sentences longer than the limit are split only when their words already
 * carry reliable timestamps; translated, keyword-marked and dubbed cues are skipped so those mappings never shift.
 */
export function analyzeSentenceSplits(
  chunks: readonly SplitSourceChunk[],
  wordChunks: readonly SplitSourceWord[],
  options: SplitOptions = {},
): SplitAnalysis {
  const maxChars = normalizeMaxChars(options.maxChars);
  const pauseSec = Number.isFinite(options.pauseThresholdSec) ? Math.max(0, options.pauseThresholdSec as number) : DEFAULT_PAUSE_SEC;
  const byId = new Map(wordChunks.map(word => [word.id, word]));
  const skipped: SplitSkipped = { noWords: 0, mismatch: 0, translated: 0, keyworded: 0, dubbed: 0, short: 0 };
  const suggestions: SplitSuggestion[] = [];

  for (const chunk of chunks) {
    if (chunk.deleted || chunk.isBlankSpacer) continue;
    if (countChars(chunk.text) <= maxChars) { skipped.short += 1; continue; }
    if (chunk.secondText?.trim() || options.translatedChunkIds?.has(chunk.id)) { skipped.translated += 1; continue; }
    if (chunk.keywords?.length) { skipped.keyworded += 1; continue; }
    if (options.dubbingChunkIds?.has(chunk.id)) { skipped.dubbed += 1; continue; }
    const ids = chunk.wordIds ?? [];
    if (!ids.length) { skipped.noWords += 1; continue; }
    const words = ids.map(id => byId.get(id)).filter((word): word is SplitSourceWord => !!word);
    if (words.length !== ids.length) { skipped.noWords += 1; continue; }
    if (words.some(word => word.deleted || !validSpan(word.timestamp))) { skipped.noWords += 1; continue; }
    if (!sameVisibleText(chunk.text, joinWordTexts(words.map(word => word.text)))) { skipped.mismatch += 1; continue; }
    const suggestion = splitChunk(chunk, words, maxChars, pauseSec);
    if (suggestion) suggestions.push(suggestion);
    else skipped.short += 1;
  }

  const overLimit = suggestions.reduce((total, suggestion) => total + suggestion.pieces.filter(piece => piece.limited).length, 0);
  return { maxChars, base: JSON.stringify([chunks, wordChunks]), suggestions, skipped, overLimit };
}

/** Validate every plan before the history store mutates anything. Word ids must cover the source exactly once. */
export function validateSplitPlans(
  chunks: readonly SplitSourceChunk[],
  plans: readonly SplitPlan[],
): { ok: true } | { ok: false; reason: SplitPlanError } {
  if (!plans.length) return { ok: false, reason: 'empty' };
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
  const seen = new Set<string>();
  for (const plan of plans) {
    if (seen.has(plan.chunkId)) return { ok: false, reason: 'unknown' };
    seen.add(plan.chunkId);
    const chunk = byId.get(plan.chunkId);
    if (!chunk) return { ok: false, reason: 'unknown' };
    if (chunk.deleted || chunk.isBlankSpacer) return { ok: false, reason: 'deleted' };
    if (chunk.secondText?.trim() || chunk.keywords?.length) return { ok: false, reason: 'protected' };
    if (!chunk.wordIds?.length || plan.pieces.length < 2) return { ok: false, reason: 'invalid-pieces' };
    const covered: string[] = [];
    let previousStart = -Infinity;
    for (const piece of plan.pieces) {
      if (!piece.text.trim()) return { ok: false, reason: 'invalid-pieces' };
      if (!validSpan(piece.timestamp)) return { ok: false, reason: 'invalid-time' };
      if (piece.timestamp[0] < chunk.timestamp[0] - EPSILON || piece.timestamp[1] > chunk.timestamp[1] + EPSILON) {
        return { ok: false, reason: 'invalid-time' };
      }
      if (piece.timestamp[0] < previousStart - EPSILON) return { ok: false, reason: 'invalid-time' };
      previousStart = piece.timestamp[0];
      if (!piece.wordIds.length) return { ok: false, reason: 'word-mismatch' };
      covered.push(...piece.wordIds);
    }
    if (covered.length !== chunk.wordIds.length) return { ok: false, reason: 'word-mismatch' };
    if (!chunk.wordIds.every((id, index) => covered[index] === id)) return { ok: false, reason: 'word-mismatch' };
  }
  return { ok: true };
}
