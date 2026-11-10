#!/usr/bin/env node
// 中文口播转写评测（F-0001）：对每段逐字参考文本，用内置 sherpa-onnx 各模型转写评测范围，
// 输出字错率、语气词召回、口头禅召回、实时率和峰值内存。
//
//   pnpm eval:asr                              # 已下载的模型（不含 EXCLUDED）× tests/fixtures/asr-reference/ 下全部参考文本
//   pnpm eval:asr --models sensevoice-…,paraformer-…
//   pnpm eval:asr --allow-draft                # 参考文本还没听校完时试算（分歧处取 A，结果不能当结论）
//   pnpm eval:asr --long                       # 长音频：两段 COSCUP 拼成约 60 分钟，只记耗时和内存
//   pnpm eval:asr --check-reference            # 只检查听校就绪情况，不需要模型，也不启动推理
//
// 素材在 tests/media/（不入库，用 pnpm fetch:test-media 或各样本 .md 里的命令获取）。
// 结果写到 test-results/asr-eval/：report.md、report.json，模型输出缓存在 cache/（--rerun 重新转写）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadManifest, loadModelFromManifest, projectRoot, resolveFfmpeg, resolveFsmnVadDir, resolveModelDir, resolveSidecar } from '../tests/lib/asrPaths.mjs';
import { evaluate, parseReference } from '../tests/lib/asrEval.mjs';

const { values } = parseArgs({ options: {
  reference: { type: 'string', multiple: true }, models: { type: 'string' }, out: { type: 'string', default: 'test-results/asr-eval' },
  'allow-draft': { type: 'boolean', default: false }, rerun: { type: 'boolean', default: false }, long: { type: 'boolean', default: false },
  'check-reference': { type: 'boolean', default: false },
} });

const root = projectRoot();
const refDir = join(root, 'tests/fixtures/asr-reference');
const referenceFiles = values.reference ?? readdirSync(refDir).filter((f) => f.endsWith('.md')).map((f) => join(refDir, f));
if (values['check-reference']) {
  const references = referenceFiles.map((file) => {
    try {
      const reference = parseReference(readFileSync(file, 'utf8'), { allowDraft: true });
      return { file, status: reference.meta.status, sentences: reference.sentences.length, unresolved: reference.unresolved,
        referenceBasis: reference.meta.reference_basis ?? null, timestampBasis: reference.meta.timestamp_basis ?? null,
        ready: reference.reviewed && reference.unresolved === 0,
        mediaAvailable: existsSync(join(root, 'tests/media', reference.meta.media ?? '')) && Boolean(reference.meta.media) };
    } catch (error) { return { file, ready: false, error: error.message }; }
  });
  const ready = references.length > 0 && references.every((reference) => reference.ready);
  console.log(JSON.stringify({ ready, references }, null, 2));
  process.exit(ready ? 0 : 1);
}
const sidecar = resolveSidecar(root); const ffmpeg = resolveFfmpeg(root); const vadDir = resolveFsmnVadDir(root);
const missing = [!sidecar && 'funasr-asr sidecar（pnpm build:funasr-sidecar）', !ffmpeg && 'ffmpeg（pnpm fetch:ffmpeg）', !vadDir && 'FSMN VAD（pnpm fetch:shared-assets）'].filter(Boolean);
if (missing.length) { console.error(`缺少：${missing.join('、')}`); process.exit(1); }

const manifest = loadManifest(root);
/** 不再参加评测的模型（维护者 2026-11-05 决定，见 F-0001 调研报告）：TeleSpeech 质量不够，Zipformer CTC 输出乱码。 */
const EXCLUDED = new Set(['telespeech_ctc', 'zipformer_ctc']);
const modelIds = values.models ? values.models.split(',').map((s) => s.trim())
  : manifest.models.filter((m) => m.enabled && !EXCLUDED.has(m.family) && resolveModelDir(m.id, root)).map((m) => m.id);
