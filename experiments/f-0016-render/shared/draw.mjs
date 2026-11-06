// F-0016 图形层原型：输入（场景数据, 时间点），在一个 Canvas 2D 上下文上画出这一帧的字幕层（透明背景）。
// 同一份代码在浏览器（HTMLCanvasElement / OffscreenCanvas）和 Node（@napi-rs/canvas，Skia）里运行。
// 只使用两端都支持的 Canvas 2D API：measureText、fillText、strokeText、createLinearGradient、drawImage、arcTo。

const EASINGS = {
  linear: (p) => p,
  backOut: (p) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
  },
  cubicOut: (p) => 1 - (1 - p) ** 3,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isLatin = (s) => /^[A-Za-z0-9]/.test(s);

export function fontString(scene, weight, size) {
  return `${weight} ${size}px "${scene.fontFamily}"`;
}

/** 二分查找 t 时刻的字幕条下标，没有返回 -1。 */
export function findCue(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * 排版：只依赖 measureText，结果是纯数据（每个字词的 x、行号）。
 * 可以在一端算好后作为数据传给另一端（scene.layouts），避免两端字宽不同导致换行不同。
 */
export function layoutCue(ctx, scene, cue) {
  const st = scene.style;
  const fontSize = Math.round(scene.height * st.fontSizeRatio * (scene.width < scene.height ? 0.62 : 1));
  const maxWidth = scene.width * scene.maxWidthRatio;
  ctx.font = fontString(scene, st.fontWeight, fontSize);
  const gap = ctx.measureText(' ').width;
  const lines = [];
  let cur = { words: [], width: 0 };
  // 关键词会放大，排版时按放大后的宽度占位，避免挤到相邻字词（放大绕字中心，不再重排）
  const kwScale = scene.animation?.keyword?.scale ?? 1;
  cue.words.forEach((w, i) => {
    const raw = ctx.measureText(w.text).width;
    const width = w.keyword ? raw * kwScale : raw;
    const prev = cue.words[i - 1];
    const space = prev && (isLatin(w.text) || isLatin(prev.text)) ? gap : 0;
    if (cur.words.length && cur.width + space + width > maxWidth) {
      lines.push(cur);
      cur = { words: [], width: 0 };
    }
    const x = cur.words.length ? cur.width + space : 0;
    cur.words.push({ i, x, w: width });
    cur.width = x + width;
  });
  if (cur.words.length) lines.push(cur);
  return { fontSize, lineHeight: Math.round(fontSize * 1.3), lines: lines.map((l) => ({ width: +l.width.toFixed(2), words: l.words.map((w) => ({ i: w.i, x: +w.x.toFixed(2), w: +w.w.toFixed(2) })) })) };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const layoutCache = new WeakMap();
function getLayout(ctx, scene, idx) {
  if (scene.layouts) return scene.layouts[idx];
  let perScene = layoutCache.get(scene);
  if (!perScene) layoutCache.set(scene, (perScene = new Map()));
  let l = perScene.get(idx);
  if (!l) perScene.set(idx, (l = layoutCue(ctx, scene, scene.cues[idx])));
  return l;
}

/**
 * 帧状态键：两帧的键相同，画出来的像素就相同。导出端用它跳过重复帧。
 */
export function frameKey(scene, t) {
  const idx = findCue(scene.cues, t);
  if (idx < 0) return 'empty';
  const anim = scene.animation;
  if (!anim) return `c${idx}`;
  const cue = scene.cues[idx];
  const dur = anim.enter.duration;
  let started = 0;
  const moving = [];
  for (const w of cue.words) {
    if (t >= w.start) started += 1;
    if (t >= w.end) started += 1000;
    if (t >= w.start && t < w.start + dur) moving.push(w.start);
  }
  const sticker = anim.sticker && idx % anim.sticker.every === 0 && t < cue.start + anim.sticker.duration;
  if (!moving.length && !sticker) return `c${idx}s${started}`;
  return `c${idx}s${started}t${t.toFixed(4)}`;
}

/**
 * 画一帧。ctx 的画布尺寸 = 场景尺寸，或 layer 指定的局部区域（只画字幕所在的条带，减少导出端传输量）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} scene buildScene() 的结果
 * @param {number} t 秒
 * @param {{ sticker?: CanvasImageSource, layer?: { y: number, height: number } }} [opts]
 */
export function drawFrame(ctx, scene, t, opts = {}) {
  const layer = opts.layer ?? { y: 0, height: scene.height };
  // scale：画布比场景小时（例如预览按显示尺寸绘制）整体缩放，坐标仍按场景尺寸计算
  const k = opts.scale ?? 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, scene.width * k, layer.height * k);
  const idx = findCue(scene.cues, t);
  if (idx < 0) return;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.translate(0, -layer.y);

  const st = scene.style;
  const anim = scene.animation;
  const cue = scene.cues[idx];
  const L = getLayout(ctx, scene, idx);
  const { fontSize, lineHeight } = L;
  const blockHeight = L.lines.length * lineHeight;
  const bottom = scene.height * (1 - scene.bottomRatio);
  const top = bottom - blockHeight;

  ctx.font = fontString(scene, st.fontWeight, fontSize);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  L.lines.forEach((line, li) => {
    const x0 = Math.round((scene.width - line.width) / 2);
    const baseline = Math.round(top + li * lineHeight + fontSize * 0.98);

    if (st.box) {
      const pad = fontSize * st.box.paddingRatio;
      ctx.fillStyle = st.box.color;
      roundRectPath(ctx, x0 - pad, baseline - fontSize * 0.98 - pad * 0.4, line.width + pad * 2, lineHeight + pad * 0.5, fontSize * st.box.radiusRatio);
      ctx.fill();
    }

    let gradient = null;
    if (st.gradient) {
      gradient = ctx.createLinearGradient(0, baseline - fontSize * 0.85, 0, baseline + fontSize * 0.1);
      gradient.addColorStop(0, st.gradient[0]);
      gradient.addColorStop(1, st.gradient[1]);
    }

    for (const lw of line.words) {
      const word = cue.words[lw.i];
      let scale = 1;
      let alpha = 1;
      let dy = 0;
      let fill = gradient ?? st.fill;
      if (anim) {
        if (t < word.start) {
          alpha = 0;
        } else {
          const p = EASINGS[anim.enter.easing](clamp01((t - word.start) / anim.enter.duration));
          const p1 = clamp01((t - word.start) / anim.enter.duration);
          const { from, to } = anim.enter;
          scale = from.scale + (to.scale - from.scale) * p;
          alpha = from.opacity + (to.opacity - from.opacity) * clamp01(p1 * 2);
          dy = (from.dy + (to.dy - from.dy) * p) * fontSize;
          // 逐字高亮：正在读的字词换色，读完恢复原填充
          if (anim.karaoke && t < word.end) fill = anim.karaoke.fill;
          if (word.keyword && anim.keyword) {
            scale *= anim.keyword.scale;
            fill = anim.keyword.fill;
          }
        }
      }
      if (alpha <= 0.001) continue;
      const cx = x0 + lw.x + lw.w / 2;
      const cy = baseline - fontSize * 0.36;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy + dy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
      const x = x0 + lw.x;
      if (st.shadow && !scene.manualShadow) {
        // 浏览器原生阴影：WebKit 的 shadowBlur 半径与 Skia / Chromium 不同（实测约 2 倍）
        ctx.shadowColor = st.shadow.color;
        ctx.shadowBlur = fontSize * st.shadow.blurRatio;
        ctx.shadowOffsetX = fontSize * st.shadow.dxRatio;
        ctx.shadowOffsetY = fontSize * st.shadow.dyRatio;
      } else if (st.shadow) {
        // 手绘阴影：同一字形按固定的圆环偏移叠画 N 次，近似高斯模糊；只用 fill/stroke，三端一致
        const blur = fontSize * st.shadow.blurRatio;
        const sdx = fontSize * st.shadow.dxRatio;
        const sdy = fontSize * st.shadow.dyRatio;
        const rings = [[0, 1], [0.5, 8], [1, 12]];
        const total = rings.reduce((a, [, n]) => a + n, 0);
        ctx.fillStyle = st.shadow.color;
        ctx.strokeStyle = st.shadow.color;
        ctx.lineWidth = st.stroke ? fontSize * st.strokeRatio * 2 : 0;
        const base = ctx.globalAlpha;
        ctx.globalAlpha = base * Math.min(1, 2.2 / Math.sqrt(total));
        for (const [r, n] of rings) {
          for (let k = 0; k < n; k += 1) {
            const a = (k / n) * Math.PI * 2;
            const ox = x + sdx + Math.cos(a) * r * blur;
            const oy = baseline + sdy + Math.sin(a) * r * blur;
            if (st.stroke) ctx.strokeText(word.text, ox, oy);
            ctx.fillText(word.text, ox, oy);
          }
        }
        ctx.globalAlpha = base;
      }
      if (st.stroke) {
        ctx.strokeStyle = st.stroke;
        ctx.lineWidth = fontSize * st.strokeRatio * 2;
        ctx.strokeText(word.text, x, baseline);
        ctx.shadowColor = 'rgba(0,0,0,0)';
      }
      ctx.fillStyle = fill;
      ctx.fillText(word.text, x, baseline);
      ctx.restore();
    }
  });

  if (anim?.sticker && opts.sticker && idx % anim.sticker.every === 0) {
    const size = scene.height * anim.sticker.size;
    const p = EASINGS[anim.sticker.easing](clamp01((t - cue.start) / anim.sticker.duration));
    const s = size * Math.max(0, p);
    const lastLine = L.lines[0];
    const cx = (scene.width + lastLine.width) / 2 + size * 0.2;
    const cy = top - size * 0.1;
    if (s > 0.5) ctx.drawImage(opts.sticker, cx - s / 2, cy - s / 2, s, s);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** 字幕条带的位置（导出端只渲染这一条，叠加到视频上）。动画最多放大到 1.4 倍，留足余量。 */
export function subtitleBand(scene) {
  const bottom = scene.height * (1 - scene.bottomRatio);
  const height = Math.round(scene.height * (scene.width < scene.height ? 0.42 : 0.4));
  const y = Math.max(0, Math.round(bottom - height + scene.height * 0.06));
  return { y: y - (y % 2), height: height - (height % 2) };
}
