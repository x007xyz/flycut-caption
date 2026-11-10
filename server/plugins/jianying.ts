import type { Context } from '@deepseek-ai/cordis';
import { JIANYING_CAPABILITIES } from '../../shared/jianying/draft';

/**
 * Read-only research/capability surface. F-0011 deliberately has no export RPC until a real
 * Windows 5.9.0 Jianying import has passed; registering a candidate start route would bypass AC-1.
 */
export const jianyingPlugin = { name: 'flycut-jianying', inject: ['rpc'], apply(ctx: Context) {
  ctx.effect(() => ctx.rpc.register('jianying.capabilities', undefined, () => structuredClone(JIANYING_CAPABILITIES)));
  ctx.effect(() => ctx.rpc.capability('jianyingCapabilities'));
} };
