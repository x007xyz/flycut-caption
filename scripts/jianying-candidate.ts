// F-0011 validation harness. This is deliberately not reachable from product RPC while
// verifiedByImport is false; it exists only to produce a real candidate for native testing.
import { resolve } from 'node:path';
import { generateJianyingDraft, probeJianyingMedia } from '../server/jianying/generate';
import { createEdl } from '../shared/editing/edl';
import type { JianyingSnapshot } from '../shared/jianying/draft';

const sourcePath = resolve(process.env.F0011_SOURCE || 'src/assets/demo.mp4');
const outputParent = process.env.F0011_OUTPUT_PARENT;
const draftName = process.env.F0011_DRAFT_NAME || 'F0011-Mac-Validation';
if (!outputParent) throw new Error('F0011_OUTPUT_PARENT is required');
const probe = await probeJianyingMedia(sourcePath);
const durationSeconds = probe.durationUs / 1_000_000;
const firstCut = Math.min(5, Math.max(2, durationSeconds * 0.1));
const secondCut = Math.min(20, Math.max(firstCut + 2, durationSeconds * 0.3));
const snapshot: JianyingSnapshot = {
  edl: createEdl(durationSeconds, [{ start: firstCut, end: firstCut + 1 }, { start: secondCut, end: secondCut + 1 }]),
  cues: [
    { id: 'f0011-a', text: 'F0011 T1 01-04', secondText: 'Secondary must stay visible as a downgrade', timestamp: [1, 4] },
    { id: 'f0011-b', text: 'F0011 T2 04.5-06.5 CUT', timestamp: [4.5, 6.5] },
    { id: 'f0011-c', text: `F0011 T3 ${secondCut + 2}-${secondCut + 4}`, timestamp: [secondCut + 2, secondCut + 4] },
  ],
  style: {
    fontId: 'noto-sans-sc', fontSizeRatio: 0.045, bottomOffsetRatio: 60 / 1080, fontWeight: 'bold',
    fontStyle: 'normal', textDecoration: 'none', color: '#FFFFFF', colorOpacity: 1,
    backgroundColor: '#000000', borderColor: '#111111', borderOpacity: 1, textAlign: 'center',
    lineHeight: 1.2, letterSpacing: 0, borderWidth: 2, backgroundOpacity: 0,
  },
  videoWidth: probe.width, videoHeight: probe.height,
  projectName: 'F0011 Mac validation', videoName: 'demo.mp4',
};
const result = await generateJianyingDraft({ snapshot, sourcePath, outputParent: resolve(outputParent), draftName });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
