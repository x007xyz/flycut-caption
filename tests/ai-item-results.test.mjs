import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { OpenAICompatibleEngine, validateItemResults } from '../shared/text/OpenAICompatibleEngine.ts';

const items = [{ id: 'a', text: '大家好' }, { id: 'b', text: '今天聊剪辑' }];
const model = { id: 'm', name: 'm', baseUrl: 'http://ai.test/v1', apiKey: 'k', model: 'x' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function respondWith(entries) {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(entries) } }] }));
}

describe('validateItemResults', () => {
  it('returns texts in input order and accepts numeric ids', () => {
    const items2 = [{ id: '1', text: 'x' }, { id: '2', text: 'y' }];
    assert.deepEqual(validateItemResults(items2, [{ id: 2, text: 'Y' }, { id: 1, text: 'X' }]),
      [{ id: '1', text: 'X' }, { id: '2', text: 'Y' }]);
  });

  it('rejects a missing id instead of falling back to the source text', () => {
    assert.throws(() => validateItemResults(items, [{ id: 'a', text: 'Hi' }, { id: 'c', text: 'Today' }]),
      /缺少 1 条（id: b）.*未知 id（c）/);
  });

  it('rejects duplicates and empty texts', () => {
    assert.throws(() => validateItemResults(items, [{ id: 'a', text: 'Hi' }, { id: 'a', text: 'Hi' }]), /重复 1 条/);
    assert.throws(() => validateItemResults(items, [{ id: 'a', text: 'Hi' }, { id: 'b', text: '  ' }]), /空文本 1 条（id: b）/);
  });

  it('allows an empty result when the source line is empty', () => {
    assert.deepEqual(validateItemResults([{ id: 'a', text: ' ' }], [{ id: 'a', text: '' }]), [{ id: 'a', text: '' }]);
  });
});

describe('OpenAICompatibleEngine.translate', () => {
  it('fails when the model returns the right count but a wrong id', async () => {
    respondWith([{ id: 'a', text: 'Hi everyone' }, { id: 'x', text: "Let's talk editing" }]);
    await assert.rejects(new OpenAICompatibleEngine().translate(items, model, 'English'), /缺少 1 条（id: b）/);
  });

  it('returns translations when every id is present', async () => {
    respondWith([{ id: 'b', text: "Let's talk editing" }, { id: 'a', text: 'Hi everyone' }]);
    assert.deepEqual(await new OpenAICompatibleEngine().translate(items, model, 'English'),
      [{ id: 'a', text: 'Hi everyone' }, { id: 'b', text: "Let's talk editing" }]);
  });
});
