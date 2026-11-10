import { joinWordTexts } from '../text/joinWords.ts';

export type FillerCategory = 'standalone-filler' | 'repeated-word';
export type FillerReason = 'filler.standalone' | 'filler.repeated';

export interface FillerWord {
  id: string;
  text: string;
  timestamp: [number, number];
  sentenceId?: string;
  deleted?: boolean;
}

export interface FillerSentence {
  id: string;
  text: string;
  timestamp: [number, number];
  deleted?: boolean;
  wordIds?: string[];
  edlWordProjection?: boolean;
}

export interface FillerRuleInput {
  chunks: FillerSentence[];
  wordChunks?: FillerWord[];
  hasWordTimestamps?: boolean;
  sourceDuration: number;
  existingDeleted?: Array<{ start: number; end: number }>;
}

export interface FillerCandidate {
  id: string;
  sentenceId: string;
  wordIds: string[];
  start: number;
  end: number;
  tokenStart: number;
  tokenEnd: number;
  label: string;
  category: FillerCategory;
  reason: FillerReason;
  confidence: number;
  defaultSelected: boolean;
}

export interface SkippedSentence {
  sentenceId: string;
  reason: 'missing-words' | 'text-mismatch' | 'implausible-duration' | 'overlap' | 'synthetic-timing' | 'deleted';
}

export interface FillerGateResult {
  ok: boolean;
  reasons: string[];
  eligibleSentences: string[];
  skippedSentences: SkippedSentence[];
}

export interface FillerAnalysisResult {
  gate: FillerGateResult;
  candidates: FillerCandidate[];
  stats: {
    sentences: number;
    skipped: number;
    standalone: number;
    repeated: number;
    durationSeconds: number;
  };
}

/** Core fillers. Semantic words such as 就是/那个/然后 are deliberately absent. */
export const FILLER_WORDS = new Set(['嗯', '啊', '呃', '额', '唔', '唉', '哎']);
/** Lower-confidence edge fillers. */
export const EDGE_FILLER_WORDS = new Set(['哦']);
export const SEMANTIC_WORDS = new Set(['就是', '那个', '然后', '这个', '所以', '但是', '其实', '还有']);
const HIGH_FREQUENCY_REPEATS = new Set(['那个', '这个', '就是', '然后']);
const plain = (text: string) => text.replace(/[\p{P}\s]/gu, '');
const normalize = (text: string) => text.trim().replace(/[\p{P}\s]+/gu, '');
const round = (value: number) => Math.round(value * 1e6) / 1e6;

function sentenceWords(input: FillerRuleInput, sentence: FillerSentence): FillerWord[] {
  const words = (input.wordChunks ?? []).filter(word => word.sentenceId === sentence.id);
  if (sentence.wordIds?.length) {
    const byId = new Map(words.map(word => [word.id, word]));
    return sentence.wordIds.map(id => byId.get(id)).filter((word): word is FillerWord => !!word);
  }
  return words;
}

function gateSentence(input: FillerRuleInput, sentence: FillerSentence, words: FillerWord[]): SkippedSentence['reason'] | null {
  if (sentence.deleted) return 'deleted';
  if (!words.length) return 'missing-words';
  if (sentence.wordIds?.length && words.length !== sentence.wordIds.length) return 'missing-words';
  const active = words.filter(word => !word.deleted);
  if (!active.length) return 'deleted';
  if (active.some(word => !Number.isFinite(word.timestamp[0]) || !Number.isFinite(word.timestamp[1])
    || word.timestamp[1] <= word.timestamp[0] || word.timestamp[0] < 0 || word.timestamp[1] > input.sourceDuration + 0.02)) return 'implausible-duration';
  if (active.some(word => word.timestamp[1] - word.timestamp[0] < 0.02 || word.timestamp[1] - word.timestamp[0] > 3)) return 'implausible-duration';
  for (let index = 0; index < active.length; index++) {
    const word = active[index];
    if (word.timestamp[0] < sentence.timestamp[0] - 0.02 || word.timestamp[1] > sentence.timestamp[1] + 0.02) return 'implausible-duration';
    if (index > 0 && active[index - 1].timestamp[1] > word.timestamp[0] + 0.02) return 'overlap';
  }
  const expectedText = plain(joinWordTexts(active.map(word => word.text)));
  if (expectedText !== plain(sentence.text)) return 'text-mismatch';
  if (active.length >= 4) {
    const span = sentence.timestamp[1] - sentence.timestamp[0];
    const synthetic = active.every((word, index) => Math.abs(word.timestamp[0] - (sentence.timestamp[0] + span * index / active.length)) <= 0.005);
    const contiguous = active.every((word, index) => index === 0 || Math.abs(word.timestamp[0] - active[index - 1].timestamp[1]) <= 0.002);
    if (synthetic && contiguous) return 'synthetic-timing';
  }
  if (active.length >= 2) {
    const durations = active.map(word => word.timestamp[1] - word.timestamp[0]);
    const sameDuration = durations.every(duration => Math.abs(duration - durations[0]) <= 0.002);
    const gaps = active.slice(1).reduce((sum, word, index) => sum + Math.max(0, word.timestamp[0] - active[index].timestamp[1]), 0);
    if (sameDuration && gaps < 0.002) return 'synthetic-timing';
  }
  return null;
}

