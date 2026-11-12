/**
 * F-0009 semantic filler contract.
 *
 * The model only returns word-id ranges. Host-side validation derives every timestamp
 * from the authoritative word table and rejects a whole batch when any candidate is unsafe.
 */
import { z } from 'zod';
import type { CutSuggestion, SuggestionSource } from './suggestions';

export const SEMANTIC_FILLER_VERSION = 1;
export const SEMANTIC_PROMPT_VERSION = 'f0009-v1';
export const SEMANTIC_FILLER_CATEGORIES = [
  'contextual-filler', 'repetition', 'self-correction', 'fragment',
] as const;
export const SEMANTIC_FILLER_CONFIDENCE = ['high', 'medium', 'low'] as const;
export const SEMANTIC_FILLER_SCOPES = ['word', 'sentence'] as const;

export const semanticCategorySchema = z.enum(SEMANTIC_FILLER_CATEGORIES);
export const semanticConfidenceSchema = z.enum(SEMANTIC_FILLER_CONFIDENCE);
export const semanticScopeSchema = z.enum(SEMANTIC_FILLER_SCOPES);

export type SemanticCategory = z.infer<typeof semanticCategorySchema>;
export type SemanticConfidence = z.infer<typeof semanticConfidenceSchema>;
export type SemanticScope = z.infer<typeof semanticScopeSchema>;

export const semanticWordSchema = z.object({
  id: z.string().min(1).max(300),
  text: z.string().max(2000),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  deletable: z.boolean(),
});

export const semanticSentenceSchema = z.object({
  id: z.string().min(1).max(300),
  text: z.string().max(10000),
  words: z.array(semanticWordSchema).min(1),
});

export const semanticPolicySchema = z.object({
  allowedCategories: z.array(semanticCategorySchema).min(1),
  allowSentenceScope: z.boolean(),
  maxCandidates: z.number().int().min(1).max(100),
  maxWordsPerCandidate: z.number().int().min(1).max(200),
  maxReasonChars: z.number().int().min(20).max(1000),
});

export const semanticWindowSchema = z.object({
  version: z.literal(SEMANTIC_FILLER_VERSION),
  base: z.string().min(1).max(200),
  transcriptId: z.string().min(1).max(500),
  language: z.string().min(1).max(40),
  target: z.object({ startWordId: z.string().min(1), endWordId: z.string().min(1) }),
  sentences: z.array(semanticSentenceSchema).min(1).max(40),
  policy: semanticPolicySchema,
});

export type SemanticWord = z.infer<typeof semanticWordSchema>;
export type SemanticSentence = z.infer<typeof semanticSentenceSchema>;
export type SemanticWindow = z.infer<typeof semanticWindowSchema>;

export interface SemanticSuggestionCandidate {
  suggestionId: string;
  startWordId: string;
  endWordId: string;
  wordIds: string[];
  scope: SemanticScope;
  category: SemanticCategory;
  reason: string;
  confidence: SemanticConfidence;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SemanticAnalysisResult {
  version: 1;
  base: string;
  promptVersion: typeof SEMANTIC_PROMPT_VERSION;
  candidates: SemanticSuggestionCandidate[];
}

export interface SemanticWindowInput {
  base: string;
  transcriptId: string;
  language: string;
  chunks: Array<{
    id: string;
    text: string;
    timestamp: [number, number];
    wordIds?: string[];
  }>;
  wordChunks: Array<{
    id: string;
    text: string;
    timestamp: [number, number];
    sentenceId?: string;
  }>;
  existingDeleted?: Array<{ start: number; end: number }>;
  maxTargetSentences?: number;
  contextSentences?: number;
}

export interface SemanticWindowPlan {
  windows: SemanticWindow[];
  totalBatches: number;
  targetSentenceCount: number;
  targetWordCount: number;
  eligibleSentenceIds: string[];
}

export class SemanticContractError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SemanticContractError';
    this.code = code;
    this.details = details;
  }
}

interface IndexedWord extends SemanticWord {
  sentenceIndex: number;
  wordIndex: number;
}

interface IndexedSentence {
  id: string;
  text: string;
  wordIds: string[];
  index: number;
}

interface SemanticIndex {
  words: IndexedWord[];
  sentences: IndexedSentence[];
  wordIndexById: Map<string, number>;
  sentenceIndexById: Map<string, number>;
}

const fail = (code: string, message: string, details?: Record<string, unknown>): never => {
  throw new SemanticContractError(code, message, details);
};

const cleanWordText = (text: string) => text.replace(/[\p{P}\s]/gu, '');
const ms = (seconds: number): number => {
  if (!Number.isFinite(seconds) || seconds < 0) fail('INVALID_TIMESTAMP', 'Invalid media time');
  return Math.round(seconds * 1000);
};

