import { z } from 'zod';
import type { SubtitleTranscript, ASRProgress } from '../src/types/subtitle';
import type { EditorPluginManifest } from '../src/types/plugin';
import type { ProviderPackage } from '../src/types/provider';
import type { AllModelsStatus, AvailableModel } from '../src/types/model';

export const PROTOCOL_VERSION = 2;
export const rpcRequestSchema = z.object({ type: z.literal('client-request'), rpcId: z.string().min(1),
  method: z.string().min(1), payload: z.unknown() });
export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcResponse = { type: 'server-response'; rpcId: string; result:
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } } };
export type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
export interface JobSnapshot { id: string; status: JobStatus; progress?: ASRProgress; result?: unknown; error?: string; createdAt: string; updatedAt: string }

/** Provider IDs are open strings: any Host plugin may register a new ASR Provider. */
export const asrInputSchema = z.object({ providerId: z.string().min(1),
  assetId: z.string().uuid(), modelId: z.string().min(1), language: z.string().default('auto'),
  device: z.enum(['wasm', 'webgpu']).optional(),
  executionConfig: z.object({ vadModelId: z.string().optional(), alignModelId: z.string().optional(),
    timestampMode: z.enum(['auto', 'token', 'segment']).optional() }).optional(),
  api: z.object({ id: z.string(), name: z.string(), baseUrl: z.string(), model: z.string(), apiKey: z.string().optional(),
    timestamps: z.enum(['none', 'segment', 'word']), timeoutSeconds: z.number().min(10).max(600) }).optional() });
export type AsrInput = z.infer<typeof asrInputSchema>;
export interface AsrProvider { id: string; name: string;
  prepare?(modelId: string, signal: AbortSignal, report: (progress: ASRProgress) => void): Promise<void>;
  transcribe(input: AsrInput, audioPath: string, signal: AbortSignal, report: (progress: ASRProgress) => void): Promise<SubtitleTranscript> }
export const pipelineInputSchema = z.object({ asr: asrInputSchema, steps: z.array(z.object({ id: z.string(),
  providerId: z.string(), capabilityId: z.string(), enabled: z.boolean(), config: z.record(z.string(), z.unknown()).default({}) })).optional() });
export type PipelineInput = z.infer<typeof pipelineInputSchema>;
export interface PipelineResult { transcript: SubtitleTranscript; cuts: Array<{ start: number; end: number; stepId: string }> }

export const exportSegmentSchema = z.object({ start: z.number().finite().min(0), end: z.number().finite().gt(0), keep: z.boolean(),
  text: z.string().optional(), secondText: z.string().optional(), id: z.string().optional() });
export const exportInputSchema = z.object({ assetId: z.string().uuid(), segments: z.array(exportSegmentSchema).min(1),
  options: z.object({ format: z.enum(['mp4', 'webm']), quality: z.enum(['high', 'medium', 'low']), preserveAudio: z.boolean(),
    subtitleProcessing: z.enum(['none', 'soft', 'hard']).default('none'), subtitleExportMode: z.enum(['Bilingual', 'Main', 'Second']).optional(),
    assContent: z.string().optional(), subtitleTextContent: z.string().optional() }) });
export type ExportInput = z.infer<typeof exportInputSchema>;
export interface ExportResult { assetId: string; filename: string; mimeType: string }

export const jobIdSchema = z.object({ id: z.string().uuid() });
export const textInputSchema = z.object({ mode: z.enum(['correction', 'translation']),
  items: z.array(z.object({ id: z.string(), text: z.string() })), targetLang: z.string().optional(),
  model: z.object({ id: z.string(), name: z.string(), baseUrl: z.url(), apiKey: z.string(), model: z.string(), temperature: z.number().optional() }) });
export type TextInput = z.infer<typeof textInputSchema>;
export const agentInputSchema = z.object({ prompt: z.string().min(1).max(100000), asr: asrInputSchema.optional(),
  model: z.object({ baseUrl: z.url(), model: z.string().min(1), apiKey: z.string().optional() }) });
export type AgentInput = z.infer<typeof agentInputSchema>;
export interface AgentMessage { role: string; content: unknown; toolCalls?: Array<{ id?: string; name: string; args: unknown }> }
export const modelIdSchema = z.object({ modelId: z.string().min(1) });
export const pythonRequestSchema = z.object({ path: z.string(), method: z.enum(['GET', 'POST']).default('GET'), body: z.unknown().optional() });