export function inspectFillerGate(input: FillerRuleInput): FillerGateResult {
  const reasons: string[] = [];
  if (!input.hasWordTimestamps) reasons.push('missing-word-timestamps');
  if (!input.wordChunks?.length) reasons.push('missing-word-timestamps');
  if (!input.chunks.length) reasons.push('missing-word-timestamps');
  const sentenceMap = new Map(input.chunks.map(sentence => [sentence.id, sentence]));
  const ids = new Set<string>();
  for (const word of input.wordChunks ?? []) {
    if (!word.id || ids.has(word.id)) { reasons.push('duplicate-word-id'); break; }
    ids.add(word.id);
    if (!word.sentenceId || !sentenceMap.has(word.sentenceId)) { reasons.push('orphan-word'); break; }
    if (!Number.isFinite(word.timestamp[0]) || !Number.isFinite(word.timestamp[1]) || word.timestamp[1] <= word.timestamp[0]) {
      reasons.push('invalid-word-timestamp'); break;
    }
  }
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)], eligibleSentences: [], skippedSentences: [] };

  const skippedSentences: SkippedSentence[] = [];
  const eligibleSentences: string[] = [];
  for (const sentence of input.chunks) {
    const words = sentenceWords(input, sentence);
    const reason = gateSentence(input, sentence, words);
    if (reason) skippedSentences.push({ sentenceId: sentence.id, reason });
    else eligibleSentences.push(sentence.id);
  }
  if (!eligibleSentences.length) return { ok: false, reasons: ['no-valid-sentences'], eligibleSentences, skippedSentences };
  return { ok: true, reasons: [], eligibleSentences, skippedSentences };
}

function padding(beforeEnd: number | undefined, start: number, end: number, afterStart: number | undefined) {
  const lead = beforeEnd === undefined ? 0 : Math.min(0.04, Math.max(0, (start - beforeEnd) / 2));
  const tail = afterStart === undefined ? 0 : Math.min(0.04, Math.max(0, (afterStart - end) / 2));
  return { lead, tail };
}

function coveredByExisting(input: FillerRuleInput, start: number, end: number) {
  return (input.existingDeleted ?? []).some(range => range.start <= start + 1e-6 && range.end >= end - 1e-6);
}

function boundaryEvidence(sentence: FillerSentence, words: FillerWord[], index: number) {
  const word = words[index];
  const previous = words[index - 1];
  const next = words[index + 1];
  const left = index === 0 || /[\s\p{P}]$/u.test(previous.text) || word.timestamp[0] - previous.timestamp[1] >= 0.08;
  const right = index === words.length - 1 || /^[\s\p{P}]/u.test(next.text) || next.timestamp[0] - word.timestamp[1] >= 0.08;
  return left && right && sentence.text.length > 0;
}

