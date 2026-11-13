import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoSegment } from '@/types/video';
import { projectFromKept } from '../../shared/editing/edl';
import {
  emptySubtitleGraphicStyle,
  mapCueWordRanges,
  resolveSubtitleFontFamily,
  mapRawRangesToDisplay,
  stripSubtitleDisplayPunctuation,
  type SubtitleDisplayMode,
  type SubtitleGraphicCue,
  type SubtitleGraphicKeyword,
  type SubtitleGraphicScene,
  type SubtitleGraphicStyle,
  type SubtitleGraphicWord,
} from '../../shared/subtitle-graphics';
import { getMaxWidthRatio } from './subtitlePresets';
import type { SubtitleStyle, SubtitleStylePair } from './subtitleStyle';

export function toGraphicStyle(style: SubtitleStyle): SubtitleGraphicStyle {
  const base = emptySubtitleGraphicStyle(style.fontId);
  return {
    ...base,
    fontId: style.fontId,
    fontFamily: resolveSubtitleFontFamily(style.fontId),
    fontSizeRatio: style.fontSizeRatio,
    bottomOffsetRatio: style.bottomOffsetRatio,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    textDecoration: style.textDecoration,
    color: style.color,
    colorOpacity: style.colorOpacity,
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderOpacity: style.borderOpacity,
    shadowColor: style.shadowColor,
    textAlign: style.textAlign,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    borderWidth: style.borderWidth,
    shadowOffsetX: style.shadowOffsetX,
    shadowOffsetY: style.shadowOffsetY,
    shadowBlur: style.shadowBlur,
    backgroundOpacity: style.backgroundOpacity,
    backgroundRadius: style.backgroundRadius,
    backgroundPadding: style.backgroundPadding,
    wordHighlightMode: style.wordHighlightMode ?? 'none',
    wordHighlightColor: style.wordHighlightColor ?? '#FFE100',
    keywordColorEnabled: style.keywordColorEnabled ?? true,
    keywordColor: style.keywordColor ?? '#FFE100',
    keywordScale: style.keywordScale ?? 1.2,
    keywordBackgroundColor: style.keywordBackgroundColor ?? '#FF5B57',
    keywordBackgroundOpacity: style.keywordBackgroundOpacity ?? 0,
    visible: style.visible,
  };
}

interface SceneInput {
  chunks: SubtitleChunk[];
  wordChunks?: SubtitleChunk[];
  hasWordTimestamps?: boolean;
  stylePair: SubtitleStylePair;
  displayMode?: SubtitleDisplayMode;
  videoWidth: number;
  videoHeight: number;
  fps?: number;
  duration: number;
}

function displayText(text: string | undefined): string {
  return stripSubtitleDisplayPunctuation(text ?? '');
}

function sceneShell(input: SceneInput, cues: SubtitleGraphicCue[]): SubtitleGraphicScene {
  const primary = toGraphicStyle(input.stylePair.primary);
  const secondary = toGraphicStyle(input.stylePair.secondary);
  const width = Math.max(2, Math.round(input.videoWidth || 1920));
  const height = Math.max(2, Math.round(input.videoHeight || 1080));
  const duration = Math.max(0, input.duration || Math.max(0, ...cues.map((cue) => cue.end), 0));
  return {
    version: 1,
    width,
    height,
    fps: Math.max(0.1, input.fps ?? 30),
    duration,
    fontId: primary.fontId,
    fontFamily: primary.fontFamily,
    displayMode: input.displayMode ?? 'Bilingual',
    maxWidthRatio: getMaxWidthRatio(input.stylePair.primary.aspectPreset),
    primary,
    secondary,
    cues,
  };
}

function wordsForChunk(
  chunk: SubtitleChunk,
  wordChunks: SubtitleChunk[] | undefined,
  hasWordTimestamps: boolean,
): SubtitleGraphicWord[] | undefined {
  if (!hasWordTimestamps || !wordChunks?.length || !chunk.wordIds?.length) return undefined;
  const byId = new Map(wordChunks.map(word => [word.id, word]));
  const words: SubtitleGraphicWord[] = [];
  for (const id of chunk.wordIds) {
    const word = byId.get(id);
    if (!word || word.deleted || word.sentenceId !== chunk.id
      || !Number.isFinite(word.timestamp[0]) || !Number.isFinite(word.timestamp[1])
      || word.timestamp[1] <= word.timestamp[0]
      || word.timestamp[0] < chunk.timestamp[0] - 0.02 || word.timestamp[1] > chunk.timestamp[1] + 0.02) {
      return undefined;
    }
    words.push({ text: word.text, start: word.timestamp[0], end: word.timestamp[1] });
  }
  return words.length ? words : undefined;
}

