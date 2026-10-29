import type { Context } from '@deepseek-ai/cordis';
import { textInputSchema } from '../../shared/protocol';
import type { TextService } from '../services';
import { OpenAICompatibleEngine } from '../../shared/text/OpenAICompatibleEngine';

export const textPlugin = { name: 'flycut-text-provider', inject: ['jobs', 'rpc'], apply(ctx: Context) {
  const service: TextService = { start(input) {
    return ctx.jobs.create(async (signal, report) => {
      const engine = new OpenAICompatibleEngine();
      engine.setAbortSignal(signal); engine.setProgressCallback(report);
      return input.mode === 'correction' ? engine.correct(input.items, input.model) : engine.translate(input.items, input.model, input.targetLang ?? 'English');
    });
  } };
  ctx.provide('text', service);
  ctx.effect(() => ctx.rpc.register('text.start', textInputSchema, input => service.start(input)));
} };
