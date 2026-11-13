import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {
  drawFrame,
  emptySubtitleGraphicStyle,
  frameKey,
  layoutScene,
  mapRawRangesToDisplay,
  subtitleBand,
  subtitleGraphicSceneSchema,
  type SubtitleGraphicScene,
  type SubtitleGraphicStyle,
} from '../../shared/subtitle-graphics/index.ts';
import {
  createKeywordBase,
  reconcileChunkKeywords,
  toggleChunkKeyword,
  tokenizeSubtitleForKeywords,
  validateKeywordModelResponse,
  KeywordContractError,
} from '../../shared/text/keywords.ts';

(globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  private readonly canvas: ReturnType<typeof createCanvas>;
  constructor(width: number, height: number) { this.canvas = createCanvas(width, height); }
  getContext(type: '2d') { return this.canvas.getContext(type); }
};

const FONT_DIR = new URL('../../src-tauri/shared_assets/subtitle-fonts/', import.meta.url).pathname;
const FAMILY = 'FlyCutKeywordNotoSansSC';
if (!GlobalFonts.has(FAMILY)) {
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Regular.otf`, FAMILY));
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Bold.otf`, FAMILY));
}

function graphicStyle(overrides: Partial<SubtitleGraphicStyle> = {}): SubtitleGraphicStyle {
  return {
    ...emptySubtitleGraphicStyle(),
    fontFamily: FAMILY,
    fontSizeRatio: 0.05,
    borderWidth: 2,
    color: '#FFFFFF',
    keywordColorEnabled: true,
    keywordColor: '#FF2D2D',
    keywordScale: 1.4,
    keywordBackgroundColor: '#1E3A8A',
    keywordBackgroundOpacity: 0.9,
    ...overrides,
  };
}

function scene(overrides: Partial<SubtitleGraphicScene> = {}): SubtitleGraphicScene {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 4,
    fontId: 'noto-sans-sc',
    fontFamily: FAMILY,
    displayMode: 'Bilingual',
    maxWidthRatio: 0.9,
    primary: graphicStyle(),
    secondary: graphicStyle({ fontSizeRatio: 0.034, keywordScale: 1, keywordBackgroundOpacity: 0 }),
    cues: [
      {
        id: 's1',
        start: 0,
        end: 2,
        text: '今天我们来聊一聊 React 19 的并发渲染和性能优化方案',
        secondText: 'Today we discuss React 19 concurrent rendering',
        keywords: [{ start: 9, end: 17, text: 'React 19' }],
      },
    ],
    ...overrides,
  };
}

