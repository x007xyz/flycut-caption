import { z } from 'zod';
import { asrHotwordSchema, type AsrHotword, type HotwordCapabilities } from './providers';

export const MAX_PROJECT_TERMS = 500;
export const MAX_TERM_LENGTH = 200;
export const MAX_HOTWORD_WEIGHT = 100;

export const projectTermEntrySchema = z.strictObject({
  id: z.string().min(1).max(64),
  term: z.string().trim().min(1, '热词不能为空').max(MAX_TERM_LENGTH, '热词长度不能超过 200 个字符'),
  asHotword: z.boolean().default(true),
  weight: z.number().finite('权重必须是有效数字').positive('权重必须大于 0').max(MAX_HOTWORD_WEIGHT, '权重不能超过 100').optional(),
  /** F-0032 预留：按目标语言保存的译名，F-0019 保存时原样保留不丢失。 */
  translations: z.record(z.string(), z.string()).optional(),
  updatedAt: z.string().min(1),
});
export type ProjectTermEntry = z.infer<typeof projectTermEntrySchema>;

export const projectTermDraftSchema = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  term: z.string().trim().min(1, '热词不能为空').max(MAX_TERM_LENGTH, '热词长度不能超过 200 个字符'),
  asHotword: z.boolean().default(true),
  weight: z.number().finite('权重必须是有效数字').positive('权重必须大于 0').max(MAX_HOTWORD_WEIGHT, '权重不能超过 100').optional(),
  translations: z.record(z.string(), z.string()).optional(),
});
export type ProjectTermDraft = z.infer<typeof projectTermDraftSchema>;

export function normalizeTermKey(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function validateTermDraft(
  draft: { term: string; weightRaw?: string },
  existing: ProjectTermEntry[],
  editingId?: string,
): { ok: true; term: string; weight?: number } | { ok: false; code: 'empty' | 'too-long' | 'invalid-weight' | 'duplicate'; message: string } {
  const trimmed = draft.term.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return { ok: false, code: 'empty', message: '热词不能为空' };
  }
  if (trimmed.length > MAX_TERM_LENGTH) {
    return { ok: false, code: 'too-long', message: '热词长度不能超过 200 个字符' };
  }
  let weight: number | undefined;
  if (draft.weightRaw !== undefined && draft.weightRaw.trim() !== '') {
    const parsed = Number(draft.weightRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_HOTWORD_WEIGHT) {
      return { ok: false, code: 'invalid-weight', message: '权重必须为大于 0 且不超过 100 的数字' };
    }
    weight = Math.round(parsed * 100) / 100;
  }
  const key = normalizeTermKey(trimmed);
  if (existing.some((item) => item.id !== editingId && normalizeTermKey(item.term) === key)) {
    return { ok: false, code: 'duplicate', message: `词表已存在「${trimmed}」` };
  }
  return { ok: true, term: trimmed, ...(weight !== undefined ? { weight } : {}) };
}

export function dedupeProjectTerms(
  entries: ProjectTermEntry[],
  existingTranslationsByKey?: Map<string, Record<string, string>>,
): ProjectTermEntry[] {
  const seen = new Set<string>();
  const result: ProjectTermEntry[] = [];
  for (const entry of entries) {
    const trimmed = entry.term.trim().replace(/\s+/g, ' ');
    const key = normalizeTermKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const preserved = entry.translations ?? existingTranslationsByKey?.get(key);
    result.push({
      id: entry.id,
      term: trimmed,
      asHotword: entry.asHotword,
      ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
      ...(preserved ? { translations: preserved } : {}),
      updatedAt: entry.updatedAt,
    });
  }
  return result;
}

export function selectActiveHotwords(
  terms: ProjectTermEntry[],
  capabilities?: HotwordCapabilities,
): AsrHotword[] {
  if (!capabilities?.supported) return [];
  const active = terms.filter((item) => item.asHotword && item.term.trim().length > 0);
  const sliced = capabilities.maxTerms !== undefined ? active.slice(0, capabilities.maxTerms) : active;
  return sliced.map((item) =>
    asrHotwordSchema.parse({
      term: item.term.trim(),
      ...(capabilities.weights && item.weight !== undefined ? { weight: item.weight } : {}),
    }),
  );
}

export function formatHotwordsForOption(hotwords: AsrHotword[], capabilities?: HotwordCapabilities): string {
  if (!hotwords.length) return '';
  if (capabilities?.format === 'weighted-lines' && capabilities.weights) {
    return hotwords.map((h) => (h.weight !== undefined ? `${h.term} ${h.weight}` : h.term)).join('\n');
  }
  if (capabilities?.format === 'prompt') {
    return hotwords.map((h) => h.term).join(', ');
  }
  return hotwords.map((h) => h.term).join(' ');
}

export const getTerminologyInputSchema = z.strictObject({
  projectId: z.uuid(),
});

export const saveTerminologyInputSchema = z.strictObject({
  projectId: z.uuid(),
  terms: z.array(projectTermDraftSchema).max(MAX_PROJECT_TERMS),
  baseRevision: z.number().int().min(0),
  operationId: z.uuid().optional(),
});
export type SaveTerminologyInput = z.input<typeof saveTerminologyInputSchema>;

export interface TerminologySnapshot {
  projectId: string;
  revision: number;
  terminology: ProjectTermEntry[];
}

export type SaveTerminologyResult =
  | { status: 'saved'; revision: number; projectRevision: number; updatedAt: string; terminology: ProjectTermEntry[] }
  | { status: 'conflict'; revision: number; updatedAt: string; terminology: ProjectTermEntry[] };


/** F-0032: flag cues whose translation does not contain a required glossary translation. */
function usesTranslation(text: string, translation: string): boolean {
  const haystack = text.toLocaleLowerCase();
  const needle = translation.toLocaleLowerCase();
  if (haystack.includes(needle)) return true;
  if (!/^[a-z][a-z -]*$/i.test(needle)) return false;
  if (needle.endsWith('y') && haystack.includes(`${needle.slice(0, -1)}ies`)) return true;
  return haystack.includes(`${needle}s`) || haystack.includes(`${needle}es`);
}

export function findTerminologyIssues(
  items: ReadonlyArray<{ id: string; sourceText: string; translatedText: string }>,
  terms: ReadonlyArray<{ term: string; translation: string }>,
): Array<{ id: string; terms: string[] }> {
  if (!terms.length) return [];
  const issues: Array<{ id: string; terms: string[] }> = [];
  for (const item of items) {
    const missing = terms.filter(({ term, translation }) =>
      item.sourceText.includes(term) && !usesTranslation(item.translatedText, translation));
    if (missing.length) issues.push({ id: item.id, terms: missing.map(entry => entry.term) });
  }
  return issues;
}