export interface ModelScanEntry { path: string; name: string; kind: 'asr' | 'aligner' | 'vad' | 'unsupported'; model: AvailableModel | null; warnings: string[]; registered: boolean }
export interface ModelScanResult { root: string; entries: ModelScanEntry[]; warnings: string[] }
export interface ModelEnvironment { modelId: string; modelDir?: string; modelReady: boolean; sidecarReady: boolean; missingModelFiles: string[]; modelError?: string; sidecarError?: string }

export interface PluginStatus { id: string; source: 'builtin' | 'external'; module?: string; state: string; error?: string }

export interface HostInfo {
  protocolVersion: number; generation: string;
  methods: string[]; events: string[];
  providers: Array<{ id: string; name: string }>;
  capabilities: Record<string, boolean>;
}

/**
 * Typed RPC contract. Host plugins register handlers for these names through `ctx.rpc.register`.
 * Out-of-tree plugins extend it with `declare module '<path>/shared/protocol' { interface RpcMethods { ... } }`.
 */
export interface RpcMethods {
  'host.info': { input: void; output: HostInfo };
  'host.shutdown': { input: void; output: { stopping: true } };
  'jobs.list': { input: void; output: JobSnapshot[] };
  'jobs.get': { input: z.input<typeof jobIdSchema>; output: JobSnapshot };
  'jobs.cancel': { input: z.input<typeof jobIdSchema>; output: JobSnapshot };
  /** Releases an uploaded or produced asset once the client no longer needs it. */
  'assets.delete': { input: { assetId: string }; output: { deleted: string } };
  'providers.list': { input: void; output: Array<{ id: string; name: string }> };
  'providers.catalog': { input: void; output: ProviderPackage[] };
  'editing.list': { input: void; output: EditorPluginManifest[] };
  'agent.tools': { input: void; output: Array<{ name: string; description: string }> };
  'asr.downloaded': { input: void; output: string[] };
  'asr.download': { input: z.input<typeof modelIdSchema>; output: JobSnapshot };
  'workflow.start': { input: z.input<typeof pipelineInputSchema>; output: JobSnapshot };
  'agent.start': { input: z.input<typeof agentInputSchema>; output: JobSnapshot };
  'text.start': { input: z.input<typeof textInputSchema>; output: JobSnapshot };
  'export.start': { input: z.input<typeof exportInputSchema>; output: JobSnapshot };
  'python.request': { input: z.input<typeof pythonRequestSchema>; output: unknown };
  'plugins.list': { input: void; output: { profile: string; layers: string[]; plugins: PluginStatus[] } };
  'plugins.reload': { input: { id: string }; output: PluginStatus };
  'models.list': { input: void; output: AvailableModel[] };
  'models.status': { input: void; output: AllModelsStatus };
  'models.environment': { input: { modelId: string }; output: ModelEnvironment };
  'models.download': { input: { modelId: string }; output: JobSnapshot };
  'models.registerCustom': { input: { model: AvailableModel }; output: { id: string } };
  'models.removeCustom': { input: { modelId: string }; output: { removed: string } };
  'models.libraryRoot': { input: void; output: string | null };
  'models.scan': { input: { root: string }; output: ModelScanResult };
}
export type RpcMethod = keyof RpcMethods;
export type RpcInput<M extends RpcMethod> = RpcMethods[M]['input'];
export type RpcOutput<M extends RpcMethod> = RpcMethods[M]['output'];

/**
 * Host Cordis events that may cross the connection. A Host plugin must expose each one explicitly
 * (`ctx.rpc.expose(name)`); everything else stays inside the Host process.
 */
export interface RemoteEvents {
  'job/updated': { job: JobSnapshot };
  'agent/message': { jobId: string; message: AgentMessage };
  'agent/tool-result': { jobId: string; name: string; status: 'success' | 'error'; content: string };
}
export type RemoteEventName = keyof RemoteEvents;

/** WebSocket frames. `seq` is monotonic within one `generation` (one Host process lifetime). */
export interface HostHello { type: 'host/ready'; generation: string; protocolVersion: number; cursor: number; events: string[] }
export interface JobsSnapshotFrame { type: 'jobs/snapshot'; jobs: JobSnapshot[] }
export interface EventFrame<E extends RemoteEventName = RemoteEventName> { type: 'event'; generation: string; seq: number; name: E; payload: RemoteEvents[E] }
export type HostFrame = HostHello | JobsSnapshotFrame | EventFrame;
