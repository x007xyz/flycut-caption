// Word-level scoring for the F-0008 experiment. Gold spans are delete spans;
// protected spans are content that must never be proposed for deletion.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function scoreCandidates({ words, candidates, goldSpans, protectedSpans = [] }) {
  const order = new Map(words.map((word, index) => [word.id, index]));
  const idsIn = (spans) => {
    const ids = new Set();
    for (const span of spans) {
      const start = order.get(span.startWordId);
      const end = order.get(span.endWordId);
      if (start === undefined || end === undefined || start > end) throw new Error('Score span has unknown or reversed ids');
      for (let position = start; position <= end; position += 1) ids.add(words[position].id);
    }
    return ids;
  };
  const proposed = idsIn(candidates);
  const gold = idsIn(goldSpans);
  const protectedIds = idsIn(protectedSpans);
  const truePositive = [...proposed].filter((id) => gold.has(id));
  const falseDelete = [...proposed].filter((id) => !gold.has(id));
  const missed = [...gold].filter((id) => !proposed.has(id));
  const criticalFalseDelete = [...proposed].filter((id) => protectedIds.has(id));
  const durationOf = (ids) => ids.reduce((sum, id) => {
    const word = words.find((item) => item.id === id);
    const start = word.startMs ?? word.timestamp?.[0] * 1000 ?? 0;
    const end = word.endMs ?? word.timestamp?.[1] * 1000 ?? start;
    return sum + Math.max(0, end - start);
  }, 0);
  const proposedDuration = durationOf([...proposed]);
  const falseDuration = durationOf(falseDelete);
  return {
    proposedWords: proposed.size, goldDeleteWords: gold.size,
    truePositiveWords: truePositive.length, falseDeleteWords: falseDelete.length, missedWords: missed.length,
    criticalFalseDeleteWords: criticalFalseDelete.length,
    falseDeleteRate: proposed.size ? falseDelete.length / proposed.size : null,
    recall: gold.size ? truePositive.length / gold.size : null,
    precision: proposed.size ? truePositive.length / proposed.size : null,
    proposedDurationMs: proposedDuration, falseDeleteDurationMs: falseDuration,
    falseDeleteDurationRate: proposedDuration ? falseDuration / proposedDuration : null,
    falseDeleteIds: falseDelete, missedIds: missed, criticalFalseDeleteIds: criticalFalseDelete,
  };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const wordsFile = arg('words');
  const goldFile = arg('gold');
  const predFile = arg('pred');
  const outFile = arg('out');
  if (!wordsFile || !goldFile || !predFile) {
    console.error('usage: node score.mjs --words words.json --gold gold.json --pred predictions.json [--out metrics.json]');
    process.exit(2);
  }
  const rawWords = JSON.parse(readFileSync(wordsFile, 'utf8'));
  const words = Array.isArray(rawWords) ? rawWords : rawWords.wordChunks;
  const gold = JSON.parse(readFileSync(goldFile, 'utf8'));
  const prediction = JSON.parse(readFileSync(predFile, 'utf8'));
  const result = scoreCandidates({
    words,
    goldSpans: gold.goldSpans ?? gold.deleteSpans ?? [],
    protectedSpans: gold.protectedSpans ?? [],
    candidates: prediction.candidates ?? prediction,
  });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (outFile) { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, body); }
  process.stdout.write(body);
}
