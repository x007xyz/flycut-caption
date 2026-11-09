// 时间处理工具函数

import {
  endsSentence,
  resolveSentenceGroupingOptions,
  type SentenceGroupingOptions,
} from '../config/sentenceGrouping.ts';
import { joinWordTexts } from '../../shared/text/joinWords.ts';

export type { SentenceGroupingOptions };
export {
  DEFAULT_SENTENCE_GROUPING_OPTIONS,
  resolveSentenceGroupingOptions,
} from '../config/sentenceGrouping.ts';

/**
 * 计算字幕片段之间的空白段（时间戳间隙）。
 * 仅基于活跃（未删除）chunk 的时间戳，识别首段前、段间、末段后超过阈值的空白。
 *
 * @param chunks 字幕片段数组（将忽略 deleted=true 的项）
 * @param threshold 最小空白时长（秒），间隙 >= threshold 才被视为空白段
 * @param totalDuration 可选，整体媒体时长（秒）；提供时才会识别末段后空白
 * @returns 空白段数组 [{start, end}]，按时间升序
 */
export { calculateBlankSegments } from '../../shared/editing/blankSegments.ts';

/**
 * 将秒数格式化为 HH:MM:SS 或 MM:SS 格式
 */
export function formatTime(seconds: number, includeHours = false): string {
  if (isNaN(seconds) || !isFinite(seconds)) return '00:00';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (includeHours || hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * 将时间字符串解析为秒数
 */
export function parseTime(timeString: string): number {
  const parts = timeString.split(':').map(Number);
  
  if (parts.length === 2) {
    // MM:SS
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  
  return 0;
}

/**
 * 将秒数格式化为带毫秒的时间格式 (用于字幕)
 */
export function formatTimeWithMs(seconds: number): string {
  if (isNaN(seconds) || !isFinite(seconds)) return '00:00.000';
  
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * 计算时间范围的重叠部分
 */
export function getOverlap(
  range1: [number, number], 
  range2: [number, number]
): [number, number] | null {
  const [start1, end1] = range1;
  const [start2, end2] = range2;
  
  const start = Math.max(start1, start2);
  const end = Math.min(end1, end2);
  
  return start < end ? [start, end] : null;
}

/**
 * 检查时间点是否在时间范围内
 */
export function isTimeInRange(time: number, range: [number, number]): boolean {
  const [start, end] = range;
  return time >= start && time <= end;
}

/**
 * 合并相邻的时间段
 */
export function mergeTimeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  
  // 按开始时间排序
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastMerged = merged[merged.length - 1];
    
    // 如果当前范围与上一个范围重叠或相邻，则合并
    if (current[0] <= lastMerged[1]) {
      lastMerged[1] = Math.max(lastMerged[1], current[1]);
    } else {
      merged.push(current);
    }
  }
  
  return merged;
}

function isDigitOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && /^\d+$/.test(trimmed);
}

function mergeAdjacentDigitTokens<T extends { text: string; timestamp: [number, number] }>(
  chunks: T[],
): T[] {
  const merged: T[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && isDigitOnly(last.text) && isDigitOnly(chunk.text)) {
      last.text += chunk.text;
      last.timestamp = [last.timestamp[0], chunk.timestamp[1]];
      continue;
    }
    merged.push({ ...chunk });
  }
  return merged;
}

/**
 * 将字级时间戳智能分组为句子
 */
