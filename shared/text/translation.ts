// F-0031: semantic sentence grouping, context-aware batching, strict validation, and line/speed limits.

export interface TranslationSourceCue {
  id: string;
  text: string;
  timestamp?: [number, number];
}

export interface TranslationSemanticGroup {
  id: string;
  sentence: string;
  itemIds: string[];
  items: Array<{ id: string; text: string }>;
}

export interface TranslationContextItem {
  id?: string;
  text: string;
}

export interface TranslationBatch {
  id: string;
  index: number;
  items: Array<{ id: string; text: string }>;
  semanticGroups: Array<{ sentence: string; itemIds: string[] }>;
  contextBefore: TranslationContextItem[];
  contextAfter: TranslationContextItem[];
}

export interface TranslationGroupingOptions {
  pauseThresholdSec?: number;
  maxCuesPerSentence?: number;
  maxCharsPerSentence?: number;
}

export interface TranslationBatchOptions extends TranslationGroupingOptions {
  maxItems?: number;
  maxChars?: number;
  contextWindow?: number;
}

export interface TranslationLimits {
  maxCharsPerLine: number;
  maxCps: number;
}

export interface TranslationConstraintResult {
  tooLong: boolean;
  exceedsLineLength: boolean;
  exceedsReadingSpeed: boolean;
  maxLineChars: number;
  totalChars: number;
  durationSec: number;
  cps: number;
}

export const DEFAULT_TRANSLATION_LIMITS: TranslationLimits = {
  maxCharsPerLine: 42,
  maxCps: 20,
};

const SENTENCE_ENDER_RE = /[。！？.!?…；;]["'”’）)\]]*\s*$/;

export function joinSemanticCueTexts(parts: readonly string[]): string {
  let out = '';
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const lastChar = out[out.length - 1];
    const firstChar = part[0];
    const needsSpace = /[A-Za-z0-9,;:\])]$/.test(lastChar) && /^[A-Za-z0-9([]/.test(firstChar);
    out += needsSpace ? ` ${part}` : part;
  }
  return out;
}

/**
 * Merge adjacent subtitle cues into semantic sentences so spoken phrases split across cues
 * are translated with full sentence context while retaining per-cue IDs.
 */
export function groupTranslationSentences(
  cues: readonly TranslationSourceCue[],
  options: TranslationGroupingOptions = {},
): TranslationSemanticGroup[] {
  const pauseThresholdSec = options.pauseThresholdSec ?? 1.2;
  const maxCuesPerSentence = options.maxCuesPerSentence ?? 6;
  const maxCharsPerSentence = options.maxCharsPerSentence ?? 220;

  const nonEmpty = cues.filter((cue) => cue.text.trim() !== '');
  if (!nonEmpty.length) return [];

  const groups: TranslationSemanticGroup[] = [];
  let current: TranslationSourceCue[] = [];
  let currentChars = 0;

  const flush = () => {
    if (!current.length) return;
    const items = current.map((cue) => ({ id: cue.id, text: cue.text }));
    groups.push({
      id: `sentence-${groups.length + 1}`,
      sentence: joinSemanticCueTexts(current.map((cue) => cue.text)),
      itemIds: items.map((item) => item.id),
      items,
    });
    current = [];
    currentChars = 0;
  };

  for (const cue of nonEmpty) {
    const trimmed = cue.text.trim();
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const hasLongPause =
        Boolean(prev.timestamp && cue.timestamp) &&
        cue.timestamp![0] - prev.timestamp![1] >= pauseThresholdSec;
      const hitsLimits =
        current.length >= maxCuesPerSentence ||
        currentChars + trimmed.length > maxCharsPerSentence;
      if (hasLongPause || hitsLimits) flush();
    }

    current.push(cue);
    currentChars += trimmed.length;

    if (SENTENCE_ENDER_RE.test(trimmed)) {
      flush();
    }
  }

  flush();
  return groups;
}

/**
 * Split target cues into batches along semantic-sentence boundaries and attach
 * read-only surrounding context cues from the full ordered transcript.
 */
