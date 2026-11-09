import type { SubtitleChunk } from '@/types/subtitle';
import type { SubtitleStyle, SubtitleStylePair } from './subtitleStyle';
import type { SubtitleDisplayMode } from './subtitleRenderer';
import { defaultSubtitleStylePair, getStyleFontFamily } from './subtitleStyle';
import { REFERENCE_VIDEO_HEIGHT } from '@/config/subtitleFonts';
import { stripSubtitleDisplayPunctuation } from './cjkPunctuation';

export type SubtitleExportFormat = 'srt' | 'json' | 'vtt' | 'ass';

function clockParts(seconds: number, scale: number) {
  const units = Math.floor(seconds * scale + 1e-7);
  const whole = Math.floor(units / scale);
  return { hours: Math.floor(whole / 3600), minutes: Math.floor(whole % 3600 / 60), seconds: whole % 60, fraction: units % scale };
}
function formatSrtTime(seconds: number): string {
  const p = clockParts(seconds, 1000);
  return `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}:${String(p.seconds).padStart(2, '0')},${String(p.fraction).padStart(3, '0')}`;
}
function formatVttTime(seconds: number): string { return formatSrtTime(seconds).replace(',', '.'); }
function formatAssTime(seconds: number): string {
  const p = clockParts(seconds, 100);
  return `${p.hours}:${String(p.minutes).padStart(2, '0')}:${String(p.seconds).padStart(2, '0')}.${String(p.fraction).padStart(2, '0')}`;
}
function representable(chunk: SubtitleChunk, scale: number): boolean {
  const [a, b] = chunk.timestamp;
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a
    && Math.floor(b * scale + 1e-7) > Math.floor(a * scale + 1e-7);
}

/**
 * 按 exportMode 提取字幕正文。
 * - 'Main'：仅主字幕 text
 * - 'Second'：仅副字幕 secondText（无则返回空串，调用方应跳过）
 * - 'Bilingual'：主+副（用 \n 分隔），无副字幕时仅主
 */
function chunkBody(chunk: SubtitleChunk, exportMode: SubtitleDisplayMode): string {
  if (exportMode === 'Main') {
    return chunk.text;
  }
  if (exportMode === 'Second') {
    return chunk.secondText?.trim() ? chunk.secondText : '';
  }
  // Bilingual
  if (chunk.secondText?.trim()) {
    return `${chunk.text}\n${chunk.secondText}`;
  }
  return chunk.text;
}

