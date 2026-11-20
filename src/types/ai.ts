// AI 模型相关类型定义
import type { AIConfigView } from '../../shared/aiSettings'

/**
 * AI 模型配置（OpenAI 兼容）
 */
export interface AIModelConfig {
  id: string;
  name: string;
  baseUrl: string; // 例如 https://api.openai.com/v1
  apiKey: string;
  model: string; // 例如 gpt-4o-mini
  temperature?: number;
  headers?: Record<string, string>;
}

/** Public Host projection used by the UI. It intentionally has no API-key field. */
export type AIModelView = AIConfigView

/**
 * AI 任务进度
 */
export interface AIProgress {
  status: 'running' | 'complete' | 'error';
  data?: string;
  progress?: number; // 0-100
  error?: string;
}

/**
 * AI 任务类型
 */
export type AITaskType = 'correction' | 'translation';

/**
 * 带有序号的字幕条目，供 AI 引擎使用
 */
export interface AISubtitleItem {
  id: string;
  text: string;
}
