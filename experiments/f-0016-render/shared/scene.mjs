// F-0016 测试场景：前端预览和后端导出共用同一份数据。
// 只用确定性的伪随机，保证每次生成的字幕完全相同。

export const FONT_FAMILY = 'NotoSansSCExp';

// 口播常见的中英混排句子（自拟，无版权问题）。
const CORPUS = [
  '今天我们来聊一聊 React 19 的新特性',
  '这个功能在 macOS 和 Windows 上表现不一样',
  '先把 API Key 配置好，然后点击开始识别',
  '很多人问我为什么不用剪映的智能字幕',
  '其实最花时间的是删停顿和口误',
  '我们用 FFmpeg 把字幕烧进视频里',
  '这一段我重新录了三遍才满意',
  '如果你觉得有用，记得点赞 👍 收藏',
  '下面看一下 GPU 加速到底快了多少',
  '整个流程大概十分钟就能跑完',
  '注意这里的时间戳是按字对齐的',
  '我们下期再见，拜拜',
];

const KEYWORDS = new Set(['React', 'macOS', 'Windows', 'API', 'Key', 'FFmpeg', 'GPU', '十分钟', '点赞']);

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把一句话切成「字词」：英文按单词，中文每 1–2 个字一个词，与 ASR 字词时间戳粒度接近。 */
function tokenize(sentence, rand) {
  const tokens = [];
  const re = /[A-Za-z0-9]+|\s+|[^\sA-Za-z0-9]/gu;
  const raw = sentence.match(re) ?? [];
  let buf = '';
  for (const piece of raw) {
    if (/^\s+$/.test(piece)) {
      if (buf) tokens.push(buf), (buf = '');
      continue;
    }
    if (/^[A-Za-z0-9]+$/.test(piece)) {
      if (buf) tokens.push(buf), (buf = '');
      tokens.push(piece);
      continue;
    }
    buf += piece;
    if (KEYWORDS.has(buf) || buf.length >= (rand() < 0.5 ? 1 : 2)) {
      tokens.push(buf);
      buf = '';
    }
  }
  if (buf) tokens.push(buf);
  // 把被拆开的中文关键词合并回来（例如「十分」「钟」）
  return tokens;
}

/** 生成 duration 秒的字幕：每条 1.6–3.2 秒，条间留 0–0.6 秒空隙。 */
export function buildCues(duration, seed = 16) {
  const rand = mulberry32(seed);
  const cues = [];
  let t = 0.5;
  let i = 0;
  while (t < duration - 1) {
    const sentence = CORPUS[i % CORPUS.length];
    i += 1;
    const tokens = tokenize(sentence, rand);
    const len = 1.6 + rand() * 1.6;
    const end = Math.min(duration, t + len);
    const per = (end - t) / tokens.length;
    const words = tokens.map((text, k) => ({
      text,
      start: +(t + k * per).toFixed(3),
      end: +(t + (k + 1) * per).toFixed(3),
      keyword: KEYWORDS.has(text),
    }));
    cues.push({ start: +t.toFixed(3), end: +end.toFixed(3), words });
    t = end + rand() * 0.6;
  }
  return cues;
}

// 三种静态样式，对应现有预设 white-black（描边）、yellow-black（描边 + 阴影）、black-bg（底框）。
export const STYLES = {
  outline: {
    fontWeight: 700, fontSizeRatio: 0.058, fill: '#FFFFFF', stroke: '#000000', strokeRatio: 0.12,
    shadow: null, box: null, gradient: null,
  },
  shadow: {
    fontWeight: 700, fontSizeRatio: 0.058, fill: '#FFD400', stroke: '#000000', strokeRatio: 0.08,
    shadow: { color: 'rgba(0,0,0,0.6)', blurRatio: 0.15, dxRatio: 0.04, dyRatio: 0.06 }, box: null, gradient: null,
  },
  box: {
    fontWeight: 400, fontSizeRatio: 0.052, fill: '#FFFFFF', stroke: null, strokeRatio: 0,
    shadow: null, box: { color: 'rgba(0,0,0,0.65)', paddingRatio: 0.3, radiusRatio: 0.25 }, gradient: null,
  },
  // 动画场景用：渐变填充 + 描边
  gradient: {
    fontWeight: 700, fontSizeRatio: 0.062, fill: '#FFFFFF', stroke: '#1A1A1A', strokeRatio: 0.1,
    shadow: null, box: null, gradient: ['#FFF6B0', '#FF7A00'],
  },
};

// 动画参数全部是数据，不写死在绘制代码里。
export const ANIMATIONS = {
  none: null,
  pop: {
    // 逐字弹出：每个字词在自己的 start 时刻开始，0.28 秒内从 0.4 倍回弹到 1 倍
    enter: { duration: 0.28, easing: 'backOut', from: { scale: 0.4, opacity: 0, dy: 0.25 }, to: { scale: 1, opacity: 1, dy: 0 } },
    karaoke: { fill: '#3CF0FF' }, // 逐字高亮：已读到的字词换色
    keyword: { scale: 1.22, fill: '#FF3B6B' }, // 关键词放大换色
    sticker: { every: 4, size: 0.12, duration: 0.5, easing: 'backOut' }, // 每 4 条字幕出现一个贴图
  },
};

export const ASPECTS = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

export function buildScene({ aspect = 'landscape', style = 'outline', animation = 'none', duration = 60, fps = 25, manualShadow = false } = {}) {
  const size = ASPECTS[aspect];
  return {
    ...size,
    fps,
    duration,
    fontFamily: FONT_FAMILY,
    manualShadow,
    style: STYLES[style],
    animation: ANIMATIONS[animation],
    maxWidthRatio: aspect === 'landscape' ? 0.8 : 0.86,
    bottomRatio: aspect === 'portrait' ? 0.26 : 0.1,
    cues: buildCues(duration),
  };
}

/** 一致性测试取样的时间点：静态段、动画进行中、关键词、贴图出现中。 */
export function sampleTimes(scene, count = 12) {
  const out = [];
  for (let i = 0; i < count && i < scene.cues.length; i += 1) {
    const cue = scene.cues[i];
    const w = cue.words[Math.min(cue.words.length - 1, 2 + (i % 3))];
    // 一半取字词刚开始（动画中途），一半取字幕条末尾（全部动画结束）
    out.push(+(i % 2 === 0 ? w.start + 0.09 : cue.end - 0.05).toFixed(3));
  }
  return out;
}