const models = modelIds.map((id) => {
  const dir = resolveModelDir(id, root); if (!dir) { console.error(`模型 ${id} 没有下载`); process.exit(1); }
  return { ...loadModelFromManifest(id, root), dir };
});
if (!models.length) { console.error('没有已下载的模型。先在应用「设置 → 模型」里下载'); process.exit(1); }

const outDir = join(root, values.out); const cacheDir = join(outDir, 'cache');
mkdirSync(cacheDir, { recursive: true });

/** 跑一次 sidecar，记录耗时和峰值内存（macOS / Linux 的 /usr/bin/time）。 */
function transcribe(input, model) {
  const args = ['--input', input, '--model', model.dir, '--model-type', model.family, '--recognizer-config', JSON.stringify(model.recognizer_config),
    '--vad-type', 'fsmn', '--vad-dir', vadDir, '--language', 'zh', '--timestamp-mode', 'auto', '--output-json'];
  const timer = process.platform === 'darwin' ? ['-l'] : process.platform === 'linux' ? ['-v'] : null;
  const started = Date.now();
  const result = timer && existsSync('/usr/bin/time')
    ? spawnSync('/usr/bin/time', [...timer, sidecar, ...args], { encoding: 'utf8', env: { ...process.env, FFMPEG_PATH: ffmpeg }, maxBuffer: 256 * 1024 * 1024 })
    : spawnSync(sidecar, args, { encoding: 'utf8', env: { ...process.env, FFMPEG_PATH: ffmpeg }, maxBuffer: 256 * 1024 * 1024 });
  const elapsedMs = Date.now() - started;
  if (result.status !== 0) throw new Error(`${model.id} 转写失败：\n${(result.stderr ?? '').slice(-2000)}`);
  const rss = /(\d+)\s+maximum resident set size/.exec(result.stderr ?? '')?.[1] ?? /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(result.stderr ?? '')?.[1];
  const peakBytes = rss ? Number(rss) * (process.platform === 'darwin' ? 1 : 1024) : null;
  return { transcript: JSON.parse(result.stdout), elapsedMs, peakBytes };
}