/** #RRGGBB → ASS &HAABBGGRR */
function hexToAssColor(hex: string, opacity = 1): string {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return '&H00FFFFFF';
  const alpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0');
  const r = normalized.slice(0, 2);
  const g = normalized.slice(2, 4);
  const b = normalized.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/** 构建 ASS V4+ Style 行 */
function buildAssStyleLine(
  name: string,
  style: SubtitleStyle,
  playResY: number,
  marginV: number,
): string {
  // ASS Style 行以逗号分隔字段，Fontname 不能含逗号；取 CSS font-family 首个 family，
  // 去除引号与 fallback（如 "Noto Sans SC, sans-serif" → Noto Sans SC），否则字段错位导致 libass 样式失效。
  const fontName = getStyleFontFamily(style).split(',')[0].replace(/"/g, '').trim();
  const fontSize = Math.round(playResY * style.fontSizeRatio);
  const primaryColour = hexToAssColor(style.color, style.colorOpacity);
  const outlineColour = hexToAssColor(style.borderColor, style.borderOpacity);
  const backColour = hexToAssColor(style.backgroundColor, style.backgroundOpacity);
  const bold = style.fontWeight === 'bold' ? -1 : 0;
  const italic = style.fontStyle === 'italic' ? -1 : 0;
  const underline = style.textDecoration === 'underline' ? -1 : 0;
  const outline = style.borderWidth;
  const shadow = style.shadowBlur > 0 ? 1 : 0;
  // BorderStyle 3 = 不透明底框（使用 BackColour）；1 = 描边+阴影
  const borderStyle = style.backgroundOpacity > 0 ? 3 : 1;
  return `Style: ${name},${fontName},${fontSize},${primaryColour},&H000000FF,${outlineColour},${backColour},${bold},${italic},${underline},0,100,100,0,0,${borderStyle},${outline},${shadow},2,20,20,${marginV},1`;
}

export function chunksToSrt(chunks: SubtitleChunk[], exportMode: SubtitleDisplayMode = 'Bilingual'): string {
  let index = 0;
  return chunks
    .filter((c) => !c.deleted && representable(c, 1000))
    .map((chunk) => {
      const body = chunkBody(chunk, exportMode);
      if (!body.trim()) return null;
      index += 1;
      const start = formatSrtTime(chunk.timestamp[0]);
      const end = formatSrtTime(chunk.timestamp[1]);
      return `${index}\n${start} --> ${end}\n${body}\n`;
    })
    .filter(Boolean)
    .join('\n');
}

export function chunksToVtt(chunks: SubtitleChunk[], exportMode: SubtitleDisplayMode = 'Bilingual'): string {
  const lines = ['WEBVTT', ''];
  let index = 0;
  chunks
    .filter((c) => !c.deleted && representable(c, 1000))
    .forEach((chunk) => {
      const body = chunkBody(chunk, exportMode);
      if (!body.trim()) return;
      index += 1;
      lines.push(String(index));
      lines.push(`${formatVttTime(chunk.timestamp[0])} --> ${formatVttTime(chunk.timestamp[1])}`);
      lines.push(body);
      lines.push('');
    });
  return lines.join('\n');
}

export function chunksToJson(chunks: SubtitleChunk[], exportMode: SubtitleDisplayMode = 'Bilingual'): string {
  const kept = chunks
    .filter((c) => !c.deleted)
    .map((chunk) => {
      if (exportMode === 'Main') {
        if (!chunk.text?.trim()) return null;
        return { text: chunk.text, timestamp: chunk.timestamp };
      }
      if (exportMode === 'Second') {
        if (!chunk.secondText?.trim()) return null;
        return { text: chunk.secondText, timestamp: chunk.timestamp };
      }
      // Bilingual
      if (!chunk.text?.trim() && !chunk.secondText?.trim()) return null;
      return {
        text: chunk.text,
        secondText: chunk.secondText,
        timestamp: chunk.timestamp,
      };
    })
    .filter(Boolean);
  return JSON.stringify(kept, null, 2);
}

export interface AssExportOptions {
  playResX: number;
  playResY: number;
  stylePair: SubtitleStylePair;
  exportMode?: SubtitleDisplayMode;
  title?: string;
  /** 软烧录（mov_text）：Bilingual 降级为单样式合并文本，避免重叠 Dialogue 导致时长被截断 */
  softSubtitle?: boolean;
}

export function chunksToAss(chunks: SubtitleChunk[], options: AssExportOptions): string {
  const { playResX, playResY, stylePair, exportMode = 'Bilingual', title = 'FlyCut Caption', softSubtitle = false } = options;
  const primary = stylePair.primary;
  const secondary = stylePair.secondary;
  const primaryMarginV = Math.round(playResY * primary.bottomOffsetRatio);
  const dialogueChunks = chunks.filter((c) => !c.deleted && representable(c, 100));

  const styleLines: string[] = [];
  const events: string[] = [];

  if (exportMode === 'Second') {
    // 单样式：副字幕样式，位置共享 primary 底边距
    styleLines.push(buildAssStyleLine('Default', secondary, playResY, primaryMarginV));
    for (const chunk of dialogueChunks) {
      if (!chunk.secondText?.trim()) continue;
      const start = formatAssTime(chunk.timestamp[0]);
      const end = formatAssTime(chunk.timestamp[1]);
      const text = chunk.secondText.replace(/\n/g, '\\N');
      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
    }
  } else if (exportMode === 'Main') {
    styleLines.push(buildAssStyleLine('Default', primary, playResY, primaryMarginV));
    for (const chunk of dialogueChunks) {
      if (!chunk.text?.trim()) continue;
      const start = formatAssTime(chunk.timestamp[0]);
      const end = formatAssTime(chunk.timestamp[1]);
      const text = chunk.text.replace(/\n/g, '\\N');
      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
    }
  } else if (softSubtitle) {
    // 软烧录（mov_text）不支持重叠事件/双 layer：Bilingual 降级为单样式合并文本，
    // 否则同时间的 Primary/Secondary 两条 Dialogue 会让 mov_text 把 Primary 截成 0 时长。
    styleLines.push(buildAssStyleLine('Default', primary, playResY, primaryMarginV));
    for (const chunk of dialogueChunks) {
      if (!chunk.text?.trim()) continue;
      const start = formatAssTime(chunk.timestamp[0]);
      const end = formatAssTime(chunk.timestamp[1]);
      const parts = [chunk.text.replace(/\n/g, '\\N')];
      if (chunk.secondText?.trim()) {
        parts.push(chunk.secondText.replace(/\n/g, '\\N'));
      }
      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${parts.join('\\N')}`);
    }
  } else {
    // Bilingual 硬烧录：与预览一致（主字幕在上、副字幕在下），底边距由 primary 决定
    const secondaryFontSize = Math.round(playResY * secondary.fontSizeRatio);
    const primaryFontSize = Math.round(playResY * primary.fontSizeRatio);
    const gap = Math.max(2, Math.round(primaryFontSize * 0.15));
    // Alignment=2 时 MarginV 越大越靠上：副字幕贴底，主字幕叠在副字幕上方
    const secondaryMarginV = primaryMarginV;
    const primaryAboveMarginV =
      secondaryMarginV + Math.round(secondaryFontSize * secondary.lineHeight) + gap;

    styleLines.push(buildAssStyleLine('Secondary', secondary, playResY, secondaryMarginV));
    styleLines.push(buildAssStyleLine('Primary', primary, playResY, primaryAboveMarginV));

    for (const chunk of dialogueChunks) {
      if (!chunk.text?.trim() && !chunk.secondText?.trim()) continue;
      const start = formatAssTime(chunk.timestamp[0]);
      const end = formatAssTime(chunk.timestamp[1]);
      // Secondary（layer 0，底部）
      if (chunk.secondText?.trim()) {
        events.push(`Dialogue: 0,${start},${end},Secondary,,0,0,0,,${chunk.secondText.replace(/\n/g, '\\N')}`);
      }
      // Primary（layer 1，上方）
      if (chunk.text?.trim()) {
        events.push(`Dialogue: 1,${start},${end},Primary,,0,0,0,,${chunk.text.replace(/\n/g, '\\N')}`);
      }
    }
  }

  const header = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  return [...header, ...events].join('\n');
}

export function getExportFilename(format: SubtitleExportFormat): string {
  return `subtitles_${Date.now()}.${format}`;
}

export function getExportMimeType(format: SubtitleExportFormat): string {
  switch (format) {
    case 'json':
      return 'application/json';
    case 'vtt':
      return 'text/vtt';
    case 'ass':
      return 'text/plain';
    default:
      return 'text/plain';
  }
}

export interface SerializeExportOptions {
  ass?: AssExportOptions;
  /** 导出内容模式：主/副/双语，默认 Bilingual */
  exportMode?: SubtitleDisplayMode;
}

/** 去掉字幕文本标点，用于导出的字幕文件（不影响编辑器原文与 ASR 结果）。 */
function stripChunksPunctuation(chunks: SubtitleChunk[]): SubtitleChunk[] {
  return chunks.map((c) => ({
    ...c,
    text: stripSubtitleDisplayPunctuation(c.text ?? ''),
    secondText: c.secondText
      ? stripSubtitleDisplayPunctuation(c.secondText)
      : c.secondText,
  }));
}

export function serializeSubtitleExport(
  format: SubtitleExportFormat,
  chunks: SubtitleChunk[],
  options?: SerializeExportOptions,
): string {
  const exportMode = options?.exportMode ?? 'Bilingual';
  const exportChunks = stripChunksPunctuation(chunks);
  switch (format) {
    case 'srt':
      return chunksToSrt(exportChunks, exportMode);
    case 'vtt':
      return chunksToVtt(exportChunks, exportMode);
    case 'json':
      return chunksToJson(exportChunks, exportMode);
    case 'ass':
      return chunksToAss(exportChunks, options?.ass ?? {
        playResX: 1920,
        playResY: REFERENCE_VIDEO_HEIGHT,
        stylePair: defaultSubtitleStylePair,
        exportMode,
      });
    default:
      return chunksToSrt(exportChunks, exportMode);
  }
}

export function getExportFileTypes(format: SubtitleExportFormat): Array<{
  description: string;
  accept: Record<string, string[]>;
}> {
  const map: Record<SubtitleExportFormat, Record<string, string[]>> = {
    srt: { 'text/srt': ['.srt'] },
    json: { 'application/json': ['.json'] },
    vtt: { 'text/vtt': ['.vtt'] },
    ass: { 'text/plain': ['.ass'] },
  };
  const labels: Record<SubtitleExportFormat, string> = {
    srt: 'SRT Subtitle files',
    json: 'JSON files',
    vtt: 'WebVTT files',
    ass: 'ASS/SSA subtitle files',
  };
  return [{ description: labels[format], accept: map[format] }];
}
