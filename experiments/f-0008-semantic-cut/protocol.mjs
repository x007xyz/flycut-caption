// F-0008 protocol sketch: word-ID candidate ranges and the checks that must
// pass before a semantic suggestion may enter the normal confirmation layer.
import { createHash } from 'node:crypto';

export const VERSION = 1;
export const CATEGORIES = [
  'contextual-filler',
  'repetition',
  'self-correction',
  'fragment',
];
export const CONFIDENCE = ['high', 'medium', 'low'];
export const SCOPES = ['word', 'sentence'];

export class ContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new ContractError(code, message, details);
};

export const cleanWordText = (text) => String(text ?? '').replace(/[\p{P}\s]/gu, '');

const milliseconds = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) fail('INVALID_TIMESTAMP', `Invalid media time: ${seconds}`);
  return Math.round(seconds * 1000);
};

/**
 * Build the authoritative word table from the same sentence + word structure
 * already validated by shared/asr/transcript.ts. The model never supplies time.
 */
export function buildIndex(transcript, options = {}) {
  const transcriptId = options.transcriptId ?? 'transcript';
  const language = transcript?.language ?? 'auto';
  const edlRevision = options.edlRevision ?? 'none';
  if (!transcript || !Array.isArray(transcript.chunks) || !Array.isArray(transcript.wordChunks)) {
    fail('INVALID_TRANSCRIPT', 'Transcript must have chunks and wordChunks');
  }
  const byId = new Map();
  for (const word of transcript.wordChunks) {
    if (!word?.id || byId.has(word.id)) fail('DUPLICATE_WORD_ID', `Duplicate word id: ${word?.id}`);
    byId.set(word.id, word);
  }
  const words = [];
  const sentences = [];
  for (const sentence of transcript.chunks) {
    if (!sentence?.id || !Array.isArray(sentence.wordIds) || sentence.wordIds.length === 0) {
      fail('INVALID_TRANSCRIPT', `Sentence ${sentence?.id ?? '(missing)'} has no wordIds`);
    }
    const ids = [];
    let previousEnd = -Infinity;
    for (const id of sentence.wordIds) {
      const word = byId.get(id);
      if (!word) fail('UNKNOWN_WORD_ID', `Sentence ${sentence.id} references missing word ${id}`);
      if (word.sentenceId !== sentence.id) fail('SENTENCE_MISMATCH', `Word ${id} belongs to ${word.sentenceId}, not ${sentence.id}`);
      const startMs = milliseconds(word.timestamp?.[0]);
      const endMs = milliseconds(word.timestamp?.[1]);
      if (endMs <= startMs) fail('INVALID_TIMESTAMP', `Word ${id} has an empty or reversed span`);
      if (startMs < previousEnd) fail('WORD_ORDER', `Words in ${sentence.id} overlap or run backwards`);
      previousEnd = endMs;
      ids.push(id);
      words.push({
        id, text: String(word.text ?? ''), startMs, endMs, sentenceId: sentence.id,
        sentenceIndex: sentences.length, wordIndex: words.length,
      });
    }
    sentences.push({
      id: sentence.id, text: String(sentence.text ?? ''), wordIds: ids,
      startMs: milliseconds(sentence.timestamp?.[0]), endMs: milliseconds(sentence.timestamp?.[1]),
      index: sentences.length,
    });
  }
  if (words.length !== byId.size) fail('ORPHAN_WORD', 'Some wordChunks are not listed by any sentence');
  const wordIndexById = new Map(words.map((word) => [word.id, word.wordIndex]));
  const sentenceById = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const sentenceIndexById = new Map(sentences.map((sentence) => [sentence.id, sentence.index]));
  const canonical = {
    version: VERSION, transcriptId, language, edlRevision,
    words: words.map(({ id, text, startMs, endMs, sentenceId }) => ({ id, text, startMs, endMs, sentenceId })),
  };
  return {
    transcriptId, language, edlRevision, words, sentences,
    wordIndexById, sentenceById, sentenceIndexById,
    base: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    durationMs: milliseconds(transcript.duration ?? 0),
  };
}

