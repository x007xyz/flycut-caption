import type { Context } from '@deepseek-ai/cordis';
import { Annotation, StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { agentInputSchema, pipelineInputSchema, type AgentInput, type AgentMessage, type PipelineInput, type PipelineResult } from '../../shared/protocol';
import type { SubtitleTranscript } from '../../src/types/subtitle';
import type { AgentTool, AgentToolRegistry, ProgressReporter, WorkflowService } from '../services';

/** Default orchestration plugin. Domain services do not expose LangGraph objects. */
export const langgraphPlugin = { name: 'flycut-langgraph', inject: ['providers', 'jobs', 'assets', 'editorPlugins', 'rpc'], apply(ctx: Context) {
  const PipelineState = Annotation.Root({
    input: Annotation<PipelineInput>(), transcript: Annotation<SubtitleTranscript>(),
    cuts: Annotation<PipelineResult['cuts']>(),
  });
  // Steps are resolved against the editor-plugin registry, so a newly registered analyzer is a usable step.
  const enabledSteps = (input: PipelineInput) => (input.steps ?? []).filter(step => step.enabled && step.capabilityId !== 'transcribe');
  function run(input: PipelineInput, signal: AbortSignal, report: ProgressReporter): Promise<PipelineResult> {
    // Reject unavailable steps rather than silently accepting a config that never runs.
    for (const step of enabledSteps(input)) {
      if (!ctx.editorPlugins.has(step.capabilityId)) throw new Error(`Pipeline capability not available: ${step.providerId}/${step.capabilityId}`);
    }
    const graph = new StateGraph(PipelineState)
      .addNode('transcribe', async () => {
        signal.throwIfAborted();
        const transcript = await ctx.providers.transcribe(input.asr, ctx.assets.path(input.asr.assetId), signal, report);
        return { transcript };
      })
      .addNode('analyze', async state => {
        const cuts: PipelineResult['cuts'] = [];
        for (const step of enabledSteps(input)) {
          signal.throwIfAborted();
          const plugin = ctx.editorPlugins.get(step.capabilityId);
          const analysis = plugin.analyze({
            chunks: state.transcript.chunks, wordChunks: state.transcript.wordChunks,
            hasWordTimestamps: state.transcript.hasWordTimestamps, totalDuration: state.transcript.duration,
          }, step.config);
          for (const operation of plugin.buildOperations(analysis)) {
            if (operation.type === 'delete-range') cuts.push({ start: operation.start, end: operation.end, stepId: step.id,
              ...(operation.category ? { reason: operation.reason, category: operation.category, label: operation.label,
                confidence: operation.confidence } : {}) });
          }
        }
        return { cuts };
      })
      .addEdge(START, 'transcribe').addEdge('transcribe', 'analyze').addEdge('analyze', END)
      .compile();
    return graph.invoke({ input }, { signal }).then(state => ({ transcript: state.transcript, cuts: state.cuts }));
  }
  const workflows: WorkflowService = {
    run,
    start(raw) {
      const input = pipelineInputSchema.parse(raw);
      ctx.providers.get(input.asr.providerId);
      return ctx.jobs.create((signal, report) => run(input, signal, report));
    },
  };
  ctx.provide('workflows', workflows);
  ctx.effect(() => ctx.rpc.register('workflow.start', pipelineInputSchema, input => workflows.start(input)));

  const tools = new Map<string, AgentTool>();
  const agentTools: AgentToolRegistry = {
    register(item) {
      if (tools.has(item.name)) throw new Error(`Duplicate Agent tool: ${item.name}`);
      // Arguments are parsed with the tool's own schema before `invoke`, so widening is safe here.
      const entry = item as unknown as AgentTool;
      tools.set(item.name, entry);
      return () => { if (tools.get(item.name) === entry) tools.delete(item.name); };
    },
    list: () => [...tools.values()],
  };
  ctx.provide('agentTools', agentTools);
  ctx.effect(() => ctx.rpc.register('agent.tools', undefined, () => agentTools.list().map(({ name, description }) => ({ name, description }))));
  ctx.effect(() => ctx.rpc.expose('agent/message'));
  ctx.effect(() => ctx.rpc.expose('agent/tool-result'));

  const toWire = (message: BaseMessage): AgentMessage => ({ role: message.getType(), content: message.content,
    ...(message instanceof AIMessage && message.tool_calls?.length ? { toolCalls: message.tool_calls.map(call => ({ id: call.id, name: call.name, args: call.args })) } : {}) });
  function start(input: AgentInput) {
    return ctx.jobs.create(async (signal, report, jobId) => {
      const AgentState = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (left, right) => left.concat(right), default: () => [] }) });
      // Snapshot the registry per run so a tool unloading mid-run cannot change the schema the model saw.
      const available = agentTools.list();
      const bound = available.map(item => tool(async () => '', { name: item.name, description: item.description, schema: item.schema }));
      const model = new ChatOpenAI({ model: input.model.model, apiKey: input.model.apiKey || 'local',
        configuration: { baseURL: input.model.baseUrl }, maxRetries: 0 }).bindTools(bound);
      const publish = (messages: BaseMessage[]) => { for (const message of messages) ctx.emit('agent/message', { jobId, message: toWire(message) }); };
      const graph = new StateGraph(AgentState)
        .addNode('model', async state => {
          const message = await model.invoke(state.messages, { signal });
          publish([message]);
          return { messages: [message] };
        })
        .addNode('tools', async state => {
          const message = state.messages.at(-1) as AIMessage;
          const messages: ToolMessage[] = [];
          for (const call of message.tool_calls ?? []) {
            signal.throwIfAborted();
            const selected = available.find(item => item.name === call.name);
            let content: string; let status: 'success' | 'error' = 'success';
            try {
              if (!selected) throw new Error(`Unknown tool: ${call.name}`);
              const args = selected.schema.parse(call.args);
              const intercepted = await ctx.serial('agent/before-tool', { jobId, name: call.name, args });
              content = typeof intercepted === 'string' ? intercepted : await selected.invoke(args, { jobId, input, signal, report });
            } catch (error) {
              signal.throwIfAborted();
              content = error instanceof Error ? error.message : String(error); status = 'error';
            }
            ctx.emit('agent/tool-result', { jobId, name: call.name, status, content });
            messages.push(new ToolMessage({ content, tool_call_id: call.id!, status }));
          }
          return { messages };
        })
        .addEdge(START, 'model')
        .addConditionalEdges('model', state => (state.messages.at(-1) as AIMessage).tool_calls?.length ? 'tools' : END, ['tools', END])
        .addEdge('tools', 'model').compile({ checkpointer: new MemorySaver() });
      const result = await graph.invoke({ messages: [new SystemMessage('You are FlyCut Caption. Use registered tools to inspect and process attached audio. Return edit suggestions; do not claim edits were applied. Stop when the requested result is available.'), new HumanMessage(input.prompt)] },
        { signal, recursionLimit: 16, configurable: { thread_id: crypto.randomUUID() } });
      return { messages: result.messages.map(toWire) };
    });
  }
  ctx.provide('agents', { start });
  ctx.effect(() => ctx.rpc.register('agent.start', agentInputSchema, input => start(input)));
} };

