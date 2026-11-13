import type { TtsAudioFormat } from '../providers';

export const MAX_TTS_AUDIO_BYTES = 50 * 1024 * 1024;

export interface ValidatedTtsAudio {
  format: TtsAudioFormat;
  mimeType: string;
  byteLength: number;
  durationSeconds?: number;
  sampleRate?: number;
}

const MIME_BY_FORMAT: Record<TtsAudioFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function validateWav(bytes: Uint8Array): ValidatedTtsAudio {
  if (bytes.byteLength < 44) throw new Error('WAV 音频头不完整或文件过短');
  const riffSize = u32le(bytes, 4);
  if (riffSize + 8 > bytes.byteLength) throw new Error('WAV 音频已截断');
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let hasFmt = false;
  let dataBytes = 0;
  let hasData = false;

  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, offset + 4);
    const size = u32le(bytes, offset + 4);
    offset += 8;
    if (offset + size > bytes.byteLength) throw new Error(`WAV chunk "${id}" 数据截断`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV fmt chunk 无效');
      audioFormat = u16le(bytes, offset);
      channels = u16le(bytes, offset + 2);
      sampleRate = u32le(bytes, offset + 4);
      blockAlign = u16le(bytes, offset + 12);
      bitsPerSample = u16le(bytes, offset + 14);
      hasFmt = true;
    } else if (id === 'data') {
      dataBytes = size;
      hasData = true;
    }
    offset += size + (size % 2);
  }

  if (!hasFmt || !hasData) throw new Error('WAV 缺少必要的 fmt 或 data 数据块');
  if (![1, 3, 0xfffe].includes(audioFormat)) throw new Error(`不支持的 WAV 编码格式：${audioFormat}`);
  if (channels < 1 || channels > 8) throw new Error(`无效的 WAV 声道数：${channels}`);
  if (sampleRate < 8000 || sampleRate > 192000) throw new Error(`无效的 WAV 采样率：${sampleRate}`);
  if (![8, 16, 24, 32].includes(bitsPerSample)) throw new Error(`无效的 WAV 位深：${bitsPerSample}`);
  const frameBytes = blockAlign || (channels * (bitsPerSample / 8));
  if (dataBytes < frameBytes) throw new Error('WAV 音频数据为空');
  const durationSeconds = dataBytes / (sampleRate * channels * (bitsPerSample / 8));
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('WAV 音频时长无效');

  return { format: 'wav', mimeType: MIME_BY_FORMAT.wav, byteLength: bytes.byteLength, durationSeconds, sampleRate };
}

function validateFlac(bytes: Uint8Array): ValidatedTtsAudio {
  if (bytes.byteLength < 42) throw new Error('FLAC 音频不完整');
  const blockType = bytes[4] & 0x7f;
  const blockSize = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  if (blockType !== 0 || blockSize !== 34) throw new Error('FLAC 缺少有效 STREAMINFO 头');
  const sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
  const channels = ((bytes[20] >> 1) & 0x07) + 1;
  const totalSamples = ((bytes[21] & 0x0f) * 2 ** 32) + u32be(bytes, 22);
  if (sampleRate < 8000 || sampleRate > 192000 || channels < 1) throw new Error('FLAC 音频参数无效');
  if (totalSamples <= 0 && bytes.byteLength <= 42) throw new Error('FLAC 音频数据为空');
  return {
    format: 'flac',
    mimeType: MIME_BY_FORMAT.flac,
    byteLength: bytes.byteLength,
    sampleRate,
    ...(totalSamples > 0 ? { durationSeconds: totalSamples / sampleRate } : {}),
  };
}

function validateOgg(bytes: Uint8Array): ValidatedTtsAudio {
  if (bytes.byteLength < 28 || bytes[4] !== 0) throw new Error('OGG 音频页头无效');
  const segments = bytes[26];
  const headerEnd = 27 + segments;
  if (headerEnd > bytes.byteLength) throw new Error('OGG 音频段表截断');
  let payloadBytes = 0;
  for (let i = 0; i < segments; i++) payloadBytes += bytes[27 + i];
  if (payloadBytes <= 0 || headerEnd + payloadBytes > bytes.byteLength) throw new Error('OGG 音频数据不完整或已截断');
  return { format: 'ogg', mimeType: MIME_BY_FORMAT.ogg, byteLength: bytes.byteLength };
}

const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000],  // MPEG 2.5
};

function validateMp3(bytes: Uint8Array): ValidatedTtsAudio {
  let offset = 0;
  if (bytes.byteLength >= 10 && ascii(bytes, 0, 3) === 'ID3') {
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + tagSize;
  }
  if (offset + 4 > bytes.byteLength) throw new Error('MP3 仅含标签头，缺少音频帧');
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0) {
      const version = (bytes[offset + 1] >> 3) & 0x03;
      const layer = (bytes[offset + 1] >> 1) & 0x03;
      const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
      const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
      if (version !== 1 && layer !== 0 && bitrateIndex !== 0 && bitrateIndex !== 15 && sampleRateIndex !== 3) {
        const sampleRate = MPEG_SAMPLE_RATES[version]?.[sampleRateIndex];
        if (bytes.byteLength - offset < 24) throw new Error('MP3 音频帧已截断');
        return { format: 'mp3', mimeType: MIME_BY_FORMAT.mp3, byteLength: bytes.byteLength, ...(sampleRate ? { sampleRate } : {}) };
      }
    }
    offset++;
    if (offset > 8192) break;
  }
  throw new Error('MP3 未找到有效的音频帧头');
}

/** Validates TTS audio bytes strictly; rejects empty, non-audio text/JSON/HTML, or truncated payloads. */
export function validateTtsAudio(bytes: Uint8Array, declaredMime?: string): ValidatedTtsAudio {
  if (!bytes || bytes.byteLength === 0) throw new Error('TTS 返回了空音频');
  if (bytes.byteLength > MAX_TTS_AUDIO_BYTES) throw new Error('TTS 音频产物超过 50 MB 上限');

  if (declaredMime) {
    const normalized = declaredMime.split(';')[0].trim().toLowerCase();
    if (normalized && !normalized.startsWith('audio/') && normalized !== 'application/octet-stream' && normalized !== 'application/ogg') {
      throw new Error(`TTS 返回了非音频内容类型：${normalized}`);
    }
  }

  const head = ascii(bytes, 0, Math.min(32, bytes.byteLength)).trimStart();
  if (head.startsWith('{') || head.startsWith('[') || head.startsWith('<')) {
    throw new Error('TTS 返回内容是文本或错误页面，而非有效音频');
  }

  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return validateWav(bytes);
  if (bytes.byteLength >= 4 && ascii(bytes, 0, 4) === 'fLaC') return validateFlac(bytes);
  if (bytes.byteLength >= 4 && ascii(bytes, 0, 4) === 'OggS') return validateOgg(bytes);
  if ((bytes.byteLength >= 3 && ascii(bytes, 0, 3) === 'ID3') || (bytes.byteLength >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return validateMp3(bytes);
  }
  throw new Error('无法识别的 TTS 音频格式或音频数据已损坏');
}
