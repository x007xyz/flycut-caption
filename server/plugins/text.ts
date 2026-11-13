import type { Context } from '@deepseek-ai/cordis';
import { keywordSuggestInputSchema, semanticCutsInputSchema, textInputSchema } from '../../shared/protocol';
import type { TextService } from '../services';
import { OpenAICompatibleEngine } from '../../shared/text/OpenAICompatibleEngine';
import { SemanticContractError } from '../../shared/editing/semanticFillers';
import { KeywordContractError } from '../../shared/text/keywords';

export const textPlugin = { name: 'flycut-text-provider', inject: ['jobs', 'rpc', 'aiSettings'], apply(ctx: Context) {
  const service: TextService = {
    start(input) {
      return ctx.jobs.create(async (signal, report) => {
        const engine = new OpenAICompatibleEngine();
        engine.setAbortSignal(signal); engine.setProgressCallback(report);
        const model = input.configId ? await ctx.aiSettings.resolve(input.configId) : input.model!;
        return input.mode === 'correction' ? engine.correct(input.items, model) : engine.translate(input.items, model, input.targetLang ?? 'English');
      });
    },
    suggestCuts(input) {
      return ctx.jobs.create(async (signal, report) => {
        const engine = new OpenAICompatibleEngine();
        engine.setAbortSignal(signal); engine.setProgressCallback(report);
        const model = await ctx.aiSettings.resolve(input.configId);
        try {
          return await engine.suggestCuts(model, input.request);
        } catch (error) {
          if (error instanceof SemanticContractError) {
            throw new Error(`Invalid analysis result (${error.code}): ${error.message}`);
          }
          throw error;
        }
      });
    },
    suggestKeywords(input) {
      return ctx.jobs.create(async (signal, report) => {
        const engine = new OpenAICompatibleEngine();
        engine.setAbortSignal(signal); engine.setProgressCallback(report);
        const model = await ctx.aiSettings.resolve(input.configId);
        try {
          return await engine.suggestKeywords(model, input.request);
        } catch (error) {
          if (error instanceof KeywordContractError) {
            throw new Error(`Invalid keyword result (${error.code}): ${error.message}`);
          }
          throw error;
        }
      });
    },
  };
  ctx.provide('text', service);
  ctx.effect(() => ctx.rpc.register('text.start', textInputSchema, input => service.start(input)));
  ctx.effect(() => ctx.rpc.register('text.suggestCuts', semanticCutsInputSchema, input => service.suggestCuts(input)));
  ctx.effect(() => ctx.rpc.register('text.suggestKeywords', keywordSuggestInputSchema, input => service.suggestKeywords(input)));
} };
