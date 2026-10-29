import type { VideoFile } from '@/types/video';

const waveformDecodeLimitBytes = 180 * 1024 * 1024;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export async function extractWaveformPeaks(videoFile: VideoFile): Promise<number[] | null> {
  if (typeof window === 'undefined') return null;
  if (!videoFile.file.size || videoFile.file.size > waveformDecodeLimitBytes) return null;

  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;

  const audioContext = new AudioContextClass();

  try {
    const arrayBuffer = await videoFile.file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const sampleCount = Math.round(clamp(audioBuffer.duration * 24, 320, 2400));
    const blockSize = Math.max(1, Math.floor(audioBuffer.length / sampleCount));
    const peaks = new Array<number>(sampleCount).fill(0);
    let maxPeak = 0;

    for (let peakIndex = 0; peakIndex < sampleCount; peakIndex++) {
      const start = peakIndex * blockSize;
      const end = Math.min(audioBuffer.length, start + blockSize);
      let sum = 0;
      let count = 0;

      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
          const sample = channelData[sampleIndex] || 0;
          sum += sample * sample;
          count += 1;
        }
      }

      const rms = count > 0 ? Math.sqrt(sum / count) : 0;
      peaks[peakIndex] = rms;
      maxPeak = Math.max(maxPeak, rms);
    }

    if (maxPeak <= 0) return null;
    return peaks.map(peak => clamp(Math.sqrt(peak / maxPeak), 0, 1));
  } catch (error) {
    console.warn('音频波形解码失败，使用合成波形:', error);
    return null;
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}
