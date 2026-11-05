// OpenAI 兼容引擎：通过 /chat/completions 对接字幕纠错 / 翻译
import type { AIModelConfig, AIProgress, AISubtitleItem } from '../../src/types/ai'

export interface OpenAICompatibleEngineConfig {
  temperature?: number
}

/**
 * 校验模型返回的逐条结果：每个输入 id 恰好对应一条非空文本。
 * 缺条、重复、未知 id、空文本都抛错，不用原文填补，避免用户以为已经处理过。
 */
export function validateItemResults(items: AISubtitleItem[], parsed: unknown[]): AISubtitleItem[] {
  const expected = new Set(items.map((item) => item.id))
  const texts = new Map<string, string>()
  const duplicate: string[] = []
  const unknown: string[] = []
  const empty: string[] = []
  for (const entry of parsed) {
    const raw = entry && typeof entry === 'object' ? (entry as { id?: unknown; text?: unknown }) : {}
    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id)
    if (!expected.has(id)) { unknown.push(id || '(无 id)'); continue }
    if (texts.has(id)) { duplicate.push(id); continue }
    texts.set(id, typeof raw.text === 'string' ? raw.text : '')
  }
  const missing = items.filter((item) => !texts.has(item.id)).map((item) => item.id)
  for (const item of items) {
    const text = texts.get(item.id)
    if (text !== undefined && !text.trim() && item.text.trim()) empty.push(item.id)
  }
  const problems = [
    missing.length && `缺少 ${missing.length} 条（id: ${missing.slice(0, 5).join(', ')}）`,
    duplicate.length && `重复 ${duplicate.length} 条（id: ${duplicate.slice(0, 5).join(', ')}）`,
    unknown.length && `多出 ${unknown.length} 条未知 id（${unknown.slice(0, 5).join(', ')}）`,
    empty.length && `空文本 ${empty.length} 条（id: ${empty.slice(0, 5).join(', ')}）`,
  ].filter(Boolean)
  if (problems.length) throw new Error(`AI 返回结果校验失败：${problems.join('；')}`)
  return items.map((item) => ({ id: item.id, text: texts.get(item.id)! }))
}

export class OpenAICompatibleEngine {
  private signal?: AbortSignal
  setAbortSignal(signal: AbortSignal) { this.signal = signal }
  private progressCallback: ((p: AIProgress) => void) | null = null

  setProgressCallback(cb: (p: AIProgress) => void) {
    this.progressCallback = cb
  }

  private report(p: AIProgress) {
    this.progressCallback?.(p)
  }

  /**
   * 字幕纠错：修正 ASR 错别字/标点/口语化，保持行数与顺序
   */
  async correct(
    items: AISubtitleItem[],
    model: AIModelConfig,
  ): Promise<AISubtitleItem[]> {
    const system =
      '你是字幕纠错专家。请修正输入字幕中的语音识别错别字、标点缺失、口语化冗词，使语句通顺自然。' +
      '严格保持输入顺序与条数，只输出 JSON 数组，元素为 {"id": <原id>, "text": <修正后文本>}，不含额外解释。'
    return this.runItems(items, model, system, '纠错')
  }

  /**
   * 字幕翻译：将每条翻译为指定语言
   */
  async translate(
    items: AISubtitleItem[],
    model: AIModelConfig,
    targetLang: string,
  ): Promise<AISubtitleItem[]> {
    const system =
      `你是专业字幕翻译。请将每条字幕翻译为「${targetLang}」，保持简洁口语化，符合字幕阅读习惯。` +
      '严格保持输入顺序与条数，只输出 JSON 数组，元素为 {"id": <原id>, "text": <译文>}，不含额外解释。'
    return this.runItems(items, model, system, `翻译为 ${targetLang}`)
  }

  private async runItems(
    items: AISubtitleItem[],
    model: AIModelConfig,
    system: string,
    stageLabel: string,
  ): Promise<AISubtitleItem[]> {
    if (items.length === 0) return []

    this.report({
      status: 'running',
      progress: 0,
      data: `${stageLabel} ${items.length} 条字幕...`,
    })

    const parsed = await this.requestAll(items, model, system)
    const results = validateItemResults(items, parsed)

    this.report({ status: 'complete', progress: 100, data: `${stageLabel}完成` })
    return results
  }

  private async requestAll(
    items: AISubtitleItem[],
    model: AIModelConfig,
    system: string,
  ): Promise<unknown[]> {
    const userContent = JSON.stringify(
      items.map((item) => ({ id: item.id, text: item.text })),
    )

    const baseUrl = model.baseUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/chat/completions`

    const body: Record<string, unknown> = {
      model: model.model,
      temperature: model.temperature ?? 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }

    const resp = await fetch(url, {
      signal: this.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`AI 请求失败 (${resp.status}): ${errText.slice(0, 200)}`)
    }

    const data = await resp.json()
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    const parsed = this.parseContent(content)
    if (!Array.isArray(parsed)) {
      throw new Error('AI 返回内容无法解析为 JSON 数组')
    }

    if (parsed.length !== items.length) {
      throw new Error(
        `AI 返回条数不一致：期望 ${items.length}，实际 ${parsed.length}（可能超出模型上下文或输出长度限制）`,
      )
    }
    return parsed
  }

  /**
   * 解析模型输出。兼容 json_object 包裹和直接数组两种形态。
   */
  private parseContent(content: string): unknown {
    if (!content) return null
    const trimmed = content.trim()

    // 直接是 JSON 数组
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed)
      } catch {
        // fallthrough
      }
    }

    // 可能是 {"items": [...]} 或 {"results": [...]}
    try {
      const obj = JSON.parse(trimmed)
      if (Array.isArray(obj)) return obj
      if (obj && typeof obj === 'object') {
        const arrVal = Object.values(obj).find((v) => Array.isArray(v))
        if (arrVal) return arrVal
      }
    } catch {
      // fallthrough
    }

    // 兜底：从文本中提取首个 JSON 数组片段
    const match = trimmed.match(/\[[\s\S]*\]/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch {
        return null
      }
    }
    return null
  }
}
