import { prepareWithSegments, layoutWithLines, measureNaturalWidth } from '@chenglou/pretext';
import type { SubtitleGraphicCue, SubtitleGraphicScene, SubtitleGraphicStyle, SubtitleGraphicWord } from './scene';
import { applyCjkBreakHints, fixCjkLineStarts, stripSubtitleDisplayPunctuation } from './text';

export const BLOCK_GAP_RATIO = 0.15;

export interface LayoutItem {
  text: string;
  x: number;
  width: number;
}

export interface LayoutLine {
  text: string;
  width: number;
  items: LayoutItem[];
  /** Character range in the punctuation-stripped cue text. */
  charStart?: number;
  charEnd?: number;
}

export interface LayoutBlock {
  style: SubtitleGraphicStyle;
  fontSize: number;
  lineHeight: number;
  lines: LayoutLine[];
  height: number;
}

export interface CueLayout {
  cue: SubtitleGraphicCue;
  primary?: LayoutBlock;
  secondary?: LayoutBlock;
  primaryBottom?: number;
  secondaryBottom?: number;
  primaryTop?: number;
  secondaryTop?: number;
  /** 副字幕（或唯一字幕）最后一行基线的底部位置，视频坐标 */
  bottom: number;
  /** 整条字幕最上方，视频坐标 */
  top: number;
  height: number;
  /** Present only when word text and real timestamps can be mapped without guessing. */
  wordRanges?: LayoutWordRange[];
}

export interface LayoutWordRange extends SubtitleGraphicWord {
  index: number;
  charStart: number;
  charEnd: number;
}

export function resolveVideoFontSize(style: SubtitleGraphicStyle, videoHeight: number): number {
  if (!videoHeight || videoHeight <= 0) return Math.round(1080 * style.fontSizeRatio);
  return Math.max(8, Math.round(videoHeight * style.fontSizeRatio));
}

export function resolveBottomOffset(style: SubtitleGraphicStyle, videoHeight: number): number {
  if (!videoHeight || videoHeight <= 0) return Math.round(1080 * style.bottomOffsetRatio);
  return Math.max(0, Math.round(videoHeight * style.bottomOffsetRatio));
}

export function buildCanvasFont(style: SubtitleGraphicStyle, fontSizePx: number): string {
  return `${style.fontStyle} ${style.fontWeight} ${fontSizePx}px "${style.fontFamily}"`;
}

export function resolveLayoutMaxWidth(scene: SubtitleGraphicScene): number {
  return Math.max(100, Math.round(scene.width * scene.maxWidthRatio));
}

function lineItems(ctx: CanvasRenderingContext2D, line: string, letterSpacing: number): LayoutItem[] {
  if (!line) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const items: LayoutItem[] = [];
  let x = 0;
  for (const segment of segmenter.segment(line)) {
    const text = segment.segment;
    const width = ctx.measureText(text).width;
    items.push({ text, x, width });
    x += width + (letterSpacing > 0 && !/^\s+$/.test(text) ? letterSpacing : 0);
  }
  return items;
}

function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  style: SubtitleGraphicStyle,
  fontSize: number,
  maxWidth: number,
): LayoutLine[] {
  const lines = layoutTextLines(text, style, fontSize, maxWidth);
  ctx.font = buildCanvasFont(style, fontSize);
  return lines.map((line) => ({
    ...line,
    items: lineItems(ctx, line.text, style.letterSpacing),
  }));
}

export interface TextLine {
  text: string;
  width: number;
}

/** 只依赖 Pretext 的排版结果，不要求 Canvas 上下文；src/subtitle 的旧 API 也复用它。 */
export function layoutTextLines(
  text: string,
  style: Pick<SubtitleGraphicStyle, 'fontFamily' | 'fontStyle' | 'fontWeight' | 'lineHeight' | 'letterSpacing'>,
  fontSize: number,
  maxWidth: number,
): TextLine[] {
  const displayText = stripSubtitleDisplayPunctuation(text);
  if (!displayText || maxWidth <= 0) return [];
  const font = buildCanvasFont(style as SubtitleGraphicStyle, fontSize);
  const lineHeight = fontSize * style.lineHeight;
  const paragraphs = displayText.split('\n').map((p) => p.trim()).filter(Boolean);
  const sourceParagraphs = paragraphs.length > 0 ? paragraphs : [displayText];
  const allLines: TextLine[] = [];
  for (const paragraph of sourceParagraphs) {
    const hinted = applyCjkBreakHints(paragraph);
    const prepared = prepareWithSegments(hinted, font, {
      letterSpacing: style.letterSpacing > 0 ? style.letterSpacing : undefined,
    });
    const { lines } = layoutWithLines(prepared, maxWidth, lineHeight);
    allLines.push(...lines.map((line) => ({ text: line.text.replace(/\u200b/g, ''), width: line.width })));
  }
  // fixCjkLineStarts 只移动文本，宽度在移动后重新测量，避免行首标点换行后宽度对不上。
  const fixed = fixCjkLineStarts(allLines.map((line) => line.text));
  return fixed.filter((line) => line.length > 0).map((line) => ({
    text: line,
    width: measureNaturalWidth(prepareWithSegments(line, font, {
      letterSpacing: style.letterSpacing > 0 ? style.letterSpacing : undefined,
    })),
  }));
}

