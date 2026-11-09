import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeSubtitleExport } from '../../src/subtitle/exportFormats.ts';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle.ts';

const chunks = [{ id: 'a', text: '主字幕，测试', secondText: 'Secondary', timestamp: [1, 3] as [number, number] }];
const assOptions = { playResX: 1920, playResY: 1080, stylePair: defaultSubtitleStylePair };

test('ASS 文件导出保留 Script Info / V4+ Styles / Events，并去掉画面标点', () => {
  const content = serializeSubtitleExport('ass', chunks, { ass: { ...assOptions, exportMode: 'Bilingual' }, exportMode: 'Bilingual' });
  assert.match(content, /\[Script Info\]/);
  assert.match(content, /\[V4\+ Styles\]/);
  assert.match(content, /Style: Secondary,/);
  assert.match(content, /Style: Primary,/);
  assert.match(content, /\[Events\]/);
  assert.match(content, /Dialogue: 1,0:00:01\.00,0:00:03\.00,Primary/);
  assert.match(content, /主字幕测试/);
  assert.doesNotMatch(content, /主字幕，测试/);
});

test('ASS 文件导出按 Main / Second 只输出一个样式', () => {
  const main = serializeSubtitleExport('ass', chunks, { ass: { ...assOptions, exportMode: 'Main' }, exportMode: 'Main' });
  assert.match(main, /Style: Default,/);
  assert.doesNotMatch(main, /Style: Secondary,/);
  const second = serializeSubtitleExport('ass', chunks, { ass: { ...assOptions, exportMode: 'Second' }, exportMode: 'Second' });
  assert.match(second, /Style: Default,/);
  assert.match(second, /Secondary/);
  assert.doesNotMatch(second, /主字幕测试/);
});