function buildRequestIndex(sentences: SemanticSentence[]): SemanticIndex {
  const words: IndexedWord[] = [];
  const indexedSentences: IndexedSentence[] = [];
  const ids = new Set<string>();
  let previousEnd = -Infinity;
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    if (!sentence.id || ids.has(sentence.id)) fail('DUPLICATE_SENTENCE_ID', 'Duplicate sentence id');
    ids.add(sentence.id);
    for (const word of sentence.words) {
      if (!word.id) fail('INVALID_WINDOW', 'Word id is required');
      if (words.some(item => item.id === word.id)) fail('DUPLICATE_WORD_ID', 'Duplicate word id');
      if (word.endMs <= word.startMs) fail('INVALID_TIMESTAMP', `Invalid span for ${word.id}`);
      if (word.startMs < previousEnd) fail('WORD_ORDER', 'Words overlap or run backwards');
      previousEnd = word.endMs;
      words.push({ ...word, sentenceIndex, wordIndex: words.length });
    }
    indexedSentences.push({
      id: sentence.id, text: sentence.text,
      wordIds: sentence.words.map(word => word.id), index: sentenceIndex,
    });
  }
  const wordIndexById = new Map(words.map(word => [word.id, word.wordIndex]));
  const sentenceIndexById = new Map(indexedSentences.map(sentence => [sentence.id, sentence.index]));
  return { words, sentences: indexedSentences, wordIndexById, sentenceIndexById };
}

function buildTranscriptIndex(input: SemanticWindowInput): SemanticIndex {
  const byId = new Map<string, SemanticWordInput>();
  for (const word of input.wordChunks) {
    if (!word.id || byId.has(word.id)) fail('DUPLICATE_WORD_ID', `Duplicate word id: ${word.id}`);
    byId.set(word.id, word);
  }
  const words: IndexedWord[] = [];
  const sentences: IndexedSentence[] = [];
  for (const [sentenceIndex, sentence] of input.chunks.entries()) {
    if (!sentence.id || !Array.isArray(sentence.wordIds) || !sentence.wordIds.length) {
      fail('INVALID_TRANSCRIPT', `Sentence ${sentence.id || '(missing)'} has no wordIds`);
    }
    const sentenceWordIds = sentence.wordIds!;
    let previousEnd = -Infinity;
    for (const id of sentenceWordIds) {
      const word = byId.get(id);
      if (!word) fail('UNKNOWN_WORD_ID', `Sentence ${sentence.id} references missing word ${id}`);
      const resolvedWord = word!;
      if (resolvedWord.sentenceId && resolvedWord.sentenceId !== sentence.id) {
        fail('SENTENCE_MISMATCH', `Word ${id} belongs to ${resolvedWord.sentenceId}, not ${sentence.id}`);
      }
      const startMs = ms(resolvedWord.timestamp[0]);
      const endMs = ms(resolvedWord.timestamp[1]);
      if (endMs <= startMs) fail('INVALID_TIMESTAMP', `Word ${id} has an empty span`);
      if (startMs < previousEnd) fail('WORD_ORDER', `Words in ${sentence.id} overlap or run backwards`);
      previousEnd = endMs;
      words.push({ id, text: resolvedWord.text, startMs, endMs, deletable: true, sentenceIndex, wordIndex: words.length });
    }
    sentences.push({ id: sentence.id, text: sentence.text, wordIds: [...sentenceWordIds], index: sentenceIndex });
  }
  if (words.length !== byId.size) fail('ORPHAN_WORD', 'Some wordChunks are not listed by any sentence');
  return {
    words,
    sentences,
    wordIndexById: new Map(words.map(word => [word.id, word.wordIndex])),
    sentenceIndexById: new Map(sentences.map(sentence => [sentence.id, sentence.index])),
  };
}

interface SemanticWordInput {
  id: string;
  text: string;
  timestamp: [number, number];
  sentenceId?: string;
}

const AMBIGUOUS_MARKERS = ['就是', '那个', '这个', '然后', '其实'];
const CORRECTION_MARKERS = ['不对', '不是', '重说', '说错', '应该是', '改成', '我是说'];
const ABANDONED_END = /(然后|因为|所以|但是|而且|就是|那个|这个|如果|或者说)$/u;

