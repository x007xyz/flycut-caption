# F-0008 semantic-cut experiment harness

This directory contains the contract checks and the bounded experiment tooling for F-0008. It does not change production code and does not produce a default model or quality threshold.

## Commands

```bash
node --test experiments/f-0008-semantic-cut/test.mjs experiments/f-0008-semantic-cut/score.test.mjs
node experiments/f-0008-semantic-cut/analyze-corpus.mjs --out experiments/f-0008-semantic-cut/results/corpus-stats.json
node experiments/f-0008-semantic-cut/score.mjs --words experiments/f-0008-semantic-cut/fixtures/mini-transcript.json --gold experiments/f-0008-semantic-cut/fixtures/score-gold.json --pred experiments/f-0008-semantic-cut/fixtures/score-pred.json
node experiments/f-0008-semantic-cut/live-pilot.mjs --dry-run
node experiments/f-0008-semantic-cut/live-pilot.mjs --clip coscup-BWgFrY91F_I --start-sentence 0 --end-sentence 14 --out experiments/f-0008-semantic-cut/results/pilot.json
```

The live pilot reads `DEEPSEEK_API_KEY` from the environment and never prints it. It sends transcript text only, not media. A single successful call proves protocol plumbing and output validity; it is not a false-delete or recall measurement.

`fixtures/mini-transcript.json` is a small synthetic fixture used to test the validator. It is not recorded speech and its labels are not model results.
