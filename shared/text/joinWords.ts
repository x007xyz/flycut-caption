// 字词拼接为句子文本：中日文之间不加空格，其余（英文等）以空格分隔。
// 与 funasr-asr sidecar 的 join_word_texts 保持一致。

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const PUNCTUATION = /[.!?\u3002\uff01\uff1f\u2026\uff1b;\uff0c,\u3001:\uff1a\u201c\u201d\u2018\u2019\uff08\uff09()]/

export function joinWordTexts(words: readonly string[]): string {
  // Whisper 等模型的字词自带前导空格，此时空格已经是词边界，原样拼接
  if (words.some((word) => /^\s/.test(word))) return words.join('').trim()

  let text = ''
  for (const raw of words) {
    const word = raw.trim()
    if (!word) continue
    const last = text.at(-1)
    const first = word[0]
    if (last && !CJK.test(last) && !CJK.test(first) && !PUNCTUATION.test(first)) text += ' '
    text += word
  }
  return text
}
