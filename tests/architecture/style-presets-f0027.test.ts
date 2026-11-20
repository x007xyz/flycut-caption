import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createHost } from '../../server/app';
import {
  MAX_CUSTOM_STYLE_PRESETS, dedupePresets, validatePresetName,
  type SaveStylePresetsResult, type StylePresetsSnapshot,
} from '../../shared/stylePresets';
import { applyCustomStylePreset } from '../../src/subtitle/customPresets';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle';

async function bootHost(home: string) {
  const token = 'f0027-test-token';
  const ctx = await createHost({ home, token, port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    patches: [{ source: 'f0027-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(`${method}: ${envelope.result.error?.message}`);
    return envelope.result.value;
  };
  return { ctx, call };
}

test('F-0027/AC-1 preset names reject empty, long, duplicate and full lists', () => {
  assert.equal(validatePresetName('   ', []).ok, false);
  assert.equal(validatePresetName('x'.repeat(61), []).ok, false);
  const existing = [{ id: 'a', name: 'Night' }];
  assert.deepEqual(validatePresetName('night', existing), { ok: false, code: 'duplicate', message: '已存在名为「night」的预设' });
  assert.equal(validatePresetName('night', existing, 'a').ok, true);
  const full = Array.from({ length: MAX_CUSTOM_STYLE_PRESETS }, (_, index) => ({ id: `p${index}`, name: `p${index}` }));
  assert.equal(validatePresetName('new', full).ok, false);
  assert.deepEqual(validatePresetName('  Big   Title ', []), { ok: true, name: 'Big Title' });
});

test('F-0027/AC-2 dedupe keeps one preset per case-insensitive name', () => {
  const now = new Date().toISOString();
  const presets = dedupePresets([
    { id: 'a', name: ' Night ', primary: {}, secondary: {}, createdAt: now, updatedAt: now },
    { id: 'b', name: 'night', primary: {}, secondary: {}, createdAt: now, updatedAt: now },
  ]);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, 'Night');
});

test('F-0027/AC-3 applying a preset keeps the video aspect and falls back on unknown fonts', () => {
  const preset = { primary: { ...defaultSubtitleStylePair.primary, color: '#FF0000', fontSizeRatio: 0.05, aspectPreset: 'square_1_1', bottomOffsetRatio: 0.2 },
    secondary: { ...defaultSubtitleStylePair.secondary, fontId: 'missing-font' } };
  const current = { primary: { ...defaultSubtitleStylePair.primary, aspectPreset: 'portrait_9_16' as const, bottomOffsetRatio: 0.1 },
    secondary: { ...defaultSubtitleStylePair.secondary, fontId: 'inter' } };
  const { pair, missingFont } = applyCustomStylePreset(current, preset);
  assert.equal(pair.primary.color, '#FF0000');
  assert.equal(pair.primary.fontSizeRatio, 0.05);
  assert.equal(pair.primary.aspectPreset, 'portrait_9_16');
  assert.equal(pair.primary.bottomOffsetRatio, 0.1);
  assert.equal(pair.secondary.fontId, 'inter');
  assert.equal(missingFont, true);
});

test('F-0027/AC-2 AC-7 AC-8 presets persist across Host restart, reject stale baseRevision and deduplicate operationId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0027-'));
  let projectId = '';
  const primary = { ...defaultSubtitleStylePair.primary, color: '#123456' };
  const secondary = { ...defaultSubtitleStylePair.secondary };
  try {
    const host1 = await bootHost(home);
    const stage = await fetch(`http://127.0.0.1:${(host1.ctx.httpServer.address() as { port: number }).port}/assets`, {
      method: 'POST', headers: { Authorization: 'Bearer f0027-test-token' }, body: new Uint8Array(Buffer.from('fake-media')),
    });
    const assetId = ((await stage.json()) as { assetId: string }).assetId;
    const created = await host1.call<{ projectId: string; videoId: string }>('projects.create', {
      name: '预设项目', videoName: 'a.mp4', durationSeconds: 1, media: { assetId, mimeType: 'video/mp4' } });
    projectId = created.projectId;
    const opId = randomUUID();
    const saved = await host1.call<SaveStylePresetsResult>('projects.saveStylePresets', {
      projectId, baseRevision: 0, operationId: opId, presets: [{ name: 'Night', primary, secondary }] });
    assert.equal(saved.status, 'saved');
    if (saved.status !== 'saved') return;
    assert.equal(saved.presets.length, 1);
    assert.equal(saved.presets[0].name, 'Night');
    const retry = await host1.call<SaveStylePresetsResult>('projects.saveStylePresets', {
      projectId, baseRevision: 0, operationId: opId, presets: [{ name: 'Night', primary, secondary }] });
    assert.deepEqual(retry, saved);
    const conflict = await host1.call<SaveStylePresetsResult>('projects.saveStylePresets', {
      projectId, baseRevision: 0, presets: [{ name: 'Other', primary, secondary }] });
    assert.equal(conflict.status, 'conflict');
    await host1.ctx.fiber.dispose();

    const host2 = await bootHost(home);
    try {
      const snapshot = await host2.call<StylePresetsSnapshot>('projects.getStylePresets', { projectId });
      assert.equal(snapshot.revision, 1);
      assert.equal(snapshot.presets[0].name, 'Night');
      assert.deepEqual(snapshot.presets[0].primary.color, '#123456');
    } finally { await host2.ctx.fiber.dispose(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});
