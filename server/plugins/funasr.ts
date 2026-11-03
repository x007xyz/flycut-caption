import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { createHttpProvider } from '../providers/httpProvider';
import { pythonWorker } from '../providers/worker';

/**
 * FunASR as an HTTP Provider: the Host starts `python/funasr_service.py` on first use, or connects to an
 * existing service (`FLYCUT_FUNASR_URL`, e.g. a GPU machine). Same protocol client as user endpoints.
 */
export const funasrPlugin = { name: 'flycut-asr-funasr', inject: ['providers', 'hostConfig'], apply(ctx: Context) {
  const worker = pythonWorker({ label: 'funasr', script: join(ctx.hostConfig.resourceRoot, 'python/funasr_service.py'), healthPath: '/v1/health',
    url: ctx.hostConfig.funasrUrl, token: process.env.FLYCUT_FUNASR_TOKEN,
    env: { FLYCUT_FUNASR_HOME: process.env.FLYCUT_FUNASR_HOME ?? join(ctx.hostConfig.home, 'funasr') } });
  ctx.effect(() => ctx.providers.register(createHttpProvider({ id: 'funasr', name: 'FunASR', kind: 'builtin', connect: worker.connect })));
  ctx.effect(() => () => worker.dispose());
} };