function layoutBlock(
  ctx: CanvasRenderingContext2D,
  text: string | undefined,
  style: SubtitleGraphicStyle,
  scene: SubtitleGraphicScene,
): LayoutBlock | undefined {
  if (!text?.trim()) return undefined;
  const fontSize = resolveVideoFontSize(style, scene.height);
  const lines = layoutText(ctx, text, style, fontSize, resolveLayoutMaxWidth(scene));
  if (lines.length === 0) return undefined;
  const lineHeight = fontSize * style.lineHeight;
  return { style, fontSize, lineHeight, lines, height: lines.length * lineHeight };
}

const compactText = (value: string) => value.replace(/\s+/gu, '');
const wordRangeCache = new WeakMap<SubtitleGraphicCue, LayoutWordRange[] | null>();

/** Map real word chunks to visible character ranges. Any ambiguity rejects all word highlighting for the cue. */
export function mapCueWordRanges(cue: SubtitleGraphicCue): LayoutWordRange[] | undefined {
  if (!cue.words?.length) return undefined;
  if (wordRangeCache.has(cue)) return wordRangeCache.get(cue) ?? undefined;
  const displayText = stripSubtitleDisplayPunctuation(cue.text);
  const tokens: string[] = [];
  const ranges: LayoutWordRange[] = [];
  let cursor = 0;
  let previousEnd = -Infinity;
  for (const [index, word] of cue.words.entries()) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)
      || word.end <= word.start || word.start < cue.start - 0.02 || word.end > cue.end + 0.02
      || word.start < previousEnd - 0.02) {
      wordRangeCache.set(cue, null);
      return undefined;
    }
    previousEnd = word.end;
    const token = stripSubtitleDisplayPunctuation(word.text).trim();
    tokens.push(token);
    if (!token) continue;
    const charStart = displayText.indexOf(token, cursor);
    if (charStart < 0) {
      wordRangeCache.set(cue, null);
      return undefined;
    }
    const charEnd = charStart + token.length;
    ranges.push({ ...word, index, charStart, charEnd });
    cursor = charEnd;
  }
  if (!ranges.length || compactText(displayText) !== compactText(tokens.join(''))) {
    wordRangeCache.set(cue, null);
    return undefined;
  }
  wordRangeCache.set(cue, ranges);
  return ranges;
}

function assignLineRanges(lines: LayoutLine[], cueText: string): boolean {
  const source = stripSubtitleDisplayPunctuation(cueText);
  let cursor = 0;
  for (const line of lines) {
    const charStart = source.indexOf(line.text, cursor);
    if (charStart < 0) return false;
    line.charStart = charStart;
    line.charEnd = charStart + line.text.length;
    cursor = line.charEnd;
  }
  return true;
}

export function findActiveWordRange(ranges: LayoutWordRange[] | undefined, t: number): LayoutWordRange | undefined {
  if (!ranges?.length) return undefined;
  for (const range of ranges) {
    if (t < range.start) return undefined;
    if (t < range.end) return range;
  }
  return undefined;
}

export function layoutCue(
  ctx: CanvasRenderingContext2D,
  scene: SubtitleGraphicScene,
  cue: SubtitleGraphicCue,
): CueLayout {
  const showPrimary = scene.displayMode !== 'Second';
  const showSecondary = scene.displayMode !== 'Main' && Boolean(cue.secondText?.trim());
  const primary = showPrimary ? layoutBlock(ctx, cue.text, scene.primary, scene) : undefined;
  let wordRanges = mapCueWordRanges(cue);
  if (wordRanges && primary && !assignLineRanges(primary.lines, cue.text)) wordRanges = undefined;
  const secondary = showSecondary && scene.secondary
    ? layoutBlock(ctx, cue.secondText, scene.secondary, scene)
    : undefined;
  const bottom = scene.height - resolveBottomOffset(scene.primary, scene.height);
  const secondaryBottom = bottom;
  const gap = secondary ? secondary.fontSize * BLOCK_GAP_RATIO : 0;
  const primaryBottom = secondary ? secondaryBottom - secondary.height - gap : bottom;
  const tops: number[] = [];
  if (primary) tops.push(primaryBottom - primary.height);
  if (secondary) tops.push(secondaryBottom - secondary.height);
  const top = tops.length ? Math.min(...tops) : bottom;
  return {
    cue,
    primary,
    secondary,
    primaryBottom: primary ? primaryBottom : undefined,
    secondaryBottom: secondary ? secondaryBottom : undefined,
    primaryTop: primary ? primaryBottom - primary.height : undefined,
    secondaryTop: secondary ? secondaryBottom - secondary.height : undefined,
    bottom,
    top,
    height: Math.max(0, bottom - top),
    wordRanges,
  };
}

export function layoutScene(ctx: CanvasRenderingContext2D, scene: SubtitleGraphicScene): CueLayout[] {
  return scene.cues.map((cue) => layoutCue(ctx, scene, cue));
}

const sceneLayoutCache = new WeakMap<SubtitleGraphicScene, Map<string, CueLayout>>();

export function getCueLayout(
  ctx: CanvasRenderingContext2D,
  scene: SubtitleGraphicScene,
  cue: SubtitleGraphicCue,
): CueLayout {
  let cache = sceneLayoutCache.get(scene);
  if (!cache) {
    cache = new Map();
    sceneLayoutCache.set(scene, cache);
  }
  let layout = cache.get(cue.id);
  if (!layout) {
    layout = layoutCue(ctx, scene, cue);
    cache.set(cue.id, layout);
  }
  return layout;
}

export function findCue(cues: SubtitleGraphicCue[], t: number): SubtitleGraphicCue | undefined {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (t < cue.start) hi = mid - 1;
    else if (t >= cue.end) lo = mid + 1;
    else return cue;
  }
  return undefined;
}