/** Built-in Agent tools. Other plugins add tools the same way through `ctx.agentTools.register`. */
export const builtinAgentToolsPlugin = { name: 'flycut-agent-tools', inject: ['agentTools', 'providers', 'workflows', 'editorPlugins'], apply(ctx: Context) {
  ctx.effect(() => ctx.agentTools.register({ name: 'list_asr_providers', description: 'List available ASR Providers.', schema: z.object({}),
    async invoke() { return JSON.stringify(ctx.providers.list()); } }));
  ctx.effect(() => ctx.agentTools.register({ name: 'list_edit_analyzers', description: 'List registered edit analyzers usable as workflow steps.', schema: z.object({}),
    async invoke() { return JSON.stringify(ctx.editorPlugins.list().map(({ id, name, description }) => ({ id, name, description }))); } }));
  ctx.effect(() => ctx.agentTools.register({ name: 'transcribe_audio',
    description: 'Transcribe attached audio, optionally suggest cuts for pauses or rule-based fillers. Does not apply edits.',
    schema: z.object({ threshold: z.number().min(0.2).max(10).optional(), fillers: z.boolean().optional() }),
    async invoke({ threshold, fillers }, { input, signal, report }) {
      if (!input.asr) throw new Error('No input audio attached');
      // Use the same workflow implementation and cancellation scope as explicit UI commands.
      const steps = [
        ...threshold === undefined ? [] : [{ id: 'silence', providerId: 'delete-silence', capabilityId: 'delete-silence', enabled: true, config: { threshold } }],
        ...fillers ? [{ id: 'fillers', providerId: 'remove-fillers', capabilityId: 'remove-fillers', enabled: true, config: {} }] : [],
      ];
      const result = await ctx.workflows.run({ asr: input.asr, steps }, signal, report);
      return JSON.stringify(result);
    } }));
} };
