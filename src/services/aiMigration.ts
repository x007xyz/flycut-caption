import type { AIModelConfig } from '@/types/ai';
import type { AISettingsImportInput } from '../../shared/aiSettings';

const SOURCE_KEY = 'flycut-ai-settings-migration-source-v1';
const INTENT_KEY = 'flycut-ai-settings-migration-intent-v1';

export interface LegacyAISettingsSource {
  version: 1;
  selectedSourceId: string | null;
  configs: Array<AISettingsImportInput['configs'][number]>;
}

interface MigrationIntent { hostId: string; migrationId: string }

const storage = () => typeof localStorage === 'undefined' ? undefined : localStorage;

function randomId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `legacy-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validConfig(value: unknown): value is AIModelConfig {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AIModelConfig>;
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.baseUrl === 'string'
    && typeof item.model === 'string' && typeof item.apiKey === 'string';
}

/** Move pre-F-0056 browser values out of the general settings record before they can be rehydrated. */
export function stashLegacyAISettings(models: unknown, selectedId: unknown) {
  const local = storage(); if (!local) return;
  try {
    if (local.getItem(SOURCE_KEY)) return;
    const configs = Array.isArray(models) ? models.filter(validConfig).map(item => ({
      sourceId: item.id, name: item.name, baseUrl: item.baseUrl, model: item.model,
      temperature: item.temperature, apiKey: item.apiKey,
    })) : [];
    if (!configs.length) return;
    const selectedSourceId = typeof selectedId === 'string' && configs.some(item => item.sourceId === selectedId)
      ? selectedId : configs[0].sourceId;
    local.setItem(SOURCE_KEY, JSON.stringify({ version: 1, selectedSourceId, configs } satisfies LegacyAISettingsSource));
    // Do not leave a second plaintext copy in the ordinary settings record while the user decides.
    const rawSettings = local.getItem('app-settings');
    if (rawSettings) {
      const settings = JSON.parse(rawSettings) as { state?: Record<string, unknown>; version?: number };
      if (settings.state) {
        delete settings.state.aiModels; delete settings.state.selectedAIModelId;
        settings.version = 2; local.setItem('app-settings', JSON.stringify(settings));
      }
    }
  } catch { /* storage can be unavailable in private/SSR contexts */ }
}

export function readLegacyAISettings(): LegacyAISettingsSource | null {
  try {
    const raw = storage()?.getItem(SOURCE_KEY); if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacyAISettingsSource;
    return parsed.version === 1 && Array.isArray(parsed.configs) && parsed.configs.length ? parsed : null;
  } catch { return null; }
}

/** Persist the retry identity before the request, and scope it to one Host identity. */
export function prepareAIMigration(hostId: string): { source: LegacyAISettingsSource; migrationId: string } | null {
  const source = readLegacyAISettings(); if (!source) return null;
  const local = storage(); if (!local) return null;
  try {
    const raw = local.getItem(INTENT_KEY);
    const previous = raw ? JSON.parse(raw) as MigrationIntent : null;
    const intent = previous?.hostId === hostId ? previous : { hostId, migrationId: randomId() };
    local.setItem(INTENT_KEY, JSON.stringify(intent));
    return { source, migrationId: intent.migrationId };
  } catch { return null; }
}

/** Only a response matching the still-current Host and intent may delete the legacy secret copy. */
export function completeAIMigration(hostId: string, migrationId: string): boolean {
  const local = storage(); if (!local) return false;
  try {
    const raw = local.getItem(INTENT_KEY);
    const intent = raw ? JSON.parse(raw) as MigrationIntent : null;
    if (intent?.hostId !== hostId || intent.migrationId !== migrationId) return false;
    local.removeItem(SOURCE_KEY); local.removeItem(INTENT_KEY);
    return true;
  } catch { return false; }
}