export function buildWindow(index, startWordId, endWordId, options = {}) {
  const startIndex = index.wordIndexById.get(startWordId);
  const endIndex = index.wordIndexById.get(endWordId);
  if (startIndex === undefined) fail('UNKNOWN_WORD_ID', `Unknown start word: ${startWordId}`);
  if (endIndex === undefined) fail('UNKNOWN_WORD_ID', `Unknown end word: ${endWordId}`);
  if (startIndex > endIndex) fail('REVERSED_RANGE', 'Start word comes after end word');
  const firstSentence = index.words[startIndex].sentenceIndex;
  const lastSentence = index.words[endIndex].sentenceIndex;
  const contextSentences = options.contextSentences ?? 1;
  const from = Math.max(0, firstSentence - contextSentences);
  const to = Math.min(index.sentences.length - 1, lastSentence + contextSentences);
  return {
    version: VERSION,
    base: index.base,
    transcriptId: index.transcriptId,
    language: index.language,
    target: { startWordId, endWordId },
    sentences: index.sentences.slice(from, to + 1).map((sentence) => ({
      id: sentence.id,
      text: sentence.text,
      words: sentence.wordIds.map((id) => {
        const word = index.words[index.wordIndexById.get(id)];
        return {
          id: word.id, text: word.text, startMs: word.startMs, endMs: word.endMs,
          deletable: word.wordIndex >= startIndex && word.wordIndex <= endIndex,
        };
      }),
    })),
    policy: {
      allowedCategories: options.allowedCategories ?? CATEGORIES,
      allowSentenceScope: options.allowSentenceScope ?? true,
      maxCandidates: options.maxCandidates ?? 40,
      maxWordsPerCandidate: options.maxWordsPerCandidate ?? 30,
      maxReasonChars: options.maxReasonChars ?? 200,
    },
  };
}

function derivedWordIds(index, startIndex, endIndex) {
  const ids = [];
  for (let position = startIndex; position <= endIndex; position += 1) ids.push(index.words[position].id);
  return ids;
}

function assertSentenceScope(index, startIndex, endIndex) {
  const first = index.words[startIndex];
  const last = index.words[endIndex];
  const firstSentence = index.sentences[first.sentenceIndex];
  const lastSentence = index.sentences[last.sentenceIndex];
  if (firstSentence.wordIds[0] !== first.id) fail('PARTIAL_SENTENCE', 'Sentence scope must start at a sentence start');
  if (lastSentence.wordIds.at(-1) !== last.id) fail('PARTIAL_SENTENCE', 'Sentence scope must end at a sentence end');
  const expected = [];
  for (let position = first.sentenceIndex; position <= last.sentenceIndex; position += 1) {
    expected.push(...index.sentences[position].wordIds);
  }
  if (expected.join('\u0000') !== derivedWordIds(index, startIndex, endIndex).join('\u0000')) {
    fail('PARTIAL_SENTENCE', 'Sentence scope must cover complete consecutive sentences');
  }
}

function assertWordScope(index, startIndex, endIndex) {
  const start = index.words[startIndex];
  const end = index.words[endIndex];
  if (start.sentenceId !== end.sentenceId) fail('CROSS_SENTENCE_WORD_SCOPE', 'Word scope may not cross a sentence boundary');
  const sentence = index.sentences[start.sentenceIndex];
  const ids = derivedWordIds(index, startIndex, endIndex);
  if (ids.length >= sentence.wordIds.length) fail('SCOPE_REQUIRED', 'A whole sentence must use sentence scope');
  const remaining = sentence.wordIds.filter((id) => !ids.includes(id));
  if (remaining.length === 0) fail('HALF_SENTENCE', 'A candidate may not empty a sentence through word scope');
  const remainingText = remaining.map((id) => index.words[index.wordIndexById.get(id)].text).join('');
  if (!cleanWordText(remainingText)) fail('HALF_SENTENCE', 'A candidate may not leave only punctuation behind');
}