export function analyzeFillerSentences(input: FillerRuleInput, sentenceIds?: string[]): FillerCandidate[] {
  const wanted = sentenceIds ? new Set(sentenceIds) : undefined;
  const candidates: FillerCandidate[] = [];
  for (const sentence of input.chunks) {
    if (wanted && !wanted.has(sentence.id)) continue;
    const words = sentenceWords(input, sentence).filter(word => !word.deleted);
    if (!words.length) continue;
    const charOffsets = new Map<string, number>();
    let cursor = 0;
    for (const word of words) {
      const at = sentence.text.indexOf(word.text, cursor);
      charOffsets.set(word.id, at >= 0 ? at : cursor);
      if (at >= 0) cursor = at + word.text.length;
    }
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      const normalized = normalize(word.text);
      const isFiller = FILLER_WORDS.has(normalized) || EDGE_FILLER_WORDS.has(normalized);
      if (!isFiller || SEMANTIC_WORDS.has(normalized) || !boundaryEvidence(sentence, words, index)) continue;
      const { lead, tail } = padding(words[index - 1]?.timestamp[1], word.timestamp[0], word.timestamp[1], words[index + 1]?.timestamp[0]);
      const start = round(Math.max(0, word.timestamp[0] - lead));
      const end = round(Math.min(input.sourceDuration, word.timestamp[1] + tail));
      if (end <= start || coveredByExisting(input, start, end)) continue;
      const atStart = index === 0;
      candidates.push({
        id: `${sentence.id}:${word.id}:standalone:${Math.round(start * 1e6)}:${Math.round(end * 1e6)}`,
        sentenceId: sentence.id, wordIds: [word.id], start, end,
        tokenStart: charOffsets.get(word.id) ?? 0, tokenEnd: (charOffsets.get(word.id) ?? 0) + word.text.length,
        label: word.text, category: 'standalone-filler', reason: 'filler.standalone',
        confidence: EDGE_FILLER_WORDS.has(normalized) ? 0.45 : atStart ? 0.8 : 0.6,
        defaultSelected: atStart && !EDGE_FILLER_WORDS.has(normalized),
      });
    }

    for (let index = 0; index < words.length;) {
      const first = words[index];
      const normalized = normalize(first.text);
      if (!normalized) { index++; continue; }
      let end = index;
      while (end + 1 < words.length && normalize(words[end + 1].text) === normalized
        && words[end + 1].timestamp[0] - words[end].timestamp[1] <= 0.25
        && words[end + 1].timestamp[0] >= words[end].timestamp[1] - 0.02) end++;
      const run = words.slice(index, end + 1);
      const repeatable = run.length >= 2 && (normalized.length >= 2 || FILLER_WORDS.has(normalized) || EDGE_FILLER_WORDS.has(normalized));
      if (repeatable) {
        const last = run.at(-1)!;
        const before = words[index - 1];
        const start = round(Math.max(0, first.timestamp[0] - (before ? Math.min(0.04, Math.max(0, (first.timestamp[0] - before.timestamp[1]) / 2)) : 0)));
        const stop = round(last.timestamp[0]);
        if (stop > start && !coveredByExisting(input, start, stop)) {
          const label = joinWordTexts(run.map(word => word.text));
          candidates.push({
            id: `${sentence.id}:${run.map(word => word.id).join('+')}:repeated:${Math.round(start * 1e6)}:${Math.round(stop * 1e6)}`,
            sentenceId: sentence.id, wordIds: run.slice(0, -1).map(word => word.id), start, end: stop,
            tokenStart: 0, tokenEnd: label.length, label,
            category: 'repeated-word', reason: 'filler.repeated',
            confidence: HIGH_FREQUENCY_REPEATS.has(normalized) ? 0.65 : 0.55,
            defaultSelected: false,
          });
        }
      }
      index = end + 1;
    }
  }
  return candidates.sort((left, right) => left.start - right.start || left.sentenceId.localeCompare(right.sentenceId) || left.id.localeCompare(right.id));
}

export function analyzeFillers(input: FillerRuleInput): FillerAnalysisResult {
  const gate = inspectFillerGate(input);
  const candidates = gate.ok ? analyzeFillerSentences(input, gate.eligibleSentences) : [];
  const ranges = candidates.map(candidate => ({ start: candidate.start, end: candidate.end })).sort((a, b) => a.start - b.start);
  const union: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = union.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else union.push({ ...range });
  }
  return {
    gate,
    candidates,
    stats: {
      sentences: input.chunks.length,
      skipped: gate.skippedSentences.length,
      standalone: candidates.filter(candidate => candidate.category === 'standalone-filler').length,
      repeated: candidates.filter(candidate => candidate.category === 'repeated-word').length,
      durationSeconds: round(union.reduce((sum, range) => sum + range.end - range.start, 0)),
    },
  };
}
