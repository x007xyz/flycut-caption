// ASR API 协议：地址校验、时间戳解析与多段合并。
// 关键约束：任何不完整或不合法的词级时间戳都不能被提升为「可精确剪切」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePcmWav,
  mergeASRApiTranscripts,
  newCorrelationId,
  normalizeASRApiResponse,
  transcriptionEndpoint,
  validateASRApiConfig,
} from '../shared/asr/apiProtocol.ts';

const config = (overrides = {}) => ({
  id: 'cfg-1',
  name: '本地服务',
  baseUrl: 'https://example.com/v1',
  model: 'whisper-1',
  timestamps: 'word',
  timeoutSeconds: 120,
  ...overrides,
});

test('transcriptionEndpoint completes the transcriptions path', () => {
  assert.equal(transcriptionEndpoint('https://example.com/v1/'), 'https://example.com/v1/audio/transcriptions');
  assert.equal(transcriptionEndpoint('https://example.com/v1/audio/transcriptions'), 'https://example.com/v1/audio/transcriptions');
  assert.equal(transcriptionEndpoint('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/audio/transcriptions');
});

test('transcriptionEndpoint refuses plaintext remote hosts and embedded secrets', () => {
  for (const invalid of [
    'http://example.com/v1',
    'file:///tmp',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=abc',
    'https://example.com/v1#frag',
    'not a url',
  ]) {
    assert.throws(() => transcriptionEndpoint(invalid), undefined, invalid);
  }
});

test('validateASRApiConfig rejects unusable settings', () => {
  assert.doesNotThrow(() => validateASRApiConfig(config()));
  assert.doesNotThrow(() => validateASRApiConfig(config({ apiKey: '' })));
  assert.throws(() => validateASRApiConfig(config({ name: '  ' })), /名称/);
  assert.throws(() => validateASRApiConfig(config({ model: '' })), /模型/);
  assert.throws(() => validateASRApiConfig(config({ timestamps: 'sentence' })), /时间戳/);
  assert.throws(() => validateASRApiConfig(config({ timeoutSeconds: 5 })), /超时/);
  assert.throws(() => validateASRApiConfig(config({ timeoutSeconds: 601 })), /超时/);
});

test('segments plus aligned words enable word-level cutting', () => {
  const transcript = normalizeASRApiResponse({
    text: '你好 world',
    language: 'zh',
    segments: [{ text: '你好 world', start: 0, end: 4 }],
    words: [
      { word: '你好', start: 0, end: 1.5 },
      { word: 'world', start: 2, end: 3.8 },
    ],
  }, 10);

  assert.equal(transcript.hasWordTimestamps, true);
  assert.equal(transcript.chunks.length, 1);
  assert.deepEqual(transcript.chunks[0].wordIds, ['api-w-0', 'api-w-1']);
  assert.deepEqual(transcript.wordChunks.map((word) => word.text), ['你好', 'world']);
  assert.deepEqual(transcript.wordChunks[1].timestamp, [2, 3.8]);
  assert.equal(transcript.language, 'zh');
  assert.equal(transcript.duration, 10);
});

test('segments without words stay segment-level and expose no word ids', () => {
  const transcript = normalizeASRApiResponse({
    text: 'hello',
    segments: [{ text: 'hello', start: 0.5, end: 2 }],
  }, 10);

  assert.equal(transcript.hasWordTimestamps, false);
  assert.deepEqual(transcript.chunks[0].timestamp, [0.5, 2]);
  assert.equal(transcript.chunks[0].wordIds, undefined);
  assert.deepEqual(transcript.wordChunks, []);
});

test('word-only responses are grouped into readable sentences with real timing', () => {
  const transcript = normalizeASRApiResponse({
    words: [
      { word: '第一句。', start: 0, end: 0.8 },
      { word: '第二句', start: 3.5, end: 4.2 },
      { word: '结束', start: 4.3, end: 5 },
    ],
  }, 6);

  assert.equal(transcript.hasWordTimestamps, true);
  assert.equal(transcript.chunks.length, 2);
  assert.equal(transcript.chunks[0].text, '第一句。');
  assert.deepEqual(transcript.chunks[0].timestamp, [0, 0.8]);
  assert.equal(transcript.chunks[1].text, '第二句结束');
  assert.deepEqual(transcript.chunks[1].timestamp, [3.5, 5]);
});

test('partial word timing never enables word cuts', () => {
  const transcript = normalizeASRApiResponse({
    segments: [
      { text: 'a', start: 0, end: 2 },
      { text: 'b', start: 2, end: 4 },
    ],
    words: [{ word: 'a', start: 0, end: 2 }],
  }, 4);

  assert.equal(transcript.hasWordTimestamps, false);
  assert.ok(transcript.chunks.every((chunk) => chunk.wordIds === undefined));
  assert.deepEqual(transcript.wordChunks, []);
});

test('invalid, overlapping or out-of-range words are dropped', () => {
  const transcript = normalizeASRApiResponse({
    segments: [{ text: 'abcdef', start: 0, end: 10 }],
    words: [
      { word: 'late', start: 11, end: 12 },
      { word: 'backwards', start: 5, end: 4 },
      { word: 'first', start: 0, end: 1 },
      { word: 'overlap', start: 0.9, end: 2 },
    ],
  }, 10);

  assert.equal(transcript.hasWordTimestamps, false);
  assert.deepEqual(transcript.chunks[0].wordIds, undefined);
});

test('plain text responses fall back to a single coarse chunk', () => {
  const transcript = normalizeASRApiResponse({ text: '只有文字' }, 8);

  assert.equal(transcript.hasWordTimestamps, false);
  assert.equal(transcript.chunks.length, 1);
  assert.deepEqual(transcript.chunks[0].timestamp, [0, 8]);
});

test('responses without usable content are rejected instead of invented', () => {
  assert.throws(() => normalizeASRApiResponse({ error: { message: 'bad key' } }, 10), /text/);
  assert.throws(() => normalizeASRApiResponse([], 10), /JSON/);
  assert.throws(() => normalizeASRApiResponse('text', 10), /JSON/);
});

test('window offsets are applied to chunks, words and duration', () => {
  const transcript = normalizeASRApiResponse({
    segments: [{ text: 'end', start: 0, end: 2 }],
    words: [{ word: 'end', start: 0.2, end: 1.8 }],
  }, 2, 300, 'part-1');

  assert.deepEqual(transcript.chunks[0].timestamp, [300, 302]);
  assert.deepEqual(transcript.wordChunks[0].timestamp, [300.2, 301.8]);
  assert.equal(transcript.chunks[0].id, 'part-1-s-0');
  assert.equal(transcript.duration, 302);
});

test('merging keeps word timestamps only when every part has them', () => {
  const withWords = normalizeASRApiResponse({
    segments: [{ text: 'a', start: 0, end: 1 }],
    words: [{ word: 'a', start: 0, end: 1 }],
  }, 1, 0, 'p0');
  const withoutWords = normalizeASRApiResponse({
    segments: [{ text: 'b', start: 0, end: 1 }],
  }, 1, 300, 'p1');

  const merged = mergeASRApiTranscripts([withWords, withoutWords], 301);
  assert.equal(merged.hasWordTimestamps, false);
  assert.deepEqual(merged.wordChunks, []);
  assert.ok(merged.chunks.every((chunk) => chunk.wordIds === undefined));
  assert.deepEqual(merged.chunks.map((chunk) => chunk.timestamp), [[0, 1], [300, 301]]);
  assert.equal(merged.duration, 301);

  const allWordLevel = mergeASRApiTranscripts([withWords], 1);
  assert.equal(allWordLevel.hasWordTimestamps, true);
  assert.deepEqual(allWordLevel.chunks[0].wordIds, ['p0-w-0']);
});

test('correlation ids are unique without assuming a secure context', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(newCorrelationId());
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(typeof id === 'string' && id.length > 8);
});

test('encodePcmWav writes a playable 16-bit mono header', async () => {
  const blob = encodePcmWav(new Float32Array([0, 0.5, -0.5]), 16000);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 3 * 2);

  const view = new DataView(await blob.arrayBuffer());
  const ascii = (offset) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
  assert.equal(ascii(0), 'RIFF');
  assert.equal(ascii(8), 'WAVE');
  assert.equal(ascii(36), 'data');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 6);
});