export function splitTranslationBatches(
  allCues: readonly TranslationSourceCue[],
  targetIds?: ReadonlySet<string> | readonly string[],
  options: TranslationBatchOptions = {},
): TranslationBatch[] {
  const maxItems = Math.max(1, options.maxItems ?? 25);
  const maxChars = Math.max(1, options.maxChars ?? 2400);
  const contextWindow = Math.max(0, options.contextWindow ?? 3);

  const active = allCues.filter((cue) => cue.text.trim() !== '');
  if (!active.length) return [];

  const targetSet = targetIds === undefined
    ? new Set(active.map((cue) => cue.id))
    : targetIds instanceof Set
      ? targetIds
      : new Set(targetIds);

  if (targetSet.size === 0) return [];

  const indexById = new Map(active.map((cue, index) => [cue.id, index]));
  const semanticGroups = groupTranslationSentences(active, options);

  interface GroupSlice {
    sentence: string;
    items: Array<{ id: string; text: string }>;
    chars: number;
  }

  const slices: GroupSlice[] = [];
  for (const group of semanticGroups) {
    const groupTargets = group.items.filter((item) => targetSet.has(item.id));
    if (!groupTargets.length) continue;
    slices.push({
      sentence: group.sentence,
      items: groupTargets,
      chars: groupTargets.reduce((sum, item) => sum + item.text.trim().length, 0),
    });
  }

  if (!slices.length) return [];

  const rawBatches: GroupSlice[][] = [];
  let currentSlices: GroupSlice[] = [];
  let currentItems = 0;
  let currentChars = 0;

  for (const slice of slices) {
    if (
      currentSlices.length > 0 &&
      (currentItems + slice.items.length > maxItems || currentChars + slice.chars > maxChars)
    ) {
      rawBatches.push(currentSlices);
      currentSlices = [];
      currentItems = 0;
      currentChars = 0;
    }
    currentSlices.push(slice);
    currentItems += slice.items.length;
    currentChars += slice.chars;
  }
  if (currentSlices.length > 0) rawBatches.push(currentSlices);

  return rawBatches.map((batchSlices, index) => {
    const items = batchSlices.flatMap((slice) => slice.items);
    const batchIds = new Set(items.map((item) => item.id));
    const groups = batchSlices.map((slice) => ({
      sentence: slice.sentence,
      itemIds: slice.items.map((item) => item.id),
    }));

    const beforeMap = new Map<string, TranslationContextItem>();
    const afterMap = new Map<string, TranslationContextItem>();

    if (contextWindow > 0) {
      for (const item of items) {
        const idx = indexById.get(item.id);
        if (idx === undefined) continue;
        for (let i = Math.max(0, idx - contextWindow); i < idx; i++) {
          const ctxCue = active[i];
          if (!batchIds.has(ctxCue.id) && !beforeMap.has(ctxCue.id)) {
            beforeMap.set(ctxCue.id, { id: ctxCue.id, text: ctxCue.text });
          }
        }
        for (let i = idx + 1; i <= Math.min(active.length - 1, idx + contextWindow); i++) {
          const ctxCue = active[i];
          if (!batchIds.has(ctxCue.id) && !afterMap.has(ctxCue.id)) {
            afterMap.set(ctxCue.id, { id: ctxCue.id, text: ctxCue.text });
          }
        }
      }
    }

    const maxContext = Math.max(contextWindow, contextWindow * 2);
    const contextBefore = [...beforeMap.values()].slice(0, maxContext);
    const contextAfter = [...afterMap.values()].slice(0, maxContext);

    return {
      id: `batch-${index + 1}`,
      index,
      items,
      semanticGroups: groups,
      contextBefore,
      contextAfter,
    };
  });
}

/**
 * Strict batch validation: every requested cue ID must appear exactly once with a
 * non-empty string translation (when source is non-empty). Missing, extra, duplicate,
 * or empty entries fail the entire batch and never fall back to source text.
 */
export function validateTranslationResults(
  requested: readonly { id: string; text: string }[],
  parsed: unknown,
): Array<{ id: string; text: string }> {
  if (!Array.isArray(parsed)) {
    throw new Error('翻译结果无效（Invalid translation result）：AI 返回内容不是数组');
  }

  const expected = new Set(requested.map((item) => item.id));
  if (expected.size !== requested.length) {
    throw new Error('翻译结果无效（Invalid translation result）：请求包含重复的字幕 ID');
  }

  const texts = new Map<string, string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];
  const empty: string[] = [];

  for (const entry of parsed) {
    const raw = entry && typeof entry === 'object' ? (entry as { id?: unknown; text?: unknown }) : {};
    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
    if (!expected.has(id)) {
      unknown.push(id || '(无 id)');
      continue;
    }
    if (texts.has(id)) {
      duplicate.push(id);
      continue;
    }
    texts.set(id, typeof raw.text === 'string' ? raw.text : '');
  }

  const missing = requested.filter((item) => !texts.has(item.id)).map((item) => item.id);
  for (const item of requested) {
    const translated = texts.get(item.id);
    if (translated !== undefined && !translated.trim() && item.text.trim()) {
      empty.push(item.id);
    }
  }

  const problems = [
    missing.length && `缺少 ${missing.length} 条（id: ${missing.slice(0, 5).join(', ')}）`,
    duplicate.length && `重复 ${duplicate.length} 条（id: ${duplicate.slice(0, 5).join(', ')}）`,
    unknown.length && `多出 ${unknown.length} 条未知 id（${unknown.slice(0, 5).join(', ')}）`,
    empty.length && `空文本 ${empty.length} 条（id: ${empty.slice(0, 5).join(', ')}）`,
  ].filter(Boolean);

  if (problems.length) {
    throw new Error(`翻译结果无效（Invalid translation result）：${problems.join('；')}`);
  }

  return requested.map((item) => ({ id: item.id, text: texts.get(item.id)! }));
}

export function evaluateTranslationConstraints(
  text: string,
  timestamp?: [number, number],
  limits: TranslationLimits = DEFAULT_TRANSLATION_LIMITS,
): TranslationConstraintResult {
  const trimmed = text.trim();
  const lines = trimmed ? trimmed.split(/\r?\n/) : [];
  const maxLineChars = lines.reduce((max, line) => Math.max(max, [...line.trim()].length), 0);
  const totalChars = [...trimmed.replace(/\r?\n/g, '')].length;
  const durationSec = timestamp && timestamp[1] > timestamp[0] ? timestamp[1] - timestamp[0] : 0;
  const cps = durationSec > 0 ? totalChars / durationSec : 0;
  const exceedsLineLength = limits.maxCharsPerLine > 0 && maxLineChars > limits.maxCharsPerLine;
  const exceedsReadingSpeed = limits.maxCps > 0 && durationSec > 0 && cps > limits.maxCps;
  return {
    tooLong: exceedsLineLength || exceedsReadingSpeed,
    exceedsLineLength,
    exceedsReadingSpeed,
    maxLineChars,
    totalChars,
    durationSec,
    cps,
  };
}