function toCue(
  chunk: SubtitleChunk,
  words?: SubtitleGraphicWord[],
  keywords?: SubtitleGraphicKeyword[],
  offset = 0,
): SubtitleGraphicCue | undefined {
  const start = Math.max(0, chunk.timestamp[0] + offset);
  const end = Math.max(0, chunk.timestamp[1] + offset);
  if (!(end > start)) return undefined;
  const text = displayText(chunk.text);
  const secondText = displayText(chunk.secondText);
  if (!text && !secondText) return undefined;
  const validKeywords = keywords?.length ? keywords : undefined;
  const cue: SubtitleGraphicCue = { id: chunk.id, start, end, text, secondText: secondText || undefined, words, ...(validKeywords ? { keywords: validKeywords } : {}) };
  if (words && !mapCueWordRanges(cue)) delete cue.words;
  return cue;
}

/** 预览场景：时间轴仍是原始媒体时间，删除的片段由播放器可见性控制。 */
export function buildPreviewSubtitleScene(input: SceneInput): SubtitleGraphicScene {
  const cues = input.chunks
    .filter((chunk) => !chunk.deleted && !chunk.isBlankSpacer)
    .map((chunk) => toCue(chunk, wordsForChunk(chunk, input.wordChunks, input.hasWordTimestamps === true), mapRawRangesToDisplay(chunk.text, chunk.keywords)))
    .filter((cue): cue is SubtitleGraphicCue => Boolean(cue))
    .sort((a, b) => a.start - b.start);
  return sceneShell(input, cues);
}

/** 导出场景：先按现有 EDL 投影到成片时间轴，再交给 Host。 */
export function buildExportSubtitleScene(input: SceneInput & { keptSegments: VideoSegment[] }): SubtitleGraphicScene {
  const active = input.chunks
    .filter((chunk) => !chunk.deleted && !chunk.isBlankSpacer)
    .map((chunk) => ({
      ...chunk,
      keywords: mapRawRangesToDisplay(chunk.text, chunk.keywords),
      text: displayText(chunk.text),
      secondText: displayText(chunk.secondText),
    }))
    .filter((chunk) => chunk.text.trim() || chunk.secondText?.trim());
  const projected = projectFromKept(active, input.keptSegments);
  const projectedWords = projectFromKept(active.flatMap(chunk => {
    const words = wordsForChunk(chunk, input.wordChunks, input.hasWordTimestamps === true);
    return words?.map((word, index) => ({
      id: `${chunk.id}:word:${index}`,
      text: word.text,
      timestamp: [word.start, word.end] as [number, number],
      sentenceId: chunk.id,
    })) ?? [];
  }), input.keptSegments);
  const wordsBySentence = new Map<string, SubtitleGraphicWord[]>();
  for (const word of projectedWords) {
    const suffix = word.id.slice(word.id.lastIndexOf('@') + 1);
    const key = `${word.sentenceId ?? ''}\0${suffix}`;
    const list = wordsBySentence.get(key) ?? [];
    list.push({ text: word.text, start: word.timestamp[0], end: word.timestamp[1] });
    wordsBySentence.set(key, list);
  }
  const cues = projected
    .map((chunk) => {
      const marker = chunk.id.lastIndexOf('@');
      const sourceId = marker < 0 ? chunk.id : chunk.id.slice(0, marker);
      const suffix = marker < 0 ? '' : chunk.id.slice(marker + 1);
      return toCue({ ...chunk, id: chunk.id }, wordsBySentence.get(`${sourceId}\0${suffix}`), (chunk as SubtitleChunk).keywords);
    })
    .filter((cue): cue is SubtitleGraphicCue => Boolean(cue))
    .sort((a, b) => a.start - b.start);
  return sceneShell(input, cues);
}

/** All visible main-language cues need a verified word map; one bad sentence keeps the fallback notice visible. */
export function hasReliableWordHighlight(
  chunks: SubtitleChunk[],
  wordChunks: SubtitleChunk[] | undefined,
  hasWordTimestamps: boolean,
): boolean {
  if (!hasWordTimestamps || !wordChunks?.length) return false;
  const visible = chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer && displayText(chunk.text));
  return visible.length > 0 && visible.every((chunk) => {
    const words = wordsForChunk(chunk, wordChunks, true);
    if (!words) return false;
    const cue: SubtitleGraphicCue = {
      id: chunk.id,
      start: chunk.timestamp[0],
      end: chunk.timestamp[1],
      text: displayText(chunk.text),
      words,
    };
    return mapCueWordRanges(cue) !== undefined;
  });
}