export function validateCandidates(response, request, index) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    fail('INVALID_RESPONSE', 'Response must be a JSON object');
  }
  if (response.version !== VERSION) fail('INVALID_VERSION', `Expected version ${VERSION}`);
  if (response.base !== request.base) fail('STALE_BASE', 'Response base does not match the current transcript');
  if (!Array.isArray(response.candidates)) fail('INVALID_RESPONSE', 'candidates must be an array');
  const policy = request.policy ?? {};
  const allowed = new Set(policy.allowedCategories ?? CATEGORIES);
  const targetStart = index.wordIndexById.get(request.target.startWordId);
  const targetEnd = index.wordIndexById.get(request.target.endWordId);
  if (targetStart === undefined || targetEnd === undefined) fail('INVALID_REQUEST', 'Request target is not in the word table');
  if (response.candidates.length > (policy.maxCandidates ?? 40)) fail('TOO_MANY_CANDIDATES', 'Too many candidates');

  const normalized = [];
  const seen = new Set();
  for (const [position, candidate] of response.candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('INVALID_CANDIDATE', `Candidate ${position + 1} must be an object`);
    }
    const startWordId = candidate.startWordId;
    const endWordId = candidate.endWordId;
    if (typeof startWordId !== 'string' || typeof endWordId !== 'string') {
      fail('INVALID_CANDIDATE', 'Candidate must contain startWordId and endWordId strings');
    }
    const startIndex = index.wordIndexById.get(startWordId);
    const endIndex = index.wordIndexById.get(endWordId);
    if (startIndex === undefined || endIndex === undefined) fail('UNKNOWN_ID', 'Candidate references an unknown word id');
    if (startIndex > endIndex) fail('REVERSED_RANGE', 'Candidate start comes after end');
    if (startIndex < targetStart || endIndex > targetEnd) fail('OUT_OF_RANGE', 'Candidate is outside the requested target range');
    const ids = derivedWordIds(index, startIndex, endIndex);
    if (candidate.wordIds !== undefined) {
      if (!Array.isArray(candidate.wordIds) || candidate.wordIds.join('\u0000') !== ids.join('\u0000')) {
        fail('NON_CONTIGUOUS', 'Explicit wordIds must equal the contiguous range');
      }
    }
    if (ids.length > (policy.maxWordsPerCandidate ?? 30)) fail('RANGE_TOO_LONG', 'Candidate is longer than the configured limit');
    const scope = candidate.scope;
    if (!SCOPES.includes(scope)) fail('INVALID_SCOPE', 'Unknown candidate scope');
    if (scope === 'sentence') {
      if (policy.allowSentenceScope === false) fail('SENTENCE_SCOPE_DISABLED', 'Sentence scope is disabled');
      assertSentenceScope(index, startIndex, endIndex);
    } else {
      assertWordScope(index, startIndex, endIndex);
    }
    if (!CATEGORIES.includes(candidate.category) || !allowed.has(candidate.category)) {
      fail('INVALID_CATEGORY', 'Unknown or disallowed category');
    }
    if (!CONFIDENCE.includes(candidate.confidence)) fail('INVALID_CONFIDENCE', 'Confidence must be high, medium, or low');
    const reason = typeof candidate.reason === 'string' ? candidate.reason.trim() : '';
    if (!reason || reason.length > (policy.maxReasonChars ?? 200)) fail('INVALID_REASON', 'Reason must be non-empty and short');
    const key = `${startIndex}:${endIndex}`;
    if (seen.has(key)) fail('DUPLICATE_RANGE', 'Two candidates cover the same range');
    for (const prior of normalized) {
      if (startIndex <= prior.endIndex && prior.startIndex <= endIndex) {
        fail('OVERLAP', 'Candidates may not overlap');
      }
    }
    seen.add(key);
    const start = index.words[startIndex];
    const end = index.words[endIndex];
    normalized.push({
      candidateId: `${startWordId}..${endWordId}:${candidate.category}`,
      startWordId, endWordId, wordIds: ids, scope, category: candidate.category,
      reason, confidence: candidate.confidence,
      startMs: start.startMs, endMs: end.endMs,
      startIndex, endIndex,
    });
  }

  const union = new Set();
  for (const candidate of normalized.filter((item) => item.scope === 'word')) {
    for (const id of candidate.wordIds) union.add(id);
  }
  for (const sentence of index.sentences) {
    if (sentence.wordIds.every((id) => union.has(id))) {
      fail('HALF_SENTENCE', `Word-scope candidates empty sentence ${sentence.id}`);
    }
  }
  normalized.sort((a, b) => a.startIndex - b.startIndex);
  return normalized;
}

export function rangesFromCandidates(candidates) {
  return candidates.map((candidate) => ({ startMs: candidate.startMs, endMs: candidate.endMs }));
}
