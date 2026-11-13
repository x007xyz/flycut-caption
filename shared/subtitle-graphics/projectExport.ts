import { projectFromKept, type Cue } from '../editing/edl';
import { DEFAULT_SUBTITLE_FONT_ID, resolveSubtitleFontFamily } from './fonts';
import {
  emptySubtitleGraphicStyle,
  type SubtitleDisplayMode,
  type SubtitleGraphicCue,
  type SubtitleGraphicScene,
  type SubtitleGraphicStyle,
  type SubtitleGraphicWord,
} from './scene';
import { mapCueWordRanges } from './layout';
import { stripSubtitleDisplayPunctuation } from './text';

export interface ExportableChunk {
  id: string;
  text: string;
  secondText?: string;
  timestamp: [number, number];
  deleted?: boolean;
  isBlankSpacer?: boolean;
  sentenceId?: string;
  wordIds?: string[];
}

export interface ExportStyleConfig extends SubtitleGraphicStyle {
  aspectPreset?: string;
}

export interface ExportStylePair {
  primary: ExportStyleConfig;
  secondary: ExportStyleConfig;
}

const MAX_WIDTH_RATIO_BY_ASPECT: Record<string, number> = {
  landscape: 0.9,
  portrait_9_16: 0.85,
  square_1_1: 0.88,
};

export function defaultExportStylePair(): ExportStylePair {
  const primary: ExportStyleConfig = { ...emptySubtitleGraphicStyle(DEFAULT_SUBTITLE_FONT_ID), aspectPreset: 'landscape' };
  const secondary: ExportStyleConfig = { ...primary, fontSizeRatio: primary.fontSizeRatio * 0.75 };
  return { primary, secondary };
}

function mergeStyleLayer(base: ExportStyleConfig, raw: Record<string, unknown> | undefined): ExportStyleConfig {
  if (!raw) return { ...base };
  const next: ExportStyleConfig = { ...base, ...(raw as Partial<ExportStyleConfig>) };
  next.fontId = typeof next.fontId === 'string' && next.fontId ? next.fontId : base.fontId;
  next.fontFamily = resolveSubtitleFontFamily(next.fontId);
  return next;
}

/** Resolves the effective style pair for a project video without browser/UI dependencies. */
export function resolveProjectExportStylePair(
  styleSource: 'project' | 'custom',
  edits: { stylePair?: Record<string, unknown>; aspectPreset?: string } | undefined,
  projectStyle: { primary?: Record<string, unknown>; secondary?: Record<string, unknown> } | undefined,
): ExportStylePair {
  const defaults = defaultExportStylePair();
  const rawOwn = styleSource === 'custom' ? edits?.stylePair as { primary?: Record<string, unknown>; secondary?: Record<string, unknown> } | undefined : undefined;
  const rawBase = rawOwn?.primary && rawOwn?.secondary ? rawOwn : projectStyle;
  const primary = mergeStyleLayer(defaults.primary, rawBase?.primary);
  const secondary = mergeStyleLayer(defaults.secondary, rawBase?.secondary);
  const savedAspect = edits?.aspectPreset ?? (typeof rawOwn?.primary?.aspectPreset === 'string' ? rawOwn.primary.aspectPreset : undefined);
  if (savedAspect) primary.aspectPreset = savedAspect;
  return { primary, secondary };
}

function toGraphicStyle(style: ExportStyleConfig): SubtitleGraphicStyle {
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
    visible: style.visible,
  };
}

