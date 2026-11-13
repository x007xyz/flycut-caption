import type { ModelInfo, ModelRef, ProviderModels, ProviderSummary } from '../../shared/providers';

export interface LocatedModel {
  provider: ProviderSummary;
  model: ModelInfo;
}

/** Finds the single recommended ASR model advertised by Host Providers. */
export function findRecommendedAsrModel(groups: ProviderModels[]): LocatedModel | undefined {
  for (const group of groups) {
    const model = group.models.find(item => item.role === 'asr' && item.recommended);
    if (model) return { provider: group.provider, model };
  }
  return undefined;
}

/** True only for free local/offline built-in ASR models; never cloud or user HTTP endpoints. */
export function isOfflineBuiltinAsrModel(provider: ProviderSummary, model: ModelInfo): boolean {
  return provider.kind === 'builtin' && model.role === 'asr' && model.offline === true;
}

/** Picks a ready local/offline built-in ASR model (recommended first). Never selects paid/cloud models. */
export function pickDefaultOfflineAsrModel(groups: ProviderModels[]): LocatedModel | undefined {
  const candidates: LocatedModel[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const model of group.models) {
      if (isOfflineBuiltinAsrModel(group.provider, model) && model.status === 'ready') {
        candidates.push({ provider: group.provider, model });
      }
    }
  }
  return candidates.find(item => item.model.recommended) ?? candidates[0];
}

/** Lists all ready ASR models across providers so the user can manually switch on failure. */
export function listReadyAsrModels(groups: ProviderModels[]): LocatedModel[] {
  const ready: LocatedModel[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const model of group.models) {
      if (model.role === 'asr' && model.status === 'ready') {
        ready.push({ provider: group.provider, model });
      }
    }
  }
  return ready;
}

/**
 * Returns true when an existing selection should be kept untouched:
 * - it points to an existing ASR model (ready or explicitly chosen downloadable/unavailable), or
 * - its provider exists in the catalog with a transient error.
 */
export function shouldPreserveUserSelection(groups: ProviderModels[], current: ModelRef | null | undefined): boolean {
  if (!current) return false;
  const group = groups.find(item => item.provider.id === current.providerId);
  if (!group) return false;
  if (group.error) return true;
  return group.models.some(model => model.id === current.modelId && model.role === 'asr');
}

export function formatByteSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function modelStateSignature(model: ModelInfo | undefined): string {
  if (!model) return 'missing';
  return `${model.status}:${model.size ?? ''}:${model.timestampLevel ?? ''}:${String(Boolean(model.recommended))}`;
}
