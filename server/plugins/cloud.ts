import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { createHttpProvider } from '../providers/httpProvider';

export interface CloudConfig {
  /** FlyCut Cloud address; defaults to `FLYCUT_CLOUD_URL`. Without one the Provider is not registered. */
  baseUrl?: string;
}

/**
 * The official paid service (`flycut-cloud`): FlyCut Provider protocol v1 authenticated with the user's
 * API key. The key stays in Host memory, like user endpoint keys.
 */
export const cloudPlugin = { name: 'flycut-cloud', inject: ['providers', 'rpc'], apply(ctx: Context, config: CloudConfig = {}) {
  const baseUrl = config.baseUrl ?? process.env.FLYCUT_CLOUD_URL;
  let apiKey: string | undefined;
  ctx.effect(() => ctx.rpc.register('cloud.status', undefined, () => ({ available: !!baseUrl, hasApiKey: !!apiKey })));
  if (!baseUrl) return;
  ctx.effect(() => ctx.rpc.register('cloud.setApiKey', z.object({ apiKey: z.string().max(4096) }), input => {
    apiKey = input.apiKey || undefined;
    return { available: true, hasApiKey: !!apiKey };
  }));
  ctx.effect(() => ctx.providers.register(createHttpProvider({ id: 'flycut-cloud', name: 'FlyCut Cloud', kind: 'builtin',
    async connect() {
      if (!apiKey) throw new Error('请先填写 FlyCut Cloud 的 API Key');
      return { baseUrl, headers: { Authorization: `Bearer ${apiKey}` } };
    } })));
} };