export function groupWordsIntoSentences(
  chunks: Array<{ text: string; timestamp: [number, number]; id: string; selected?: boolean }>,
  options?: Partial<SentenceGroupingOptions>,
): Array<{
  id: string;
  text: string;
  timestamp: [number, number];
  wordChunks: typeof chunks;
  selected?: boolean;
  duration: number;
  wordCount: number;
}> {
  if (!chunks.length) return [];

  const config = resolveSentenceGroupingOptions(options);
  const normalizedChunks = config.mergeAdjacentDigitTokens
    ? mergeAdjacentDigitTokens(chunks)
    : chunks;

  const sentences: Array<{
    id: string;
    text: string;
    timestamp: [number, number];
    wordChunks: typeof chunks;
    selected?: boolean;
    duration: number;
    wordCount: number;
  }> = [];

  let currentSentence: typeof chunks = [];
  let sentenceIndex = 0;

  for (let i = 0; i < normalizedChunks.length; i++) {
    const chunk = normalizedChunks[i];
    currentSentence.push(chunk);

    const isLastChunk = i === normalizedChunks.length - 1;
    const nextChunk = i < normalizedChunks.length - 1 ? normalizedChunks[i + 1] : null;
    
    // 计算当前句子时长
    const currentDuration = currentSentence.length > 0 
      ? currentSentence[currentSentence.length - 1].timestamp[1] - currentSentence[0].timestamp[0]
      : 0;
    
    // 计算到下一个词的停顿时间
    const pauseToNext = nextChunk 
      ? nextChunk.timestamp[0] - chunk.timestamp[1]
      : 0;
    
    // 决定是否结束当前句子
    const shouldEndSentence =
      isLastChunk ||
      currentDuration >= config.maxDurationSec ||
      pauseToNext >= config.pauseThresholdSec ||
      endsSentence(chunk.text, config.sentenceEnders);

    if (shouldEndSentence && currentSentence.length > 0) {
      const sentenceText = joinWordTexts(currentSentence.map(c => c.text));
      const startTime = currentSentence[0].timestamp[0];
      const endTime = currentSentence[currentSentence.length - 1].timestamp[1];
      
      // 判断整个句子的选中状态
      const selectedCount = currentSentence.filter(c => c.selected).length;
      const totalCount = currentSentence.length;
      
      let selectedState: boolean | 'partial' = false;
      if (selectedCount === totalCount) {
        selectedState = true; // 全选
      } else if (selectedCount > 0) {
        selectedState = 'partial'; // 部分选中
      }
      
      sentences.push({
        id: `sentence-${sentenceIndex}`,
        text: sentenceText,
        timestamp: [startTime, endTime],
        wordChunks: [...currentSentence],
        selected: selectedState as boolean,
        duration: endTime - startTime,
        wordCount: currentSentence.length
      });

      currentSentence = [];
      sentenceIndex++;
    }
  }

  return sentences;
}

/**
 * 计算字幕块之间的停顿时间并添加分隔符（包括首尾停顿）
 */
export function calculatePausesAndSeparators(
  chunks: Array<{ text: string; timestamp: [number, number]; id: string; selected?: boolean }>,
  pauseThreshold: number = 0.1,
  totalDuration?: number
): Array<{
  type: 'word' | 'pause';
  id: string;
  text?: string;
  timestamp?: [number, number];
  selected?: boolean;
  pauseDuration?: number;
}> {
  const result: Array<{
    type: 'word' | 'pause';
    id: string;
    text?: string;
    timestamp?: [number, number];
    selected?: boolean;
    pauseDuration?: number;
  }> = [];

  if (chunks.length === 0) return result;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prevChunk = i > 0 ? chunks[i - 1] : null;
    // const nextChunk = i < chunks.length - 1 ? chunks[i + 1] : null;

    // 检查开头的停顿（只在第一个单词前检查）
    if (i === 0 && chunk.timestamp[0] >= pauseThreshold) {
      result.push({
        type: 'pause',
        id: `pause-start-${chunk.id}`,
        pauseDuration: chunk.timestamp[0]
      });
    }

    // 检查与前一个单词的间隔（中间停顿）
    if (prevChunk) {
      const pauseDuration = chunk.timestamp[0] - prevChunk.timestamp[1];
      
      if (pauseDuration >= pauseThreshold) {
        result.push({
          type: 'pause',
          id: `pause-${prevChunk.id}-${chunk.id}`,
          pauseDuration
        });
      }
    }
    
    // 添加当前单词
    result.push({
      type: 'word',
      id: chunk.id,
      text: chunk.text,
      timestamp: chunk.timestamp,
      selected: chunk.selected
    });

    // 检查结尾的停顿（只在最后一个单词后检查）
    if (i === chunks.length - 1 && totalDuration) {
      const endPause = totalDuration - chunk.timestamp[1];
      if (endPause >= pauseThreshold) {
        result.push({
          type: 'pause',
          id: `pause-${chunk.id}-end`,
          pauseDuration: endPause
        });
      }
    }
  }

  return result;
}