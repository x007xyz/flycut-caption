import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSoftSubtitleTracks, listSoftSubtitleTracks } from '../../src/subtitle/softSubtitles';
import type { LanguageTrack } from '../../shared/languageTracks';
import type { SubtitleChunk } from '../../src/types/subtitle';

const chunks: SubtitleChunk[] = [
  { id: 'c1', text: '第一句', timestamp: [0, 1] },
  { id: 'c2', text: '第二句', timestamp: [1, 2] },
  { id: 'c3', text: '第三句', timestamp: [2, 3] },
];
const segments = [{ start: 0, end: 1, keep: true }, { start: 1, end: 1.5, keep: false }, { start: 1.5, end: 3, keep: true }];
const tracks: LanguageTrack[] = [
  { id: 'en', name: 'English', languageCode: 'en', origin: 'manual', entries: {
    c1: { text: 'First', sourceText: '第一句', updatedAt: '2026-11-16T00:00:00Z' },
    c2: { text: 'Second', sourceText: '旧文本', updatedAt: '2026-11-16T00:00:00Z' },
    c3: { text: 'Third', sourceText: '第三句', updatedAt: '2026-11-16T00:00:00Z' },
  } },
  { id: 'ja', name: 'Japanese', languageCode: 'ja', origin: 'manual', entries: {
    c1: { text: '一番', sourceText: '第一句', updatedAt: '2026-11-16T00:00:00Z' },
    c2: { text: '二番', sourceText: '第二句', updatedAt: '2026-11-16T00:00:00Z' },
    c3: { text: '三番', sourceText: '第三句', updatedAt: '2026-11-16T00:00:00Z' },
  } },
];

test('F-0033/AC-1 AC-2 counts missing and outdated translations per track and blocks partial by default', () => {
  const candidates = listSoftSubtitleTracks({ chunks, languageTracks: tracks, activeTrackId: 'en', primaryLanguage: 'zh' });
  assert.deepEqual(candidates.map(item => [item.id, item.missing, item.outdated, item.total]), [
    ['primary', 0, 0, 3], ['en', 0, 1, 3], ['ja', 0, 0, 3],
  ]);
  const blocked = buildSoftSubtitleTracks({ chunks, keptSegments: segments, languageTracks: tracks,
    activeTrackId: 'en', primaryLanguage: 'zh', selectedIds: ['primary', 'en', 'ja'], allowPartial: false });
  assert.deepEqual(blocked.tracks.map(track => track.id), ['primary', 'ja']);
  const partial = buildSoftSubtitleTracks({ chunks, keptSegments: segments, languageTracks: tracks,
    activeTrackId: 'en', primaryLanguage: 'zh', selectedIds: ['en'], allowPartial: true });
  assert.deepEqual(partial.tracks.map(track => track.id), ['en']);
  assert.ok(!partial.tracks[0].content.includes('Second'), 'outdated cue is omitted, never replaced by source text');
});

test('F-0033/AC-3 every track uses the same EDL projection and carries language/default metadata', () => {
  const build = buildSoftSubtitleTracks({ chunks, keptSegments: segments, languageTracks: tracks,
    activeTrackId: 'ja', primaryLanguage: 'zh', selectedIds: ['primary', 'ja'], allowPartial: false });
  assert.equal(build.tracks.length, 2);
  const ja = build.tracks.find(track => track.id === 'ja')!;
  assert.equal(ja.languageCode, 'ja');
  assert.equal(ja.default, true);
  assert.match(ja.content, /00:00:01\.000 --> 00:00:01\.500/, 'c2 is clipped to the kept part of its range');
  assert.match(ja.content, /00:00:01\.500 --> 00:00:02\.500/, 'c3 starts at the output time after the cut');
  assert.ok(ja.content.includes('三番'));
  const primary = build.tracks.find(track => track.id === 'primary')!;
  assert.equal(primary.languageCode, 'zh');
  assert.ok(primary.content.includes('第三句'));
});