function sentenceIsAmbiguous(sentence: IndexedSentence, words: IndexedWord[]): boolean {
  const normalized = words.map(word => cleanWordText(word.text)).filter(Boolean);
  const text = normalized.join('');
  if (AMBIGUOUS_MARKERS.some(marker => text.includes(marker))) return true;
  if (CORRECTION_MARKERS.some(marker => text.includes(marker))) return true;
  if (ABANDONED_END.test(text)) return true;
  return normalized.some((word, index) => index > 0 && word === normalized[index - 1]);
}

function overlapsExistingDeletion(words: IndexedWord[], ranges: Array<{ start: number; end: number }>) {
  return words.some(word => ranges.some(range => range.start < word.endMs / 1000 && range.end > word.startMs / 1000));
}

/**
 * Build bounded windows around only sentences that merit contextual analysis. Context words
 * remain visible to the model but are explicitly non-deletable.
 */
export function buildSemanticWindowPlan(input: SemanticWindowInput): SemanticWindowPlan {
  const index = buildTranscriptIndex(input);
  const maxTargetSentences = Math.max(1, Math.min(20, input.maxTargetSentences ?? 20));
  const contextSentences = Math.max(0, Math.min(2, input.contextSentences ?? 1));
  const deleted = input.existingDeleted ?? [];
  const eligible = index.sentences.filter(sentence => {
    const words = sentence.wordIds.map(id => index.words[index.wordIndexById.get(id)!]);
    return !overlapsExistingDeletion(words, deleted) && sentenceIsAmbiguous(sentence, words);
  }).map(sentence => sentence.index);
  const groups: number[][] = [];
  for (const sentenceIndex of eligible) {
    const previous = groups.at(-1);
    if (previous && sentenceIndex === previous.at(-1)! + 1 && previous.length < maxTargetSentences) previous.push(sentenceIndex);
    else groups.push([sentenceIndex]);
  }
  const windows: SemanticWindow[] = [];
  let targetWordCount = 0;
  for (const [batchIndex, group] of groups.entries()) {
    const from = Math.max(0, group[0] - contextSentences);
    const to = Math.min(index.sentences.length - 1, group.at(-1)! + contextSentences);
    const targetStart = index.sentences[group[0]].wordIds[0];
    const targetEnd = index.sentences[group.at(-1)!].wordIds.at(-1)!;
    const startIndex = index.wordIndexById.get(targetStart)!;
    const endIndex = index.wordIndexById.get(targetEnd)!;
    const targetSentenceSet = new Set(group);
    targetWordCount += endIndex - startIndex + 1;
    windows.push({
      version: SEMANTIC_FILLER_VERSION,
      base: input.base,
      transcriptId: input.transcriptId,
      language: input.language || 'auto',
      target: { startWordId: targetStart, endWordId: targetEnd },
      sentences: index.sentences.slice(from, to + 1).map(sentence => ({
        id: sentence.id,
        text: sentence.text,
        words: sentence.wordIds.map(id => {
          const word = index.words[index.wordIndexById.get(id)!];
          return {
            id: word.id,
            text: word.text,
            startMs: word.startMs,
            endMs: word.endMs,
            deletable: targetSentenceSet.has(sentence.index),
          };
        }),
      })),
      policy: {
        allowedCategories: [...SEMANTIC_FILLER_CATEGORIES],
        allowSentenceScope: true,
        maxCandidates: 40,
        maxWordsPerCandidate: 30,
        maxReasonChars: 200,
      },
    });
    if (batchIndex > 100) fail('TOO_MANY_WINDOWS', 'Transcript produced too many semantic windows');
  }
  return {
    windows,
    totalBatches: windows.length,
    targetSentenceCount: eligible.length,
    targetWordCount,
    eligibleSentenceIds: eligible.map(indexValue => index.sentences[indexValue].id),
  };
}

function derivedWordIds(index: SemanticIndex, startIndex: number, endIndex: number): string[] {
  const ids: string[] = [];
  for (let position = startIndex; position <= endIndex; position += 1) ids.push(index.words[position].id);
  return ids;
}

function assertWordScope(index: SemanticIndex, startIndex: number, endIndex: number) {
  const start = index.words[startIndex];
  const end = index.words[endIndex];
  if (start.sentenceIndex !== end.sentenceIndex) fail('CROSS_SENTENCE_WORD_SCOPE', 'Word scope may not cross sentences');
  const sentence = index.sentences[start.sentenceIndex];
  const ids = derivedWordIds(index, startIndex, endIndex);
  if (ids.length >= sentence.wordIds.length) fail('SCOPE_REQUIRED', 'A whole sentence must use sentence scope');
  const remaining = sentence.wordIds.filter(id => !ids.includes(id));
  const remainingText = remaining.map(id => index.words[index.wordIndexById.get(id)!].text).join('');
  if (!cleanWordText(remainingText)) fail('HALF_SENTENCE', 'A candidate may not leave only punctuation');
}