function clip(media, start, end, dir) {
  const output = join(dir, `${basename(media)}-${start}-${end}.wav`);
  const run = spawnSync(ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-to', String(end), '-i', media, '-ac', '1', '-ar', '16000', output], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ffmpeg 截取失败：${run.stderr}`);
  return output;
}

const shift = (transcript, offset) => ({ ...transcript,
  chunks: transcript.chunks.map((c) => ({ ...c, timestamp: [c.timestamp[0] + offset, c.timestamp[1] + offset] })),
  wordChunks: transcript.wordChunks?.map((c) => ({ ...c, timestamp: [c.timestamp[0] + offset, c.timestamp[1] + offset] })) });

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const gb = (b) => (b ? `${(b / 1024 ** 3).toFixed(2)} GB` : '—');
const temp = mkdtempSync(join(tmpdir(), 'flycut-eval-asr-'));

try {
  if (values.long) {
    const parts = ['external/coscup-BWgFrY91F_I.mp4', 'external/coscup-3UegVxMFyeo.mp4'].map((p) => join(root, 'tests/media', p));
    const list = join(temp, 'list.txt');
    writeFileSync(list, parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n'));
    const long = join(temp, 'long-60min.wav');
    const run = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ac', '1', '-ar', '16000', long], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    const probe = spawnSync(ffmpeg, ['-i', long], { encoding: 'utf8' }).stderr;
    const [, h, m, s] = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe);
    const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
    const rows = [];
    for (const model of models) {
      console.log(`长音频 ${(seconds / 60).toFixed(1)} 分钟 × ${model.id} …`);
      const { transcript, elapsedMs, peakBytes } = transcribe(long, model);
      rows.push({ model: model.id, audioSeconds: seconds, elapsedMs, rtf: elapsedMs / 1000 / seconds, peakBytes, sentences: transcript.chunks.length,
        lastEnd: transcript.chunks.at(-1)?.timestamp[1] ?? 0 });
    }
    writeFileSync(join(outDir, 'long.json'), `${JSON.stringify(rows, null, 2)}\n`);
    console.log(['| 模型 | 音频 | 耗时 | 实时率 | 峰值内存 | 句数 | 最后一句结束 |', '|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.model} | ${(r.audioSeconds / 60).toFixed(1)} 分钟 | ${(r.elapsedMs / 1000).toFixed(0)} 秒 | ${r.rtf.toFixed(3)} | ${gb(r.peakBytes)} | ${r.sentences} | ${(r.lastEnd / 60).toFixed(1)} 分钟 |`)].join('\n'));
    process.exit(0);
  }

  const results = [];
  for (const file of referenceFiles) {
    const reference = parseReference(readFileSync(file, 'utf8'), { allowDraft: values['allow-draft'] });
    const sample = basename(file, '.md');
    const media = join(root, 'tests/media', reference.meta.media);
    if (!existsSync(media)) { console.warn(`跳过 ${sample}：没有素材 ${media}`); continue; }
    let input;
    for (const model of models) {
      const cache = join(cacheDir, `${sample}__${model.id}.json`);
      let run;
      if (!values.rerun && existsSync(cache)) run = JSON.parse(readFileSync(cache, 'utf8'));
      else {
        input ??= clip(media, reference.range.start, reference.range.end, temp);
        console.log(`${sample} × ${model.id} …`);
        const raw = transcribe(input, model);
        run = { ...raw, transcript: shift(raw.transcript, reference.range.start) };
        writeFileSync(cache, JSON.stringify(run));
      }
      const audioSeconds = reference.range.end - reference.range.start;
      results.push({ sample, model: model.id, family: model.family, reviewed: reference.reviewed, unresolved: reference.unresolved,
        referenceBasis: reference.meta.reference_basis ?? null, referenceSha256: reference.meta.reference_sha256 ?? null,
        ...evaluate(reference, run.transcript), elapsedMs: run.elapsedMs, rtf: run.elapsedMs / 1000 / audioSeconds, peakBytes: run.peakBytes, audioSeconds });
    }
  }
  const provisional = results.some((r) => !r.reviewed);
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), provisional, results }, null, 2)}\n`);
  const lines = [
    '# 中文口播转写评测', '',
    provisional ? '> ⚠ 参考文本还没听校完（分歧处取初稿 A），以下数字只能当参考，不能当结论。\n' : '',
    results.some((r) => r.referenceBasis === 'maintainer-accepted-corrected-asr')
      ? '> 文字基准为维护者确认的 SenseVoice 精校版，存在来源偏差，未声称经过独立人工逐字听校。现有 ASR 时间戳未验证，本报告不提供时间误差结论。\n' : '',
    '| 样本 | 模型 | 字错率 | 替换 / 删除 / 插入 | 语气词召回 | 多出的语气词 | 那个 | 就是 | 实时率 | 峰值内存 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.sample} | ${r.model} | ${pct(r.cer)} | ${r.substitutions} / ${r.deletions} / ${r.insertions} | ${pct(r.fillers.recall)}（${r.fillers.recalled}/${r.fillers.reference}） | ${r.fillers.extra} | ${r.markers.那个.recalled}/${r.markers.那个.reference} | ${r.markers.就是.recalled}/${r.markers.就是.reference} | ${r.rtf.toFixed(3)} | ${gb(r.peakBytes)} |`),
    '', '字错率去掉标点和单字语气词（嗯 / 呃 / 额 / 啊 / 哦 / 诶 等），写法统一规则见 tests/lib/referenceDraft.mjs。语气词召回：参考文本里的语气词，在对齐位置识别出同一类语气词的比例。', '',
  ];
  writeFileSync(join(outDir, 'report.md'), lines.join('\n'));
  console.log(lines.join('\n'));
} finally { rmSync(temp, { recursive: true, force: true }); }