function alphaBox(data: Uint8ClampedArray, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function colorBox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  match: (r: number, g: number, b: number, a: number) => boolean,
) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (match(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return count ? { minX, minY, maxX, maxY, count } : null;
}

test('F-0025/AC-1 AC-4 keyword ranges map across punctuation stripping and reject stale offsets', () => {
  const raw = '  世界，你好世界！ ';
  const secondIdx = raw.lastIndexOf('世界');
  const mapped = mapRawRangesToDisplay(raw, [{ start: secondIdx, end: secondIdx + 2, text: '世界' }]);
  assert.deepEqual(mapped, [{ start: 4, end: 6, text: '世界' }]);

  const toggled = toggleChunkKeyword(undefined, raw, secondIdx, secondIdx + 2, 'manual');
  assert.deepEqual(toggled, [{ start: secondIdx, end: secondIdx + 2, text: '世界', source: 'manual' }]);
  assert.equal(toggleChunkKeyword(toggled, raw, secondIdx, secondIdx + 2, 'manual'), undefined);

  assert.equal(reconcileChunkKeywords(toggled, '世界，再见了朋友'), undefined);

  const tokens = tokenizeSubtitleForKeywords('今天聊聊 React 19。');
  assert.ok(tokens.some(t => t.selectable && t.text === 'React'));
  assert.ok(tokens.some(t => !t.selectable && t.text === '。'));
});

test('F-0025/AC-1 AC-2 scene schema validates keyword bounds and rejects mismatched text', () => {
  assert.ok(subtitleGraphicSceneSchema.parse(scene()));
  assert.throws(() => subtitleGraphicSceneSchema.parse(scene({
    cues: [{ id: 's1', start: 0, end: 2, text: '今天聊聊', keywords: [{ start: 0, end: 10 }] }],
  })), /outside cue text/);
  assert.throws(() => subtitleGraphicSceneSchema.parse(scene({
    cues: [{ id: 's1', start: 0, end: 2, text: '今天聊聊', keywords: [{ start: 0, end: 2, text: '明天' }] }],
  })), /does not match cue text/);
  assert.throws(() => subtitleGraphicSceneSchema.parse(scene({
    cues: [{
      id: 's1', start: 0, end: 2, text: '今天聊聊',
      keywords: [{ start: 0, end: 2 }, { start: 1, end: 3 }],
    }],
  })), /non-overlapping/);
});

test('F-0025/AC-2 enlarged keywords reserve horizontal width and vertical height across 3 aspects without collision or clipping', () => {
  const ctx = createCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
  const aspects = [
    [1920, 1080, 0.9],
    [1080, 1920, 0.85],
    [1080, 1080, 0.88],
  ] as const;

  const longText = '前面是一段很长的铺垫文字用来测试自动换行后紧跟着的核心关键词强调效果和后续补充说明文字';
  const kwStart = longText.indexOf('核心关键词');
  const kwEnd = kwStart + '核心关键词'.length;

  for (const [width, height, maxWidthRatio] of aspects) {
    const s = scene({
      width,
      height,
      maxWidthRatio,
      primary: graphicStyle({ keywordScale: 1.5, keywordBackgroundOpacity: 0.9, borderWidth: 4 }),
      cues: [
        {
          id: 's1',
          start: 0,
          end: 2,
          text: longText,
          keywords: [{ start: kwStart, end: kwEnd, text: '核心关键词' }],
        },
      ],
    });
    const maxWidth = Math.round(width * maxWidthRatio);
    const layouts = layoutScene(ctx, s);
    const primary = layouts[0].primary!;
    assert.ok(primary.lines.length >= 1);
    for (let li = 0; li < primary.lines.length; li += 1) {
      const line = primary.lines[li];
      assert.ok(line.width <= maxWidth + 2, `${width}x${height} line width ${line.width} <= ${maxWidth}`);
      if (line.runs?.some(r => r.isKeyword)) {
        assert.ok((line.lineHeight ?? 0) > primary.lineHeight, 'line with enlarged keyword expands lineHeight');
      }
      if (line.runs) {
        for (let i = 1; i < line.runs.length; i += 1) {
          const prev = line.runs[i - 1];
          const curr = line.runs[i];
          assert.ok(curr.x >= prev.x + prev.width - 0.01, `${width}x${height} runs do not overlap`);
          if (curr.isKeyword) {
            assert.ok(curr.glyphX - (prev.glyphX + prev.glyphWidth) >= 4, 'enlarged keyword leaves clearance after previous run');
          }
          if (prev.isKeyword) {
            assert.ok(curr.glyphX - (prev.glyphX + prev.glyphWidth) >= 4, 'enlarged keyword leaves clearance before next run');
          }
        }
      }
    }

    const band = subtitleBand(s, layouts);
    const full = createCanvas(width, height);
    const bandCanvas = createCanvas(band.width, band.height);
    assert.equal(drawFrame(full.getContext('2d') as unknown as CanvasRenderingContext2D, s, 0.5), true);
    assert.equal(drawFrame(bandCanvas.getContext('2d') as unknown as CanvasRenderingContext2D, s, 0.5, { layer: band, layouts }), true);

    const fullData = full.getContext('2d').getImageData(0, 0, width, height).data;
    const bandData = bandCanvas.getContext('2d').getImageData(0, 0, band.width, band.height).data;
    const fullAlpha = alphaBox(fullData, width, height);
    const bandAlpha = alphaBox(bandData, band.width, band.height);
    assert.ok(fullAlpha && bandAlpha, `${width}x${height} renders visible pixels`);
    assert.ok(fullAlpha.minX >= 0 && fullAlpha.maxX < width, 'full frame not clipped horizontally');
    assert.ok(fullAlpha.minY >= 0 && fullAlpha.maxY < height, 'full frame not clipped vertically');
    assert.ok(Math.abs(fullAlpha.minX - bandAlpha.minX) <= 2, `${width}x${height} minX bbox offset <= 2px`);
    assert.ok(Math.abs(fullAlpha.maxX - bandAlpha.maxX) <= 2, `${width}x${height} maxX bbox offset <= 2px`);
    assert.ok(Math.abs((fullAlpha.minY - band.y) - bandAlpha.minY) <= 2, `${width}x${height} minY bbox offset <= 2px`);
    assert.ok(Math.abs((fullAlpha.maxY - band.y) - bandAlpha.maxY) <= 2, `${width}x${height} maxY bbox offset <= 2px`);

    const red = colorBox(fullData, width, height, (r, g, b, a) => r > 180 && g < 90 && b < 90 && a > 80);
    const blue = colorBox(fullData, width, height, (r, g, b, a) => b > 100 && r < 60 && a > 80);
    const white = colorBox(fullData, width, height, (r, g, b, a) => r > 210 && g > 210 && b > 210 && a > 80);
    assert.ok(red && red.count > 100, `${width}x${height} keyword red pixels exist`);
    assert.ok(blue && blue.count > 100, `${width}x${height} keyword background blue pixels exist`);
    assert.ok(white && white.count > 100, `${width}x${height} normal white pixels exist`);
  }
});

test('F-0025/AC-2 enlarged keyword causes earlier line wrap when width reservation exceeds remaining line space', () => {
  const ctx = createCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
  const text = '一二三四五六七甲乙丙丁';
  const baseScene = scene({
    width: 1080,
    height: 1920,
    maxWidthRatio: 0.85,
    primary: graphicStyle({ fontSizeRatio: 0.04, keywordScale: 1, keywordBackgroundOpacity: 0 }),
    cues: [{ id: 'w1', start: 0, end: 2, text, keywords: [{ start: 7, end: 11, text: '甲乙丙丁' }] }],
  });
  const enlargedScene = scene({
    width: 1080,
    height: 1920,
    maxWidthRatio: 0.85,
    primary: graphicStyle({ fontSizeRatio: 0.04, keywordScale: 1.8, keywordBackgroundOpacity: 0.9 }),
    cues: [{ id: 'w1', start: 0, end: 2, text, keywords: [{ start: 7, end: 11, text: '甲乙丙丁' }] }],
  });
  const baseLines = layoutScene(ctx, baseScene)[0].primary!.lines;
  const enlargedLines = layoutScene(ctx, enlargedScene)[0].primary!.lines;
  assert.equal(baseLines.length, 1); assert.equal(enlargedLines.length, 2, 'enlarged keyword wraps onto next line instead of overflowing maxWidth');
});

test('F-0025/AC-1 AC-2 frameKey updates when cue keywords or keyword style changes', () => {
  const s = scene();
  const k1 = frameKey(s, 0.5);
  const noKw = scene({ cues: [{ ...s.cues[0], keywords: undefined }] });
  assert.notEqual(k1, frameKey(noKw, 0.5));
  const scaled = scene({ primary: graphicStyle({ keywordScale: 1.6 }) });
  assert.notEqual(k1, frameKey(scaled, 0.5));
  const recolored = scene({ primary: graphicStyle({ keywordColor: '#00FF00' }) });
  assert.notEqual(k1, frameKey(recolored, 0.5));
});

test('F-0025/AC-3 AC-8 validateKeywordModelResponse grounds exact substrings and rejects hallucinations or stale base', () => {
  const items = [
    { id: 'c1', text: '今天我们来聊一聊 React 19 的并发渲染' },
    { id: 'c2', text: '下一节讲解性能优化' },
  ];
  const base = createKeywordBase(items);
  const request = { base, language: 'zh', items };

  const valid = validateKeywordModelResponse({
    version: 1,
    base,
    items: [
      { id: 'c1', keywords: ['React 19', '并发渲染'] },
      { id: 'c2', keywords: ['性能优化'] },
    ],
  }, request);
  assert.equal(valid.length, 2);
  assert.deepEqual(valid[0].keywords, [
    { start: 9, end: 17, text: 'React 19', source: 'ai' },
    { start: 19, end: 23, text: '并发渲染', source: 'ai' },
  ]);

  assert.throws(() => validateKeywordModelResponse({
    version: 1,
    base: 'wrong-base',
    items: [],
  }, request), (err: unknown) => err instanceof KeywordContractError && err.code === 'STALE_BASE');

  assert.throws(() => validateKeywordModelResponse({
    version: 1,
    base,
    items: [{ id: 'c1', keywords: ['Vue 3'] }],
  }, request), (err: unknown) => err instanceof KeywordContractError && err.code === 'SUBSTRING_NOT_FOUND');

  assert.throws(() => validateKeywordModelResponse({
    version: 1,
    base,
    items: [{ id: 'unknown-id', keywords: ['React 19'] }],
  }, request), (err: unknown) => err instanceof KeywordContractError && err.code === 'UNKNOWN_ID');
});

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHost } from '../../server/app.ts';
import type { JobSnapshot } from '../../shared/protocol.ts';