function assertSentenceScope(index: SemanticIndex, startIndex: number, endIndex: number) {
  const first = index.words[startIndex];
  const last = index.words[endIndex];
  const firstSentence = index.sentences[first.sentenceIndex];
  const lastSentence = index.sentences[last.sentenceIndex];
  if (firstSentence.wordIds[0] !== first.id || lastSentence.wordIds.at(-1) !== last.id) {
    fail('PARTIAL_SENTENCE', 'Sentence scope must cover complete consecutive sentences');
  }
  const expected: string[] = [];
  for (let indexValue = first.sentenceIndex; indexValue <= last.sentenceIndex; indexValue += 1) {
    expected.push(...index.sentences[indexValue].wordIds);
  }
  if (expected.join('\u0000') !== derivedWordIds(index, startIndex, endIndex).join('\u0000')) {
    fail('PARTIAL_SENTENCE', 'Sentence scope must cover complete consecutive sentences');
  }
}

export function validateSemanticModelResponse(raw: unknown, request: SemanticWindow): SemanticSuggestionCandidate[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_RESPONSE', 'Response must be an object');
  const response = raw as { version?: unknown; base?: unknown; candidates?: unknown };
  if (response.version !== SEMANTIC_FILLER_VERSION) fail('INVALID_VERSION', 'Response version does not match');
  if (response.base !== request.base) fail('STALE_BASE', 'Response base does not match the request');
  if (!Array.isArray(response.candidates)) fail('INVALID_RESPONSE', 'candidates must be an array');
  const responseCandidates = response.candidates as unknown[];
  if (responseCandidates.length > request.policy.maxCandidates) fail('TOO_MANY_CANDIDATES', 'Too many candidates');

  const index = buildRequestIndex(request.sentences);
  const maybeTargetStart = index.wordIndexById.get(request.target.startWordId);
  const maybeTargetEnd = index.wordIndexById.get(request.target.endWordId);
  if (maybeTargetStart === undefined || maybeTargetEnd === undefined || maybeTargetStart > maybeTargetEnd) {
    fail('INVALID_WINDOW', 'Request target is not a valid word range');
  }
  const targetStart = maybeTargetStart!;
  const targetEnd = maybeTargetEnd!;
  const allowed = new Set(request.policy.allowedCategories);
  const normalized: SemanticSuggestionCandidate[] = [];
  const seen = new Set<string>();

  for (const [position, value] of responseCandidates.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('INVALID_CANDIDATE', `Candidate ${position + 1} must be an object`);
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.startWordId !== 'string' || typeof candidate.endWordId !== 'string') {
      fail('INVALID_CANDIDATE', 'Candidate must contain startWordId and endWordId');
    }
    const startWordId = candidate.startWordId as string;
    const endWordId = candidate.endWordId as string;
    const maybeStartIndex = index.wordIndexById.get(startWordId);
    const maybeEndIndex = index.wordIndexById.get(endWordId);
    if (maybeStartIndex === undefined || maybeEndIndex === undefined) fail('UNKNOWN_WORD_ID', 'Candidate references an unknown word');
    const startIndex = maybeStartIndex!;
    const endIndex = maybeEndIndex!;
    if (startIndex > endIndex) fail('REVERSED_RANGE', 'Candidate start follows its end');
    if (startIndex < targetStart || endIndex > targetEnd) fail('OUT_OF_RANGE', 'Candidate is outside the target');
    const wordIds = derivedWordIds(index, startIndex, endIndex);
    if (candidate.wordIds !== undefined) {
      if (!Array.isArray(candidate.wordIds) || candidate.wordIds.join('\u0000') !== wordIds.join('\u0000')) {
        fail('NON_CONTIGUOUS', 'Explicit wordIds must match the contiguous range');
      }
    }
    if (wordIds.length > request.policy.maxWordsPerCandidate) fail('RANGE_TOO_LONG', 'Candidate is too long');
    const scope = semanticScopeSchema.safeParse(candidate.scope);
    if (!scope.success) fail('INVALID_SCOPE', 'Unknown candidate scope');
    const scopeValue = scope.data!;
    if (scopeValue === 'sentence') {
      if (!request.policy.allowSentenceScope) fail('SENTENCE_SCOPE_DISABLED', 'Sentence scope is disabled');
      assertSentenceScope(index, startIndex, endIndex);
    } else {
      assertWordScope(index, startIndex, endIndex);
    }
    const category = semanticCategorySchema.safeParse(candidate.category);
    if (!category.success || !allowed.has(category.data)) fail('INVALID_CATEGORY', 'Unknown or disallowed category');
    const categoryValue = category.data!;
    if (categoryValue === 'contextual-filler' && scopeValue !== 'word') fail('INVALID_CATEGORY_SCOPE', 'Contextual filler requires word scope');
    if (categoryValue === 'fragment' && scopeValue !== 'sentence') fail('INVALID_CATEGORY_SCOPE', 'Fragment requires sentence scope');
    const confidence = semanticConfidenceSchema.safeParse(candidate.confidence);
    if (!confidence.success) fail('INVALID_CONFIDENCE', 'Confidence must be high, medium, or low');
    const confidenceValue = confidence.data!;
    const reason = typeof candidate.reason === 'string' ? candidate.reason.trim() : '';
    if (!reason || reason.length > request.policy.maxReasonChars) fail('INVALID_REASON', 'Reason must be short and non-empty');
    const key = `${startIndex}:${endIndex}`;
    if (seen.has(key)) fail('DUPLICATE_RANGE', 'Two candidates cover the same range');
    for (const prior of normalized) {
      const priorStart = index.wordIndexById.get(prior.startWordId)!;
      const priorEnd = index.wordIndexById.get(prior.endWordId)!;
      if (startIndex <= priorEnd && priorStart <= endIndex) fail('OVERLAP', 'Candidates may not overlap');
    }
    seen.add(key);
    const start = index.words[startIndex];
    const end = index.words[endIndex];
    normalized.push({
      suggestionId: `semantic-${startWordId}-${endWordId}-${categoryValue}`,
      startWordId,
      endWordId,
      wordIds,
      scope: scopeValue,
      category: categoryValue,
      reason,
      confidence: confidenceValue,
      startMs: start.startMs,
      endMs: end.endMs,
      text: wordIds.map(id => index.words[index.wordIndexById.get(id)!].text).join(''),
    });
  }

  const wordUnion = new Set(normalized.filter(candidate => candidate.scope === 'word').flatMap(candidate => candidate.wordIds));
  for (const sentence of index.sentences) {
    if (sentence.wordIds.every(id => wordUnion.has(id))) fail('HALF_SENTENCE', 'The batch may not empty a sentence');
  }
  normalized.sort((left, right) => left.startMs - right.startMs);
  return normalized;
}

