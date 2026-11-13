import { prepareWithSegments, layoutWithLines, measureNaturalWidth } from '@chenglou/pretext';
import { prepareRichInline, walkRichInlineLineRanges, materializeRichInlineLineRange, type RichInlineItem } from '@chenglou/pretext/rich-inline';
import type { SubtitleGraphicCue, SubtitleGraphicKeyword, SubtitleGraphicScene, SubtitleGraphicStyle, SubtitleGraphicWord } from './scene';
import { applyCjkBreakHints, fixCjkLineStarts, mapRawRangesToDisplay, stripSubtitleDisplayPunctuation } from './text';

export const BLOCK_GAP_RATIO = 0.15;

export interface LayoutItem {
  text: string;
  x: number;
  width: number;
}

export interface LayoutRun {
  text: string;
  /** Offset from the start of the line. */
  x: number;
  /** Total horizontal space reserved on the line (glyphWidth + reserves). */
  width: number;
  /** Text draw X relative to the start of the line. */
  glyphX: number;
  glyphWidth: number;
  fontSize: number;
  isKeyword: boolean;
  charStart?: number;
  charEnd?: number;
}

export interface LayoutLine {
  text: string;
  width: number;
  items: LayoutItem[];
  /** Present when the cue contains emphasized keywords requiring mixed-size or padded runs. */
  runs?: LayoutRun[];
  /** Effective line step above this line's baseline. */
  lineHeight?: number;
  /** Max font size on this line. */
  fontSize?: number;
  /** Vertical keyword background padding on this line. */
  bgPadY?: number;
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

export interface KeywordMetrics {
  fontSize: number;
  scale: number;
  hasBg: boolean;
  bgPadX: number;
  bgPadY: number;
  bgRadius: number;
  strokeWidth: number;
  reserveEachSide: number;
}

export function resolveKeywordMetrics(style: SubtitleGraphicStyle, baseFontSize: number): KeywordMetrics {
  const scale = Math.max(1, style.keywordScale ?? 1);
  const fontSize = Math.max(8, Math.round(baseFontSize * scale));
  const hasBg = (style.keywordBackgroundOpacity ?? 0) > 0;
  const bgPadX = hasBg ? Math.max(4, Math.round(fontSize * 0.14)) : 0;
  const bgPadY = hasBg ? Math.max(2, Math.round(fontSize * 0.08)) : 0;
  const bgRadius = hasBg ? Math.max(4, Math.round(fontSize * 0.14)) : 0;
  const strokeWidth = style.borderWidth * (fontSize / baseFontSize);
  const strokePad = scale > 1 ? Math.ceil(strokeWidth * 0.5) : 0;
  const scaleBreathing = scale > 1 ? Math.max(1, Math.round(baseFontSize * (scale - 1) * 0.08)) : 0;
  const reserveEachSide = bgPadX + strokePad + scaleBreathing;
  return { fontSize, scale, hasBg, bgPadX, bgPadY, bgRadius, strokeWidth, reserveEachSide };
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

interface InlineItemMeta {
  isKeyword: boolean;
  font: string;
  fontSize: number;
  reserve: number;
}

function layoutKeywordText(
  ctx: CanvasRenderingContext2D,
  text: string,
  keywords: readonly SubtitleGraphicKeyword[],
  style: SubtitleGraphicStyle,
  baseFontSize: number,
  maxWidth: number,
): LayoutLine[] {
  const display = stripSubtitleDisplayPunctuation(text);
  if (!display || maxWidth <= 0) return [];
  const mappedKeywords = mapRawRangesToDisplay(text, keywords);
  if (!mappedKeywords.length) {
    return layoutText(ctx, text, style, baseFontSize, maxWidth);
  }

  const kw = resolveKeywordMetrics(style, baseFontSize);
  const normalFont = buildCanvasFont(style, baseFontSize);
  const keywordFont = buildCanvasFont(style, kw.fontSize);
  const letterSpacing = style.letterSpacing > 0 ? style.letterSpacing : undefined;
  const baseLineHeight = baseFontSize * style.lineHeight;

  // Partition display text into paragraphs, preserving exact offsets in `display`.
  const paragraphs: Array<{ start: number; end: number }> = [];
  let pCursor = 0;
  while (pCursor <= display.length) {
    const nl = display.indexOf('\n', pCursor);
    const rawEnd = nl < 0 ? display.length : nl;
    let s = pCursor;
    let e = rawEnd;
    while (s < e && /^\s$/u.test(display[s])) s += 1;
    while (e > s && /^\s$/u.test(display[e - 1])) e -= 1;
    if (e > s) paragraphs.push({ start: s, end: e });
    if (nl < 0) break;
    pCursor = nl + 1;
  }
  if (!paragraphs.length) paragraphs.push({ start: 0, end: display.length });

  const allLines: LayoutLine[] = [];

  for (const para of paragraphs) {
    const inlineItems: RichInlineItem[] = [];
    const metas: InlineItemMeta[] = [];
    let pos = para.start;

    const paraKeywords = mappedKeywords.filter(k => k.end > para.start && k.start < para.end);
    for (const k of paraKeywords) {
      const kStart = Math.max(para.start, k.start);
      const kEnd = Math.min(para.end, k.end);
      if (kStart > pos) {
        const normalSlice = display.slice(pos, kStart);
        inlineItems.push({ text: normalSlice, font: normalFont, letterSpacing, break: 'normal', extraWidth: 0 });
        metas.push({ isKeyword: false, font: normalFont, fontSize: baseFontSize, reserve: 0 });
      }
      if (kEnd > kStart) {
        const kwSlice = display.slice(kStart, kEnd);
        const naturalWidth = measureNaturalWidth(prepareWithSegments(kwSlice, keywordFont, letterSpacing ? { letterSpacing } : undefined));
        const canKeepTogether = naturalWidth + kw.reserveEachSide * 2 <= maxWidth;
        inlineItems.push({
          text: kwSlice,
          font: keywordFont,
          letterSpacing,
          break: canKeepTogether ? 'never' : 'normal',
          extraWidth: kw.reserveEachSide * 2,
        });
        metas.push({ isKeyword: true, font: keywordFont, fontSize: kw.fontSize, reserve: kw.reserveEachSide });
      }
      pos = kEnd;
    }
    if (pos < para.end) {
      const tailSlice = display.slice(pos, para.end);
      inlineItems.push({ text: tailSlice, font: normalFont, letterSpacing, break: 'normal', extraWidth: 0 });
      metas.push({ isKeyword: false, font: normalFont, fontSize: baseFontSize, reserve: 0 });
    }

    const prepared = prepareRichInline(inlineItems);
    let charCursor = para.start;

    walkRichInlineLineRanges(prepared, maxWidth, (range) => {
      const mat = materializeRichInlineLineRange(prepared, range);
      const runs: LayoutRun[] = [];
      let x = 0;
      let lineText = '';

      for (let i = 0; i < mat.fragments.length; i += 1) {
        const frag = mat.fragments[i];
        const meta = metas[frag.itemIndex];
        const gap = i > 0 ? frag.gapBefore : 0;
        const extraLetterGap = i > 0 && gap === 0 && style.letterSpacing > 0 && runs.at(-1)?.isKeyword !== meta.isKeyword
          ? style.letterSpacing
          : 0;
        x += gap + extraLetterGap;

        ctx.font = meta.font;
        ctx.letterSpacing = `${style.letterSpacing}px`;
        const glyphWidth = ctx.measureText(frag.text).width;
        const runWidth = Math.max(frag.occupiedWidth, glyphWidth + meta.reserve * 2);

        const foundAt = display.indexOf(frag.text, charCursor);
        const charStart = foundAt >= 0 ? foundAt : undefined;
        const charEnd = foundAt >= 0 ? foundAt + frag.text.length : undefined;
        if (charEnd !== undefined) charCursor = charEnd;

        runs.push({
          text: frag.text,
          x,
          width: runWidth,
          glyphX: x + meta.reserve,
          glyphWidth,
          fontSize: meta.fontSize,
          isKeyword: meta.isKeyword,
          charStart,
          charEnd,
        });
        if (i > 0 && gap > 0) lineText += ' ';
        lineText += frag.text;
        x += runWidth;
      }

      if (!runs.length) return;
      const hasKeyword = runs.some(r => r.isKeyword);
      const lineFontSize = hasKeyword ? kw.fontSize : baseFontSize;
      const bgPadY = hasKeyword ? kw.bgPadY : 0;

      allLines.push({
        text: lineText,
        width: x,
        items: runs.map(r => ({ text: r.text, x: r.glyphX, width: r.glyphWidth })),
        runs,
        fontSize: lineFontSize,
        bgPadY,
        charStart: runs[0].charStart,
        charEnd: runs.at(-1)?.charEnd,
      });
    });
  }

  for (let i = 0; i < allLines.length; i += 1) {
    const cur = allLines[i];
    const prevBgPadY = i > 0 ? (allLines[i - 1].bgPadY ?? 0) : 0;
    const curFontSize = cur.fontSize ?? baseFontSize;
    const curBgPadY = cur.bgPadY ?? 0;
    cur.lineHeight = Math.max(baseLineHeight, curFontSize * style.lineHeight + curBgPadY + prevBgPadY);
  }

  return allLines;
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
  keywords?: readonly SubtitleGraphicKeyword[],
): LayoutBlock | undefined {
  if (!text?.trim()) return undefined;
  const fontSize = resolveVideoFontSize(style, scene.height);
  const maxWidth = resolveLayoutMaxWidth(scene);
  const lines = keywords?.length
    ? layoutKeywordText(ctx, text, keywords, style, fontSize, maxWidth)
    : layoutText(ctx, text, style, fontSize, maxWidth);
  if (lines.length === 0) return undefined;
  const lineHeight = fontSize * style.lineHeight;
  const height = lines.reduce((sum, line) => sum + (line.lineHeight ?? lineHeight), 0);
  return { style, fontSize, lineHeight, lines, height };
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
  if (lines.every(line => line.charStart !== undefined && line.charEnd !== undefined)) {
    return true;
  }
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
  const primary = showPrimary ? layoutBlock(ctx, cue.text, scene.primary, scene, cue.keywords) : undefined;
  let wordRanges = mapCueWordRanges(cue);
  if (wordRanges && primary && !assignLineRanges(primary.lines, cue.text)) wordRanges = undefined;
  const secondary = showSecondary && scene.secondary
    ? layoutBlock(ctx, cue.secondText, scene.secondary, scene)
    : undefined;
  const bottom = scene.height - resolveBottomOffset(scene.primary, scene.height);
  const secondaryBottom = bottom;
  const primaryBottomBgPad = primary?.lines.at(-1)?.bgPadY ?? 0;
  const gap = secondary ? Math.max(secondary.fontSize * BLOCK_GAP_RATIO, primaryBottomBgPad + secondary.fontSize * 0.15) : 0;
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
