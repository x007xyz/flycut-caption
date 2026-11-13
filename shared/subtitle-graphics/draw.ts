import type { SubtitleGraphicCue, SubtitleGraphicScene, SubtitleGraphicStyle } from './scene';
import {
  buildCanvasFont,
  findActiveWordRange,
  findCue,
  getCueLayout,
  mapCueWordRanges,
  resolveKeywordMetrics,
  type CueLayout,
  type LayoutBlock,
  type LayoutLine,
  type LayoutRun,
  type LayoutWordRange,
} from './layout';

export interface SubtitleDrawOptions {
  /** 只绘制场景中这条字幕条带，画布高度 = 条带高度 × scale */
  layer?: { y: number; height: number };
  /** 画布相对场景坐标的缩放（预览按显示尺寸） */
  scale?: number;
  /** 已算好的排版数据；Host 可以预计算后复用 */
  layouts?: CueLayout[];
  /** 是否清空画布，默认 true */
  clear?: boolean;
}

function withOpacity(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return `${color}${Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')}`;
  }
  return color;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function textX(style: SubtitleGraphicStyle, sceneWidth: number): number {
  if (style.textAlign === 'left') return 0;
  if (style.textAlign === 'right') return sceneWidth;
  return sceneWidth / 2;
}

function lineStartXFor(style: SubtitleGraphicStyle, sceneWidth: number, lineWidth: number): number {
  if (style.textAlign === 'left') return 0;
  if (style.textAlign === 'right') return sceneWidth - lineWidth;
  return (sceneWidth - lineWidth) / 2;
}

function drawHandShadow(
  ctx: CanvasRenderingContext2D,
  line: string,
  x: number,
  y: number,
  style: SubtitleGraphicStyle,
  strokeWidth = style.borderWidth,
): void {
  if (style.shadowBlur <= 0) return;
  const strokes = strokeWidth > 0;
  ctx.save();
  ctx.fillStyle = withOpacity(style.shadowColor, 1);
  ctx.strokeStyle = withOpacity(style.shadowColor, 1);
  ctx.lineWidth = strokes ? strokeWidth : 0;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const baseAlpha = ctx.globalAlpha;
  const blur = style.shadowBlur;
  const dx = style.shadowOffsetX;
  const dy = style.shadowOffsetY;
  if (blur <= 0.01) {
    const ox = x + dx;
    const oy = y + dy;
    if (strokes) ctx.strokeText(line, ox, oy);
    ctx.fillText(line, ox, oy);
    ctx.restore();
    return;
  }
  // 固定圆环偏移叠画，近似模糊；不用 shadowBlur，WKWebView 的半径与 Skia 不同。
  const rings: Array<[number, number]> = [[0, 1], [0.5, 8], [1, 12]];
  const total = rings.reduce((sum, [, count]) => sum + count, 0);
  ctx.globalAlpha = baseAlpha * Math.min(1, 2.2 / Math.sqrt(total));
  for (const [radius, count] of rings) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const ox = x + dx + Math.cos(angle) * radius * blur;
      const oy = y + dy + Math.sin(angle) * radius * blur;
      if (strokes) ctx.strokeText(line, ox, oy);
      ctx.fillText(line, ox, oy);
    }
  }
  ctx.restore();
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  line: LayoutLine,
  x: number,
  y: number,
  style: SubtitleGraphicStyle,
  sceneWidth: number,
  fontSize: number,
): void {
  if (style.backgroundOpacity <= 0) return;
  const effectiveFontSize = line.fontSize ?? fontSize;
  let ascent = effectiveFontSize * 0.8;
  let descent = effectiveFontSize * 0.2;
  if (line.runs?.length) {
    for (const run of line.runs) {
      ctx.font = buildCanvasFont(style, run.fontSize);
      const metrics = ctx.measureText(run.text);
      ascent = Math.max(ascent, metrics.actualBoundingBoxAscent || run.fontSize * 0.8);
      descent = Math.max(descent, metrics.actualBoundingBoxDescent || run.fontSize * 0.2);
    }
  } else {
    const metrics = ctx.measureText(line.text);
    ascent = metrics.actualBoundingBoxAscent || fontSize * 0.8;
    descent = metrics.actualBoundingBoxDescent || fontSize * 0.2;
  }
  const padding = style.backgroundPadding;
  const width = line.width + padding * 2;
  const height = ascent + descent + padding * 2;
  const boxY = y - ascent - padding;
  let boxX = sceneWidth / 2 - line.width / 2 - padding;
  if (style.textAlign === 'left') boxX = x - padding;
  if (style.textAlign === 'right') boxX = x - line.width - padding;
  ctx.save();
  ctx.fillStyle = withOpacity(style.backgroundColor, style.backgroundOpacity);
  roundRectPath(ctx, boxX, boxY, width, height, style.backgroundRadius);
  ctx.fill();
  ctx.restore();
}