/** Exact cross-source duplicates merge; partial overlaps remain visible and count once downstream. */
export function mergeSemanticSuggestions(
  ruleItems: CutSuggestion[],
  semanticCandidates: SemanticSuggestionCandidate[],
): CutSuggestion[] {
  const merged = ruleItems.map(item => ({
    ...item,
    source: item.source ?? 'rule',
    sources: item.sources ?? [item.source ?? 'rule'],
  })) as CutSuggestion[];
  const byRange = new Map(merged.map(item => [`${Math.round(item.start * 1000)}:${Math.round(item.end * 1000)}`, item]));
  for (const candidate of semanticCandidates) {
    const start = candidate.startMs / 1000;
    const end = candidate.endMs / 1000;
    const key = `${candidate.startMs}:${candidate.endMs}`;
    const existing = byRange.get(key);
    if (existing) {
      const previousSources = (existing.sources ?? [existing.source ?? 'rule']) as SuggestionSource[];
      const sources = [...new Set<SuggestionSource>([...previousSources, 'semantic'])];
      existing.sources = sources;
      existing.semanticCategory = candidate.category;
      existing.semanticReason = candidate.reason;
      existing.semanticConfidence = candidate.confidence;
      existing.scope = candidate.scope;
      existing.wordIds = candidate.wordIds;
      continue;
    }
    const item: CutSuggestion = {
      id: candidate.suggestionId,
      start,
      end,
      reason: candidate.reason,
      category: candidate.category,
      label: candidate.text,
      selected: false,
      source: 'semantic',
      sources: ['semantic'],
      semanticCategory: candidate.category,
      semanticReason: candidate.reason,
      semanticConfidence: candidate.confidence,
      scope: candidate.scope,
      wordIds: candidate.wordIds,
    };
    merged.push(item);
    byRange.set(key, item);
  }
  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}

/** Hash the exact formal state used by the pending-suggestion contract. */
export async function createSemanticBase(input: {
  edl: unknown;
  chunks: unknown;
  wordChunks: unknown;
  sourceDuration: number;
  transcriptId: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    version: SEMANTIC_FILLER_VERSION,
    transcriptId: input.transcriptId,
    sourceDuration: input.sourceDuration,
    edl: input.edl,
    chunks: input.chunks,
    wordChunks: input.wordChunks,
  });
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('HASH_UNAVAILABLE', 'SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
