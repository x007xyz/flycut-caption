import { z } from 'zod';

export const MAX_CUSTOM_STYLE_PRESETS = 50;
export const MAX_STYLE_PRESET_NAME = 60;

const styleRecord = z.record(z.string(), z.unknown());

export const customStylePresetSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(MAX_STYLE_PRESET_NAME),
  primary: styleRecord,
  secondary: styleRecord,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type CustomStylePreset = z.infer<typeof customStylePresetSchema>;

export const customStylePresetDraftSchema = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(MAX_STYLE_PRESET_NAME),
  primary: styleRecord,
  secondary: styleRecord,
});
export type CustomStylePresetDraft = z.infer<typeof customStylePresetDraftSchema>;

export const getStylePresetsInputSchema = z.strictObject({ projectId: z.uuid() });

export const saveStylePresetsInputSchema = z.strictObject({
  projectId: z.uuid(),
  presets: z.array(customStylePresetDraftSchema).max(MAX_CUSTOM_STYLE_PRESETS),
  baseRevision: z.number().int().min(0),
  operationId: z.uuid().optional(),
});
export type SaveStylePresetsInput = z.input<typeof saveStylePresetsInputSchema>;

export interface StylePresetsSnapshot {
  projectId: string;
  revision: number;
  presets: CustomStylePreset[];
}

export type SaveStylePresetsResult =
  | { status: 'saved'; revision: number; projectRevision: number; updatedAt: string; presets: CustomStylePreset[] }
  | { status: 'conflict'; revision: number; updatedAt: string; presets: CustomStylePreset[] };

export const normalizePresetName = (name: string) => name.trim().replace(/\s+/gu, ' ');
export const presetNameKey = (name: string) => normalizePresetName(name).toLowerCase();

export function validatePresetName(
  raw: string,
  presets: readonly Pick<CustomStylePreset, 'id' | 'name'>[],
  editingId?: string,
): { ok: true; name: string } | { ok: false; code: 'empty' | 'too-long' | 'duplicate' | 'full'; message: string } {
  const name = normalizePresetName(raw);
  if (!name) return { ok: false, code: 'empty', message: '预设名称不能为空' };
  if (name.length > MAX_STYLE_PRESET_NAME) return { ok: false, code: 'too-long', message: `预设名称不能超过 ${MAX_STYLE_PRESET_NAME} 个字符` };
  if (presets.some(preset => preset.id !== editingId && presetNameKey(preset.name) === presetNameKey(name))) {
    return { ok: false, code: 'duplicate', message: `已存在名为「${name}」的预设` };
  }
  if (!editingId && presets.length >= MAX_CUSTOM_STYLE_PRESETS) {
    return { ok: false, code: 'full', message: `自定义预设最多 ${MAX_CUSTOM_STYLE_PRESETS} 个` };
  }
  return { ok: true, name };
}

export function dedupePresets(presets: readonly CustomStylePreset[]): CustomStylePreset[] {
  const seen = new Set<string>();
  const result: CustomStylePreset[] = [];
  for (const preset of presets) {
    const key = presetNameKey(preset.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...preset, name: normalizePresetName(preset.name) });
  }
  return result;
}