function drawKeywordRunBackground(
  ctx: CanvasRenderingContext2D,
  run: LayoutRun,
  lineStartX: number,
  y: number,
  style: SubtitleGraphicStyle,
  baseFontSize: number,
): void {
  const opacity = style.keywordBackgroundOpacity ?? 0;
  if (opacity <= 0) return;
  const kw = resolveKeywordMetrics(style, baseFontSize);
  ctx.save();
  ctx.font = buildCanvasFont(style, run.fontSize);
  ctx.letterSpacing = `${style.letterSpacing}px`;
  const metrics = ctx.measureText(run.text);
  const ascent = metrics.actualBoundingBoxAscent || run.fontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent || run.fontSize * 0.2;
  const boxX = lineStartX + run.glyphX - kw.bgPadX;
  const boxW = run.glyphWidth + kw.bgPadX * 2;
  const boxY = y - ascent - kw.bgPadY;
  const boxH = ascent + descent + kw.bgPadY * 2;
  ctx.fillStyle = withOpacity(style.keywordBackgroundColor ?? '#FF5B57', opacity);
  roundRectPath(ctx, boxX, boxY, boxW, boxH, kw.bgRadius);
  ctx.fill();
  ctx.restore();
}

function drawLineWithRuns(
  ctx: CanvasRenderingContext2D,
  line: LayoutLine,
  block: LayoutBlock,
  scene: SubtitleGraphicScene,
  y: number,
  wordHighlight: boolean,
  activeWord: LayoutWordRange | undefined,
  sentenceHighlight: boolean,
): void {
  const style = block.style;
  const runs = line.runs!;
  const startX = lineStartXFor(style, scene.width, line.width);
  const highlightColor = style.wordHighlightColor ?? '#FFE100';
  const kwColor = style.keywordColorEnabled !== false ? (style.keywordColor ?? '#FFE100') : style.color;

  ctx.save();
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.letterSpacing = `${style.letterSpacing}px`;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  drawBackground(ctx, line, textX(style, scene.width), y, style, scene.width, block.fontSize);
  for (const run of runs) {
    if (run.isKeyword) drawKeywordRunBackground(ctx, run, startX, y, style, block.fontSize);
  }

  for (const run of runs) {
    const runX = startX + run.glyphX;
    const strokeWidth = run.isKeyword ? style.borderWidth * (run.fontSize / block.fontSize) : style.borderWidth;
    ctx.font = buildCanvasFont(style, run.fontSize);
    drawHandShadow(ctx, run.text, runX, y, style, strokeWidth);
    if (strokeWidth > 0) {
      ctx.strokeStyle = withOpacity(style.borderColor, style.borderOpacity);
      ctx.lineWidth = strokeWidth;
      ctx.strokeText(run.text, runX, y);
    }
    const baseFill = run.isKeyword ? kwColor : style.color;
    ctx.fillStyle = withOpacity(wordHighlight && sentenceHighlight ? highlightColor : baseFill, style.colorOpacity);
    ctx.fillText(run.text, runX, y);

    if (wordHighlight && activeWord && run.charStart !== undefined && run.charEnd !== undefined) {
      const start = Math.max(activeWord.charStart, run.charStart);
      const end = Math.min(activeWord.charEnd, run.charEnd);
      if (end > start) {
        const localStart = start - run.charStart;
        const localEnd = end - run.charStart;
        const prefix = run.text.slice(0, localStart);
        const fragment = run.text.slice(localStart, localEnd);
        const clipX = runX + ctx.measureText(prefix).width;
        const clipWidth = Math.max(0.5, ctx.measureText(fragment).width);
        ctx.save();
        ctx.beginPath();
        ctx.rect(clipX - 1, y - run.fontSize * 1.45, clipWidth + 2, run.fontSize * 1.8);
        ctx.clip();
        ctx.fillStyle = withOpacity(highlightColor, style.colorOpacity);
        ctx.fillText(run.text, runX, y);
        ctx.restore();
      }
    }

    if (style.textDecoration === 'underline') {
      const underlineY = y + run.fontSize * 0.08;
      ctx.strokeStyle = withOpacity(baseFill, style.colorOpacity);
      ctx.lineWidth = Math.max(1, run.fontSize * 0.06);
      ctx.beginPath();
      ctx.moveTo(runX, underlineY);
      ctx.lineTo(runX + run.glyphWidth, underlineY);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  line: LayoutLine,
  block: LayoutBlock,
  scene: SubtitleGraphicScene,
  y: number,
  wordHighlight: boolean,
  activeWord: LayoutWordRange | undefined,
  sentenceHighlight: boolean,
): void {
  const style = block.style;
  if (!style.visible) return;
  if (line.runs?.length) {
    drawLineWithRuns(ctx, line, block, scene, y, wordHighlight, activeWord, sentenceHighlight);
    return;
  }
  const x = textX(style, scene.width);
  ctx.save();
  ctx.font = buildCanvasFont(style, block.fontSize);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = style.textAlign;
  ctx.letterSpacing = `${style.letterSpacing}px`;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawBackground(ctx, line, x, y, style, scene.width, block.fontSize);
  drawHandShadow(ctx, line.text, x, y, style);
  if (style.borderWidth > 0) {
    ctx.strokeStyle = withOpacity(style.borderColor, style.borderOpacity);
    ctx.lineWidth = style.borderWidth;
    ctx.strokeText(line.text, x, y);
  }
  const highlightColor = style.wordHighlightColor ?? '#FFE100';
  ctx.fillStyle = withOpacity(wordHighlight && sentenceHighlight ? highlightColor : style.color, style.colorOpacity);
  ctx.fillText(line.text, x, y);
  if (wordHighlight && activeWord && line.charStart !== undefined && line.charEnd !== undefined) {
    const start = Math.max(activeWord.charStart, line.charStart);
    const end = Math.min(activeWord.charEnd, line.charEnd);
    if (end > start) {
      const localStart = start - line.charStart;
      const localEnd = end - line.charStart;
      const prefix = line.text.slice(0, localStart);
      const fragment = line.text.slice(localStart, localEnd);
      const alignedStart = style.textAlign === 'left' ? 0
        : style.textAlign === 'right' ? scene.width - line.width : (scene.width - line.width) / 2;
      const clipX = alignedStart + ctx.measureText(prefix).width;
      const clipWidth = Math.max(0.5, ctx.measureText(fragment).width);
      // 用原排版整行重填并裁到当前词，保留字偶距、字距和换行位置。
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipX - 1, y - block.fontSize * 1.45, clipWidth + 2, block.fontSize * 1.8);
      ctx.clip();
      ctx.fillStyle = withOpacity(highlightColor, style.colorOpacity);
      ctx.fillText(line.text, x, y);
      ctx.restore();
    }
  }
  if (style.textDecoration === 'underline') {
    const width = line.width;
    const underlineY = y + block.fontSize * 0.08;
    let startX = x - width / 2;
    if (style.textAlign === 'left') startX = x;
    if (style.textAlign === 'right') startX = x - width;
    ctx.strokeStyle = withOpacity(style.color, style.colorOpacity);
    ctx.lineWidth = Math.max(1, block.fontSize * 0.06);
    ctx.beginPath();
    ctx.moveTo(startX, underlineY);
    ctx.lineTo(startX + width, underlineY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  block: LayoutBlock,
  scene: SubtitleGraphicScene,
  bottom: number,
  t: number,
  wordHighlight: boolean,
  wordRanges: LayoutWordRange[] | undefined,
  sentenceHighlight: boolean,
): void {
  let y = bottom;
  const activeWord = wordHighlight && wordRanges?.length ? findActiveWordRange(wordRanges, t) : undefined;
  for (let i = block.lines.length - 1; i >= 0; i -= 1) {
    const line = block.lines[i];
    drawLine(ctx, line, block, scene, y, wordHighlight, activeWord, sentenceHighlight);
    y -= line.lineHeight ?? block.lineHeight;
  }
}

/**
 * 在 Canvas 上绘制一帧透明字幕层。预览和 Host 共用这一份代码。
 * 返回是否画出了内容（空字幕或样式不可见时为 false）。
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  scene: SubtitleGraphicScene,
  t: number,
  opts: SubtitleDrawOptions = {},
): boolean {
  const scale = opts.scale ?? 1;
  const layer = opts.layer ?? { y: 0, height: scene.height };
  const canvasWidth = scene.width * scale;
  const canvasHeight = layer.height * scale;
  if (opts.clear !== false) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  }
  const cue = findCue(scene.cues, t);
  if (!cue) return false;
  const layout = opts.layouts
    ? getPrecomputedLayout(opts.layouts, cue.id) ?? getCueLayout(ctx, scene, cue)
    : getCueLayout(ctx, scene, cue);
  if (!layout.primary && !layout.secondary) return false;
  ctx.setTransform(scale, 0, 0, scale, 0, -layer.y * scale);
  const primaryWords = layout.primary && scene.primary.wordHighlightMode === 'word'
    ? mapCueWordRanges(cue) : undefined;
  const primaryWordHighlight = Boolean(layout.primary && scene.primary.wordHighlightMode === 'word');
  const secondaryWordHighlight = Boolean(layout.secondary && scene.secondary?.wordHighlightMode === 'word');
  if (layout.secondary && layout.secondaryBottom !== undefined) {
    // 译文没有独立对齐词元；启用逐字模式时明确整句降级。
    drawBlock(ctx, layout.secondary, scene, layout.secondaryBottom, t, secondaryWordHighlight, undefined, true);
  }
  if (layout.primary && layout.primaryBottom !== undefined) {
    drawBlock(ctx, layout.primary, scene, layout.primaryBottom, t, primaryWordHighlight, primaryWords, !primaryWords?.length);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return Boolean(layout.primary || layout.secondary);
}

const sceneKeyCache = new WeakMap<SubtitleGraphicScene, string>();

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sceneStyleKey(scene: SubtitleGraphicScene): string {
  let key = sceneKeyCache.get(scene);
  if (!key) {
    key = `${scene.version}|${scene.displayMode}|${scene.width}x${scene.height}|${scene.fontId}|${hashString(JSON.stringify(scene.primary))}|${hashString(JSON.stringify(scene.secondary ?? null))}`;
    sceneKeyCache.set(scene, key);
  }
  return key;
}

const layoutMapCache = new WeakMap<CueLayout[], Map<string, CueLayout>>();

function getPrecomputedLayout(layouts: CueLayout[], id: string): CueLayout | undefined {
  let map = layoutMapCache.get(layouts);
  if (!map) {
    map = new Map(layouts.map((layout) => [layout.cue.id, layout]));
    layoutMapCache.set(layouts, map);
  }
  return map.get(id);
}

/** 同一个键的两帧像素相同；静态样式下同一字幕条内可以跳过重画。 */
export function frameKey(scene: SubtitleGraphicScene, t: number): string {
  const cue = findCue(scene.cues, t);
  if (!cue) return `${sceneStyleKey(scene)}|empty`;
  let wordState = '';
  if (scene.displayMode !== 'Second' && scene.primary.wordHighlightMode === 'word') {
    const ranges = mapCueWordRanges(cue);
    if (!ranges?.length) wordState = '|fallback';
    else {
      const active = findActiveWordRange(ranges, t);
      wordState = active ? `|word${active.index}` : '|gap';
    }
  }
  const kwState = cue.keywords?.length
    ? `|kw:${cue.keywords.map(k => `${k.start}-${k.end}`).join(',')}`
    : '';
  return `${sceneStyleKey(scene)}|${cue.id}|${cue.text}|${cue.secondText ?? ''}${wordState}${kwState}`;
}

/** 计算只包含字幕内容的条带，供 Host 渲染透明字幕层。 */
export function subtitleBand(
  scene: SubtitleGraphicScene,
  layouts: CueLayout[],
): { x: number; y: number; width: number; height: number } {
  let minTop = scene.height;
  let maxBottom = 0;
  let margin = 8;
  let hasContent = false;
  for (const layout of layouts) {
    if (layout.primaryTop !== undefined) minTop = Math.min(minTop, layout.primaryTop);
    if (layout.secondaryTop !== undefined) minTop = Math.min(minTop, layout.secondaryTop);
    maxBottom = Math.max(maxBottom, layout.bottom);
    for (const block of [layout.primary, layout.secondary]) {
      if (!block) continue;
      hasContent = true;
      const style = block.style;
      const hasKwRuns = block.lines.some(line => line.runs?.some(run => run.isKeyword));
      const kwMargin = hasKwRuns
        ? (() => {
            const kw = resolveKeywordMetrics(style, block.fontSize);
            return kw.bgPadY + kw.bgRadius + Math.ceil(kw.strokeWidth) + Math.ceil(block.fontSize * Math.max(0, kw.scale - 1) * 0.25);
          })()
        : 0;
      margin = Math.max(
        margin,
        style.borderWidth / 2 + style.backgroundPadding + style.backgroundRadius + kwMargin,
        style.shadowBlur + Math.max(Math.abs(style.shadowOffsetX), Math.abs(style.shadowOffsetY)) + style.borderWidth + kwMargin,
      );
    }
  }
  if (!hasContent) return { x: 0, y: 0, width: scene.width - (scene.width % 2), height: 2 };
  let y = Math.floor(minTop - margin);
  let height = Math.ceil(maxBottom + margin - y);
  y = Math.max(0, y - (y % 2));
  height = Math.max(2, height + (height % 2));
  const bottom = Math.min(scene.height, y + height);
  if (bottom - y < height) height = bottom - y - ((bottom - y) % 2);
  return { x: 0, y, width: scene.width - (scene.width % 2), height: Math.max(2, height) };
}

export function findVisibleCue(scene: SubtitleGraphicScene, t: number): SubtitleGraphicCue | undefined {
  return findCue(scene.cues, t);
}