function wordsForChunk(
  chunk: ExportableChunk,
  wordChunks: ExportableChunk[] | undefined,
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

function toGraphicCue(chunk: ExportableChunk, words?: SubtitleGraphicWord[]): SubtitleGraphicCue | undefined {
  const start = Math.max(0, chunk.timestamp[0]);
  const end = Math.max(0, chunk.timestamp[1]);
  if (!(end > start)) return undefined;
  const text = stripSubtitleDisplayPunctuation(chunk.text ?? '');
  const secondText = stripSubtitleDisplayPunctuation(chunk.secondText ?? '');
  if (!text && !secondText) return undefined;
  const cue: SubtitleGraphicCue = { id: chunk.id, start, end, text, secondText: secondText || undefined, words };
  if (words && !mapCueWordRanges(cue)) delete cue.words;
  return cue;
}

export function buildProjectExportSubtitleScene(input: {
  chunks: ExportableChunk[];
  wordChunks?: ExportableChunk[];
  hasWordTimestamps?: boolean;
  keptSegments: Array<{ start: number; end: number; keep: boolean }>;
  stylePair: ExportStylePair;
  displayMode?: SubtitleDisplayMode;
  videoWidth: number;
  videoHeight: number;
  fps?: number;
  duration: number;
}): SubtitleGraphicScene {
  const active = input.chunks
    .filter(chunk => !chunk.deleted && !chunk.isBlankSpacer)
    .map(chunk => ({
      ...chunk,
      text: stripSubtitleDisplayPunctuation(chunk.text ?? ''),
      secondText: chunk.secondText ? stripSubtitleDisplayPunctuation(chunk.secondText) : chunk.secondText,
    }))
    .filter(chunk => chunk.text.trim() || chunk.secondText?.trim());
  const projected = projectFromKept(active as unknown as Cue[], input.keptSegments) as unknown as ExportableChunk[];
  const wordInputs = active.flatMap(chunk => {
    const words = wordsForChunk(chunk, input.wordChunks, input.hasWordTimestamps === true);
    return words?.map((word, index) => ({
      id: `${chunk.id}:word:${index}`,
      text: word.text,
      timestamp: [word.start, word.end] as [number, number],
      sentenceId: chunk.id,
    })) ?? [];
  });
  const projectedWords = projectFromKept(wordInputs as unknown as Cue[], input.keptSegments) as unknown as ExportableChunk[];
  const wordsBySentence = new Map<string, SubtitleGraphicWord[]>();
  for (const word of projectedWords) {
    const suffix = word.id.slice(word.id.lastIndexOf('@') + 1);
    const key = `${word.sentenceId ?? ''}\0${suffix}`;
    const list = wordsBySentence.get(key) ?? [];
    list.push({ text: word.text, start: word.timestamp[0], end: word.timestamp[1] });
    wordsBySentence.set(key, list);
  }
  const cues = projected
    .map(chunk => {
      const marker = chunk.id.lastIndexOf('@');
      const sourceId = marker < 0 ? chunk.id : chunk.id.slice(0, marker);
      const suffix = marker < 0 ? '' : chunk.id.slice(marker + 1);
      return toGraphicCue(chunk, wordsBySentence.get(`${sourceId}\0${suffix}`));
    })
    .filter((cue): cue is SubtitleGraphicCue => Boolean(cue))
    .sort((a, b) => a.start - b.start);
  const primary = toGraphicStyle(input.stylePair.primary);
  const secondary = toGraphicStyle(input.stylePair.secondary);
  const width = Math.max(2, Math.round(input.videoWidth || 1920));
  const height = Math.max(2, Math.round(input.videoHeight || 1080));
  const duration = Math.max(0, input.duration || Math.max(0, ...cues.map(cue => cue.end), 0));
  const maxWidthRatio = MAX_WIDTH_RATIO_BY_ASPECT[input.stylePair.primary.aspectPreset ?? 'landscape'] ?? 0.9;
  return {
    version: 1,
    width,
    height,
    fps: Math.max(0.1, input.fps ?? 30),
    duration,
    fontId: primary.fontId,
    fontFamily: primary.fontFamily,
    displayMode: input.displayMode ?? 'Bilingual',
    maxWidthRatio,
    primary,
    secondary,
    cues,
  };
}

function clockParts(seconds: number, scale: number) {
  const units = Math.floor(seconds * scale + 1e-7);
  const whole = Math.floor(units / scale);
  return { hours: Math.floor(whole / 3600), minutes: Math.floor(whole % 3600 / 60), seconds: whole % 60, fraction: units % scale };
}

function formatTime(seconds: number, sep: ',' | '.'): string {
  const p = clockParts(seconds, 1000);
  return `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}:${String(p.seconds).padStart(2, '0')}${sep}${String(p.fraction).padStart(3, '0')}`;
}

function formatAssTime(seconds: number): string {
  const p = clockParts(seconds, 100);
  return `${p.hours}:${String(p.minutes).padStart(2, '0')}:${String(p.seconds).padStart(2, '0')}.${String(p.fraction).padStart(2, '0')}`;
}

function representable(chunk: ExportableChunk, scale: number): boolean {
  const [a, b] = chunk.timestamp;
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a
    && Math.floor(b * scale + 1e-7) > Math.floor(a * scale + 1e-7);
}

function chunkBody(chunk: ExportableChunk, exportMode: SubtitleDisplayMode): string {
  if (exportMode === 'Main') return chunk.text;
  if (exportMode === 'Second') return chunk.secondText?.trim() ? chunk.secondText : '';
  return chunk.secondText?.trim() ? `${chunk.text}\n${chunk.secondText}` : chunk.text;
}

export function serializeProjectSubtitles(
  format: 'srt' | 'vtt' | 'json' | 'ass',
  chunks: ExportableChunk[],
  keptSegments: Array<{ start: number; end: number; keep: boolean }>,
  exportMode: SubtitleDisplayMode = 'Bilingual',
  stylePair: ExportStylePair = defaultExportStylePair(),
): string {
  const active = chunks
    .filter(c => !c.deleted && !c.isBlankSpacer)
    .map(c => ({
      ...c,
      text: stripSubtitleDisplayPunctuation(c.text ?? ''),
      secondText: c.secondText ? stripSubtitleDisplayPunctuation(c.secondText) : c.secondText,
    }))
    .filter(c => c.text.trim() || c.secondText?.trim());
  const projected = projectFromKept(active as unknown as Cue[], keptSegments) as unknown as ExportableChunk[];
  if (format === 'json') {
    const rows = projected.map(chunk => {
      if (exportMode === 'Main') return chunk.text?.trim() ? { text: chunk.text, timestamp: chunk.timestamp } : null;
      if (exportMode === 'Second') return chunk.secondText?.trim() ? { text: chunk.secondText, timestamp: chunk.timestamp } : null;
      return chunk.text?.trim() || chunk.secondText?.trim() ? { text: chunk.text, secondText: chunk.secondText, timestamp: chunk.timestamp } : null;
    }).filter(Boolean);
    return JSON.stringify(rows, null, 2);
  }
  if (format === 'vtt') {
    const lines = ['WEBVTT', ''];
    let index = 0;
    for (const chunk of projected) {
      if (!representable(chunk, 1000)) continue;
      const body = chunkBody(chunk, exportMode);
      if (!body.trim()) continue;
      index += 1;
      lines.push(String(index), `${formatTime(chunk.timestamp[0], '.')} --> ${formatTime(chunk.timestamp[1], '.')}`, body, '');
    }
    return lines.join('\n');
  }
  if (format === 'srt') {
    let index = 0;
    return projected
      .filter(c => representable(c, 1000))
      .map(chunk => {
        const body = chunkBody(chunk, exportMode);
        if (!body.trim()) return null;
        index += 1;
        return `${index}\n${formatTime(chunk.timestamp[0], ',')} --> ${formatTime(chunk.timestamp[1], ',')}\n${body}\n`;
      })
      .filter(Boolean)
      .join('\n');
  }
  const playResX = 1920;
  const playResY = 1080;
  const hexToAss = (hex: string, opacity = 1) => {
    const n = hex.replace('#', '');
    if (n.length !== 6) return '&H00FFFFFF';
    const a = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0');
    return `&H${a}${n.slice(4, 6)}${n.slice(2, 4)}${n.slice(0, 2)}`.toUpperCase();
  };
  const styleLine = (name: string, style: ExportStyleConfig, marginV: number) => {
    const fontName = resolveSubtitleFontFamily(style.fontId);
    const fontSize = Math.round(playResY * style.fontSizeRatio);
    const borderStyle = style.backgroundOpacity > 0 ? 3 : 1;
    return `Style: ${name},${fontName},${fontSize},${hexToAss(style.color, style.colorOpacity)},&H000000FF,${hexToAss(style.borderColor, style.borderOpacity)},${hexToAss(style.backgroundColor, style.backgroundOpacity)},${style.fontWeight === 'bold' ? -1 : 0},${style.fontStyle === 'italic' ? -1 : 0},${style.textDecoration === 'underline' ? -1 : 0},0,100,100,0,0,${borderStyle},${style.borderWidth},${style.shadowBlur > 0 ? 1 : 0},2,20,20,${marginV},1`;
  };
  const marginV = Math.round(playResY * stylePair.primary.bottomOffsetRatio);
  const dialogueChunks = projected.filter(c => representable(c, 100));
  const styleLines: string[] = [];
  const events: string[] = [];
  if (exportMode === 'Second') {
    styleLines.push(styleLine('Default', stylePair.secondary, marginV));
    for (const c of dialogueChunks) if (c.secondText?.trim()) events.push(`Dialogue: 0,${formatAssTime(c.timestamp[0])},${formatAssTime(c.timestamp[1])},Default,,0,0,0,,${c.secondText.replace(/\n/g, '\\N')}`);
  } else if (exportMode === 'Main') {
    styleLines.push(styleLine('Default', stylePair.primary, marginV));
    for (const c of dialogueChunks) if (c.text?.trim()) events.push(`Dialogue: 0,${formatAssTime(c.timestamp[0])},${formatAssTime(c.timestamp[1])},Default,,0,0,0,,${c.text.replace(/\n/g, '\\N')}`);
  } else {
    const secSize = Math.round(playResY * stylePair.secondary.fontSizeRatio);
    const priSize = Math.round(playResY * stylePair.primary.fontSizeRatio);
    const gap = Math.max(2, Math.round(priSize * 0.15));
    const priMarginV = marginV + Math.round(secSize * stylePair.secondary.lineHeight) + gap;
    styleLines.push(styleLine('Secondary', stylePair.secondary, marginV), styleLine('Primary', stylePair.primary, priMarginV));
    for (const c of dialogueChunks) {
      if (c.secondText?.trim()) events.push(`Dialogue: 0,${formatAssTime(c.timestamp[0])},${formatAssTime(c.timestamp[1])},Secondary,,0,0,0,,${c.secondText.replace(/\n/g, '\\N')}`);
      if (c.text?.trim()) events.push(`Dialogue: 1,${formatAssTime(c.timestamp[0])},${formatAssTime(c.timestamp[1])},Primary,,0,0,0,,${c.text.replace(/\n/g, '\\N')}`);
    }
  }
  return ['[Script Info]', 'Title: FlyCut Caption', 'ScriptType: v4.00+', `PlayResX: ${playResX}`, `PlayResY: ${playResY}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding', ...styleLines, '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events].join('\n');
}
