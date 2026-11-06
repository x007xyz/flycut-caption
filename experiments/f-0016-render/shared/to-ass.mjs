// 方案 D 基线：把同一份场景转成 ASS，交给 libass（导出端 FFmpeg，预览端 JASSUB）。
// 尽量用 ASS 标签逼近 Canvas 版的效果，做不到的在注释里写明（报告里列为能力缺口）。

const ms = (s) => Math.round(s * 1000);
const assTime = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
function assColor(css, alphaOverride) {
  let r = 255, g = 255, b = 255, a = 1;
  const hex = css.match(/^#([0-9a-f]{6})$/i);
  const rgba = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (hex) [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  else if (rgba) [r, g, b, a] = [rgba[1], rgba[2], rgba[3], rgba[4] ?? 1].map(Number);
  const aa = Math.round((1 - (alphaOverride ?? a)) * 255);
  const h = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${h(aa)}${h(b)}${h(g)}${h(r)}`;
}

export function sceneToAss(scene, { fontName = 'Noto Sans SC' } = {}) {
  const st = scene.style;
  const fontSize = Math.round(scene.height * st.fontSizeRatio * (scene.width < scene.height ? 0.62 : 1));
  // 渐变填充 ASS 不支持：退化为渐变的中间色
  const fill = st.gradient ? '#FFB848' : st.fill;
  const borderStyle = st.box ? 3 : 1;
  const outline = st.box ? Math.round(fontSize * st.box.paddingRatio) : Math.round(fontSize * st.strokeRatio);
  const shadow = st.shadow ? Math.round(fontSize * st.shadow.dyRatio) : 0;
  const outlineColour = st.box ? assColor(st.box.color) : assColor(st.stroke ?? '#000000');
  const backColour = st.shadow ? assColor(st.shadow.color) : st.box ? assColor(st.box.color) : '&H00000000';
  const marginV = Math.round(scene.height * scene.bottomRatio);
  const marginLR = Math.round((scene.width * (1 - scene.maxWidthRatio)) / 2);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${scene.width}`, `PlayResY: ${scene.height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},${assColor(fill)},${assColor(fill)},${outlineColour},${backColour},${st.fontWeight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,${marginLR},${marginLR},${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const anim = scene.animation;
  for (const cue of scene.cues) {
    let text;
    if (!anim) {
      text = cue.words.map((w, i) => (i && (/^[A-Za-z0-9]/.test(w.text) || /^[A-Za-z0-9]/.test(cue.words[i - 1].text)) ? ' ' : '') + w.text).join('');
    } else {
      // 逐字弹出：透明 → 不透明；缩放 40% → 115% → 100%（ASS 的 \t 只有幂次加速，无法表达回弹，拆成两段近似）
      // 注意：ASS 的逐字 \fscx 会挤开后面的字（参与排版），Canvas 版是绕字中心的变换、不影响排版。
      text = cue.words.map((w, i) => {
        const s = ms(w.start - cue.start);
        const e = ms(w.end - cue.start);
        const d = ms(anim.enter.duration);
        const kw = w.keyword && anim.keyword;
        const peak = kw ? 140 : 115;
        const final = kw ? Math.round(anim.keyword.scale * 100) : 100;
        const finalColor = kw ? assColor(anim.keyword.fill) : assColor(fill);
        const sp = i && (/^[A-Za-z0-9]/.test(w.text) || /^[A-Za-z0-9]/.test(cue.words[i - 1].text)) ? ' ' : '';
        return `${sp}{\\alpha&HFF&\\fscx40\\fscy40\\t(${s},${s + d / 2},\\alpha&H00&)` +
          `\\t(${s},${s + Math.round(d * 0.6)},\\fscx${peak}\\fscy${peak})\\t(${s + Math.round(d * 0.6)},${s + d},\\fscx${final}\\fscy${final})` +
          `\\t(${s},${s + 1},\\1c${assColor(kw ? anim.keyword.fill : anim.karaoke.fill)})\\t(${e},${e + 1},\\1c${finalColor})}${w.text}`;
      }).join('');
      // 贴图：ASS 不能显示图片（只能用 \p 矢量绘图近似），这里不画，记为能力缺口。
    }
    lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${text}`);
  }
  return `${lines.join('\n')}\n`;
}