test('F-0025/AC-3 AC-8 Host text.suggestKeywords resolves saved AI config without leaking key and rejects bad outputs', async () => {
  const seen: Array<{ auth?: string; body: string }> = [];
  let mode: 'valid' | 'bad-substring' | 'stale-base' = 'valid';
  const modelServer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const user = JSON.parse(parsed.messages[1].content);
    seen.push({ auth: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    const content = mode === 'stale-base'
      ? JSON.stringify({ version: 1, base: 'wrong-base', items: [] })
      : mode === 'bad-substring'
        ? JSON.stringify({ version: 1, base: user.base, items: [{ id: 'c1', keywords: ['不存在的词'] }] })
        : JSON.stringify({ version: 1, base: user.base, items: [{ id: 'c1', keywords: ['React 19'] }] });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(done => modelServer.listen(0, '127.0.0.1', done));
  const modelUrl = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;

  const home = await mkdtemp(join(tmpdir(), 'flycut-f0025-kw-'));
  const ctx = await createHost({ home, token: 'f0025-token', port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    patches: [{ source: 'f0025-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer f0025-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i += 1) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await delay(20);
    }
    throw new Error('job did not settle');
  };

  try {
    const identity = await call<{ hostId: string }>('projects.identity');
    const saved = await call<{ status: string; configId: string }>('aiSettings.save', {
      hostId: identity.hostId,
      expectedRevision: 0,
      config: { name: 'Keyword fixture', baseUrl: modelUrl, model: 'fixture-kw', apiKey: 'f0025-secret' },
    });
    assert.equal(saved.status, 'saved');
    const items = [{ id: 'c1', text: '今天聊聊 React 19 新特性' }];
    const kwBase = createKeywordBase(items);
    const rpcPayload = { configId: saved.configId, request: { base: kwBase, language: 'zh', items } };
    assert.equal(JSON.stringify(rpcPayload).includes('f0025-secret'), false);

    const okJob = await wait((await call<JobSnapshot>('text.suggestKeywords', rpcPayload)).id);
    assert.equal(okJob.status, 'complete', okJob.error);
    assert.deepEqual((okJob.result as any).items, [
      { id: 'c1', keywords: [{ start: 5, end: 13, text: 'React 19', source: 'ai' }] },
    ]);
    assert.equal(seen[0].auth, 'Bearer f0025-secret');
    assert.equal(seen[0].body.includes('f0025-secret'), false);
    assert.equal((await readFile(join(home, 'jobs', `${okJob.id}.json`), 'utf8')).includes('f0025-secret'), false);

    mode = 'bad-substring';
    const badJob = await wait((await call<JobSnapshot>('text.suggestKeywords', rpcPayload)).id);
    assert.equal(badJob.status, 'error');
    assert.match(badJob.error ?? '', /SUBSTRING_NOT_FOUND/);

    mode = 'stale-base';
    const staleJob = await wait((await call<JobSnapshot>('text.suggestKeywords', rpcPayload)).id);
    assert.equal(staleJob.status, 'error');
    assert.match(staleJob.error ?? '', /STALE_BASE/);
  } finally {
    await ctx.fiber.dispose();
    await new Promise<void>(done => modelServer.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});
