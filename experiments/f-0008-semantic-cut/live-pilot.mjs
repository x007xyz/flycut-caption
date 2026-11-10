// Optional single-request protocol pilot. It does not measure semantic quality.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, buildWindow, validateCandidates } from './protocol.mjs';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const clip = arg('clip', 'coscup-BWgFrY91F_I');
const startSentence = Number(arg('start-sentence', '0'));
const endSentence = Number(arg('end-sentence', '14'));
const model = arg('model', 'deepseek-chat');
const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const apiKey = process.env.DEEPSEEK_API_KEY;
const dryRun = process.argv.includes('--dry-run');
const out = arg('out', '');

const transcript = JSON.parse(readFileSync(join(root, `tests/media/external/${clip}.transcript.json`), 'utf8'));
const first = transcript.chunks[startSentence];
const last = transcript.chunks[endSentence];
if (!first || !last) throw new Error('Sentence range is outside the transcript');
const index = buildIndex(transcript, { transcriptId: clip });
const request = buildWindow(index, first.wordIds[0], last.wordIds.at(-1), { contextSentences: 0, maxCandidates: 30 });

function emit(payload, code = 0) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, body); }
  process.stdout.write(body);
  process.exitCode = code;
}

if (dryRun) {
  emit({ status: 'dry-run', clip, sentences: [startSentence, endSentence], words: request.sentences.reduce((sum, item) => sum + item.words.length, 0), base: request.base, promptChars: SYSTEM_PROMPT.length + buildUserPrompt(request).length });
} else if (!apiKey) {
  emit({ status: 'not-run', blocker: 'DEEPSEEK_API_KEY is not set in this environment', clip }, 2);
} else {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 1500,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(request) },
        ],
      }),
    });
    const latencyMs = Math.round(performance.now() - started);
    const raw = await response.text();
    if (!response.ok) {
      emit({ status: 'error', blocker: `HTTP ${response.status}`, detail: raw.slice(0, 500), latencyMs, clip, model }, 1);
    } else {
      const data = JSON.parse(raw);
      const content = data?.choices?.[0]?.message?.content ?? '';
      const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      let candidates = [];
      let validation = 'ok';
      try { candidates = validateCandidates(parsed, request, index); }
      catch (error) { validation = `${error.code}: ${error.message}`; }
      emit({
        status: validation === 'ok' ? 'ok' : 'invalid-response', clip, model, latencyMs,
        usage: data?.usage ?? null, validation, candidateCount: candidates.length,
        candidates: candidates.map(({ candidateId, startWordId, endWordId, scope, category, confidence, reason, startMs, endMs }) =>
          ({ candidateId, startWordId, endWordId, scope, category, confidence, reason, startMs, endMs })),
        responseChars: content.length,
      }, validation === 'ok' ? 0 : 1);
    }
  } catch (error) {
    emit({ status: 'error', blocker: error instanceof Error ? error.message : String(error), latencyMs: Math.round(performance.now() - started), clip, model }, 1);
  }
}
