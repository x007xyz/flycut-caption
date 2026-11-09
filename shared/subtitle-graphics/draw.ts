import type { SubtitleGraphicCue, SubtitleGraphicScene, SubtitleGraphicStyle } from './scene';
import {
  buildCanvasFont,
  findCue,
  getCueLayout,
  type CueLayout,
  type LayoutBlock,
  type LayoutLine,
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

function drawHandShadow(
  ctx: CanvasRenderingContext2D,
  line: string,
  x: number,
  y: number,
  style: SubtitleGraphicStyle,
): void {
  if (style.shadowBlur <= 0) return;
  const strokes = style.borderWidth > 0;
  ctx.save();
  ctx.fillStyle = withOpacity(style.shadowColor, 1);
  ctx.strokeStyle = withOpacity(style.shadowColor, 1);
  ctx.lineWidth = strokes ? style.borderWidth : 0;
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
  const metrics = ctx.measureText(line.text);
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.2;
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

function drawLine(
  ctx: CanvasRenderingContext2D,
  line: LayoutLine,
  block: LayoutBlock,
  scene: SubtitleGraphicScene,
  y: number,
): void {
  const style = block.style;
  if (!style.visible) return;
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
  ctx.fillStyle = withOpacity(style.color, style.colorOpacity);
  ctx.fillText(line.text, x, y);
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
): void {
  let y = bottom;
  for (let i = block.lines.length - 1; i >= 0; i -= 1) {
    drawLine(ctx, block.lines[i], block, scene, y);
    y -= block.lineHeight;
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
  if (layout.secondary && layout.secondaryBottom !== undefined) {
    drawBlock(ctx, layout.secondary, scene, layout.secondaryBottom);
  }
  if (layout.primary && layout.primaryBottom !== undefined) {
    drawBlock(ctx, layout.primary, scene, layout.primaryBottom);
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
  return `${sceneStyleKey(scene)}|${cue.id}|${cue.text}|${cue.secondText ?? ''}`;
}

/** 计算只包含字幕内容的条带，供 Host 渲染透明字幕层。 */
export function subtitleBand(
  scene: SubtitleGraphicScene,
  layouts: CueLayout[],
): { x: number; y: number; width: number; height: number } {
  let minTop = scene.height;
  let maxBottom = 0;
  let margin = 8;
  for (const layout of layouts) {
    if (layout.primaryTop !== undefined) minTop = Math.min(minTop, layout.primaryTop);
    if (layout.secondaryTop !== undefined) minTop = Math.min(minTop, layout.secondaryTop);
    maxBottom = Math.max(maxBottom, layout.bottom);
    for (const block of [layout.primary, layout.secondary]) {
      if (!block) continue;
      const style = block.style;
      margin = Math.max(
        margin,
        style.borderWidth / 2 + style.backgroundPadding + style.backgroundRadius,
        style.shadowBlur + Math.max(Math.abs(style.shadowOffsetX), Math.abs(style.shadowOffsetY)) + style.borderWidth,
      );
    }
  }
  if (layouts.length === 0) return { x: 0, y: 0, width: scene.width, height: 2 };
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
