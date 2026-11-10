// Descriptive corpus counts only. These are not semantic-cut quality results.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const CLIPS = [
  { name: 'coscup-3UegVxMFyeo', reference: 'tests/fixtures/asr-reference/coscup-3UegVxMFyeo.md' },
  { name: 'coscup-BWgFrY91F_I', reference: 'tests/fixtures/asr-reference/coscup-BWgFrY91F_I.md' },
];
const FILLERS = ['嗯', '啊', '呃', '额', '唔', '哎', '唉', '哦', '噢', '呀', '嘛', '哈'];
const AMBIGUOUS = ['就是', '那个', '然后', '这个', '其实', '所以', '但是', '因为', '而且', '这样子', '怎么说'];
const SELF_CORRECTION = ['不是', '不对', '我是说', '应该说', '重来', '重新'];

const clean = (text) => String(text ?? '').replace(/[\p{P}\s]/gu, '');
const hasTrailingPunctuation = (text) => /[\p{P}]$/u.test(String(text ?? ''));

function readRange(markdown) {
  const match = markdown.match(/^range: \[([\d.]+), ([\d.]+)\]$/m);
  if (!match) throw new Error('Reference is missing a range');
  return [Number(match[1]), Number(match[2])];
}

function countClip(clip) {
  const transcript = JSON.parse(readFileSync(join(root, `tests/media/external/${clip.name}.transcript.json`), 'utf8'));
  const [from, to] = readRange(readFileSync(join(root, clip.reference), 'utf8'));
  const sentenceById = new Map(transcript.chunks.map((sentence) => [sentence.id, sentence]));
  const words = transcript.wordChunks.filter((word) => word.timestamp[0] >= from && word.timestamp[1] <= to);
  const sentences = transcript.chunks.filter((sentence) => sentence.timestamp[0] >= from && sentence.timestamp[1] <= to);
  const wordById = new Map(transcript.wordChunks.map((word) => [word.id, word]));
  const counts = Object.fromEntries([...FILLERS, ...AMBIGUOUS, ...SELF_CORRECTION].map((term) => [term, 0]));
  let isolatedFillers = 0;
  let clauseInitialFillers = 0;
  let sentenceInitialAmbiguous = 0;
  let immediateRepeatedTokens = 0;
  let immediateRepeatedBigrams = 0;
  let fillerDurationMs = 0;
  const sentenceWords = new Map();
  for (const sentence of transcript.chunks) {
    sentenceWords.set(sentence.id, sentence.wordIds.map((id) => wordById.get(id)).filter(Boolean));
  }
  const countPhrase = (terms) => {
    for (const [sentenceId, list] of sentenceWords) {
      const inRange = list.filter((word) => word.timestamp[0] >= from && word.timestamp[1] <= to);
      for (let start = 0; start < inRange.length; start += 1) {
        for (let length = 1; length <= 4 && start + length <= inRange.length; length += 1) {
          const phrase = inRange.slice(start, start + length).map((word) => clean(word.text)).join('');
          if (!terms.includes(phrase)) continue;
          counts[phrase] += 1;
          if (AMBIGUOUS.includes(phrase) && start === 0) sentenceInitialAmbiguous += 1;
        }
      }
    }
  };
  countPhrase(AMBIGUOUS);
  countPhrase(SELF_CORRECTION);
  for (const [position, word] of words.entries()) {
    const text = clean(word.text);
    if (FILLERS.includes(text)) counts[text] += 1;
    const sentence = sentenceById.get(word.sentenceId);
    const currentSentenceWords = sentence ? sentenceWords.get(sentence.id) : [];
    if (FILLERS.includes(text)) {
      fillerDurationMs += Math.max(0, (word.timestamp[1] - word.timestamp[0]) * 1000);
      if (currentSentenceWords.length === 1) isolatedFillers += 1;
      const previous = words[position - 1];
      if (!previous || previous.sentenceId !== word.sentenceId || hasTrailingPunctuation(previous.text)) clauseInitialFillers += 1;
    }
    if (position > 0 && words[position - 1].sentenceId === word.sentenceId && clean(words[position - 1].text) === text) immediateRepeatedTokens += 1;
    if (position > 1 && words[position - 1].sentenceId === word.sentenceId && words[position - 2].sentenceId === word.sentenceId
      && clean(words[position - 2].text) + text === clean(words[position - 1].text) + clean(words[position].text)) immediateRepeatedBigrams += 1;
  }
  const fillerTokens = FILLERS.reduce((sum, term) => sum + counts[term], 0);
  const ambiguousTokens = AMBIGUOUS.reduce((sum, term) => sum + counts[term], 0);
  const selfCorrectionCues = SELF_CORRECTION.reduce((sum, term) => sum + counts[term], 0);
  return {
    clip: clip.name, range: [from, to], sentences: sentences.length, words: words.length,
    fillerTokens, isolatedFillers, clauseInitialFillers,
    fillerDurationMs: Math.round(fillerDurationMs), ambiguousTokens, sentenceInitialAmbiguous,
    immediateRepeatedTokens, immediateRepeatedBigrams, selfCorrectionCues, counts,
  };
}

const clips = CLIPS.map(countClip);
const totals = clips.reduce((result, clip) => {
  result.sentences += clip.sentences; result.words += clip.words;
  result.fillerTokens += clip.fillerTokens; result.isolatedFillers += clip.isolatedFillers;
  result.clauseInitialFillers += clip.clauseInitialFillers; result.fillerDurationMs += clip.fillerDurationMs;
  result.ambiguousTokens += clip.ambiguousTokens; result.sentenceInitialAmbiguous += clip.sentenceInitialAmbiguous;
  result.immediateRepeatedTokens += clip.immediateRepeatedTokens; result.immediateRepeatedBigrams += clip.immediateRepeatedBigrams;
  result.selfCorrectionCues += clip.selfCorrectionCues;
  return result;
}, { sentences: 0, words: 0, fillerTokens: 0, isolatedFillers: 0, clauseInitialFillers: 0,
  fillerDurationMs: 0, ambiguousTokens: 0, sentenceInitialAmbiguous: 0, immediateRepeatedTokens: 0,
  immediateRepeatedBigrams: 0, selfCorrectionCues: 0 });
const report = { generatedAt: new Date().toISOString(), method: 'descriptive counts over F-0001 reviewed ranges', clips, totals };
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0) {
  const file = process.argv[outIndex + 1];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
console.log(JSON.stringify(report, null, 2));
