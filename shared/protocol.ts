import { z } from 'zod';
import { edlSchema } from './editing/edl';
import type { SubtitleTranscript, ASRProgress } from '../src/types/subtitle';
import type { EditorPluginManifest } from '../src/types/plugin';
import { asrRequestSchema, modelRefSchema, type ProviderModels, type ProviderSummary } from './providers';
import { subtitleGraphicSceneSchema } from './subtitle-graphics/scene';
import { semanticWindowSchema } from './editing/semanticFillers';
import {
  aiSettingsImportInputSchema, aiSettingsRemoveInputSchema, aiSettingsSaveInputSchema, aiSettingsSelectInputSchema,
  aiSettingsTestInputSchema, type AISettingsImportResult, type AISettingsMutationResult, type AISettingsRemoveResult,
  type AISettingsSaveResult, type AISettingsSnapshot, type AISettingsTestResult,
} from './aiSettings';
import {
  ttsSettingsSaveInputSchema, ttsSynthesizeInputSchema,
  type TtsSettingsSaveInput, type TtsSettingsSaveResult, type TtsSettingsSnapshot, type TtsSynthesizeInput,
} from './tts/settings';
import type { UploadCapabilities } from './uploads';
import type { JianyingCapabilities, JianyingPreflightInput, JianyingPreflightResult, JianyingStartInput } from './jianying/draft';
import type { ProjectFile, ProjectListItem, ProjectOpenResult, SaveResult, projectCreateSchema, projectOpenSchema, saveTranscriptSchema,
  saveEditsSchema, duplicateSchema, relinkSchema, thumbnailSchema,
  createEmptySchema, projectRefSchema, renameSchema, emptyTrashSchema, addVideoSchema, removeVideoSchema, saveVideoEditsSchema, saveProjectStyleSchema, createFromSnapshotSchema,
  ProjectDetailResult, TrashItem, SaveResultV2, HostIdentity } from './projects';

export const PROTOCOL_VERSION = 2;
export const rpcRequestSchema = z.object({ type: z.literal('client-request'), rpcId: z.string().min(1),
  method: z.string().min(1), payload: z.unknown() });
export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcResponse = { type: 'server-response'; rpcId: string; result:
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } } };
export type JobStatus = 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
export interface JobSnapshot { id: string; status: JobStatus; progress?: ASRProgress; result?: unknown; error?: string; createdAt: string; updatedAt: string;
  /** F-0015: repeating a start with the same operation id returns this job instead of starting another. */
  operationId?: string }

/** An ASR request (`{ providerId, modelId }` + language/options) on an uploaded 16 kHz WAV asset. */
export const asrInputSchema = asrRequestSchema.extend({ assetId: z.string().uuid() });
export type AsrInput = z.infer<typeof asrInputSchema>;
export const pipelineInputSchema = z.object({ operationId: z.uuid().optional(), asr: asrInputSchema, steps: z.array(z.object({ id: z.string(),
  providerId: z.string(), capabilityId: z.string(), enabled: z.boolean(), config: z.record(z.string(), z.unknown()).default({}) })).optional() });
export type PipelineInput = z.infer<typeof pipelineInputSchema>;
export interface PipelineResult { transcript: SubtitleTranscript; cuts: Array<{ start: number; end: number; stepId: string;
  reason?: string; category?: string; label?: string; confidence?: number }> }

export const exportSegmentSchema = z.object({ start: z.number().finite().min(0), end: z.number().finite().gt(0), keep: z.boolean(),
  text: z.string().optional(), secondText: z.string().optional(), id: z.string().optional() });
export const exportInputSchema = z.object({ operationId: z.uuid().optional(), edl: edlSchema.optional(), assetId: z.string().uuid(), segments: z.array(exportSegmentSchema).min(1),
  options: z.object({ format: z.enum(['mp4', 'webm']), quality: z.enum(['high', 'medium', 'low']), preserveAudio: z.boolean(),
    joinFadeMs: z.number().min(0).max(100).optional(),
    subtitleProcessing: z.enum(['none', 'soft', 'hard']).default('none'), subtitleExportMode: z.enum(['Bilingual', 'Main', 'Second']).optional(),
    /** New hard-subtitle path: the client sends a versioned scene, the Host renders it with Skia. */
    subtitleTransport: z.literal('skia-band').optional(), subtitleScene: subtitleGraphicSceneSchema.optional(),
    subtitleTextContent: z.string().optional() }) });
export type ExportInput = z.infer<typeof exportInputSchema>;
export interface ExportResult { assetId: string; filename: string; mimeType: string }

export const jobIdSchema = z.object({ id: z.string().uuid() });
export const textInputSchema = z.object({ mode: z.enum(['correction', 'translation']),
  items: z.array(z.object({ id: z.string(), text: z.string() })), targetLang: z.string().optional(),
  /** Preferred: the Host resolves the configured model and secret. */
  configId: z.uuid().optional(),
  /** Compatibility for clients released before F-0056. New clients never send this. */
  model: z.object({ id: z.string(), name: z.string(), baseUrl: z.url(), apiKey: z.string(), model: z.string(), temperature: z.number().optional() }).optional() })
  .refine(input => !!input.configId !== !!input.model, '必须且只能提供 configId 或旧 model 之一');
export type TextInput = z.infer<typeof textInputSchema>;
/** F-0009: Host resolves the saved AI config; only its opaque config ID crosses RPC. */
export const semanticCutsInputSchema = z.strictObject({
  configId: z.uuid(),
  request: semanticWindowSchema,
});
export type SemanticCutsInput = z.infer<typeof semanticCutsInputSchema>;
export const agentInputSchema = z.object({ prompt: z.string().min(1).max(100000), asr: asrInputSchema.optional(),
  configId: z.uuid().optional(),
  /** Compatibility for clients released before F-0056. */
  model: z.object({ baseUrl: z.url(), model: z.string().min(1), apiKey: z.string().optional() }).optional() })
  .refine(input => !!input.configId !== !!input.model, '必须且只能提供 configId 或旧 model 之一');
export type AgentInput = z.infer<typeof agentInputSchema>;
export interface AgentMessage { role: string; content: unknown; toolCalls?: Array<{ id?: string; name: string; args: unknown }> }
export const providerPrepareSchema = modelRefSchema;
export const silenceAnalyzeInputSchema = z.strictObject({
  projectId: z.uuid(), videoId: z.uuid(), model: modelRefSchema,
  params: z.strictObject({ minPauseSeconds: z.number().finite().positive(), guardSeconds: z.number().finite().nonnegative(),
    mode: z.enum(['shorten', 'remove']), retainSeconds: z.number().finite().nonnegative() }),
});
export type SilenceAnalyzeInput = z.infer<typeof silenceAnalyzeInputSchema>;

/** A user-added HTTP Provider. `apiKey` is accepted on save but never returned or persisted. */
export const endpointInputSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, '名称只能包含小写字母、数字和 -'),
  label: z.string().trim().min(1).max(60),
  protocol: z.enum(['flycut', 'openai']),
  baseUrl: z.string().url(),
  apiKey: z.string().max(4096).optional(),
  /** OpenAI-compatible endpoints only: model names and their timestamp level. */
  models: z.array(z.object({
    id: z.string().min(1).max(100),
    role: z.enum(['asr', 'tts']).optional(),
    timestamps: z.enum(['none', 'segment', 'word']).default('segment'),
    voices: z.array(z.string().min(1).max(100)).max(100).optional(),
    languages: z.array(z.string().max(20)).max(50).optional(),
  })).max(50).optional(),
  timeoutSeconds: z.number().min(10).max(600).default(120),
});
export type EndpointInput = z.input<typeof endpointInputSchema>;
/** FlyCut Cloud: `available` once the release configures its address. */
export interface CloudStatus { available: boolean; hasApiKey: boolean }
export interface EndpointInfo extends Omit<z.infer<typeof endpointInputSchema>, 'apiKey'> { providerId: string; hasApiKey: boolean }

export interface PluginStatus { id: string; source: 'builtin' | 'external'; module?: string; state: string; error?: string }

export interface HostInfo {
  protocolVersion: number; generation: string;
  methods: string[]; events: string[];
  providers: ProviderSummary[];
  capabilities: Record<string, boolean>;
}

/**
 * Typed RPC contract. Host plugins register handlers for these names through `ctx.rpc.register`.
 * Out-of-tree plugins extend it with `declare module '<path>/shared/protocol' { interface RpcMethods { ... } }`.
 */
export interface RpcMethods {
  'host.info': { input: void; output: HostInfo };
  /** F-0015: limits and protocol advertised by the Host's resumable upload plugin. */
  'uploads.capabilities': { input: void; output: UploadCapabilities };
  'host.shutdown': { input: void; output: { stopping: true } };
  'jobs.list': { input: void; output: JobSnapshot[] };
  'jobs.get': { input: z.input<typeof jobIdSchema>; output: JobSnapshot };
  'jobs.cancel': { input: z.input<typeof jobIdSchema>; output: JobSnapshot };
  /** Releases an uploaded or produced asset once the client no longer needs it. */
  'assets.delete': { input: { assetId: string }; output: { deleted: string } };
  'providers.list': { input: void; output: ProviderSummary[] };
  'providers.models': { input: void; output: ProviderModels[] };
  'providers.prepare': { input: z.input<typeof providerPrepareSchema>; output: JobSnapshot };
  'endpoints.list': { input: void; output: EndpointInfo[] };
  'endpoints.save': { input: EndpointInput; output: EndpointInfo };
  'endpoints.remove': { input: { name: string }; output: { removed: string } };
  'cloud.status': { input: void; output: CloudStatus };
  'cloud.setApiKey': { input: { apiKey: string }; output: CloudStatus };
  'aiSettings.list': { input: void; output: AISettingsSnapshot };
  'aiSettings.save': { input: z.input<typeof aiSettingsSaveInputSchema>; output: AISettingsSaveResult };
  'aiSettings.remove': { input: z.input<typeof aiSettingsRemoveInputSchema>; output: AISettingsRemoveResult };
  'aiSettings.select': { input: z.input<typeof aiSettingsSelectInputSchema>; output: AISettingsMutationResult };
  'aiSettings.test': { input: z.input<typeof aiSettingsTestInputSchema>; output: AISettingsTestResult };
  'aiSettings.import': { input: z.input<typeof aiSettingsImportInputSchema>; output: AISettingsImportResult };
  'tts.getSettings': { input: void; output: TtsSettingsSnapshot };
  'tts.saveSettings': { input: z.input<typeof ttsSettingsSaveInputSchema>; output: TtsSettingsSaveResult };
  'tts.synthesize': { input: z.input<typeof ttsSynthesizeInputSchema>; output: JobSnapshot };
  'editing.list': { input: void; output: EditorPluginManifest[] };
  'silence.analyze': { input: z.input<typeof silenceAnalyzeInputSchema>; output: JobSnapshot };
  'agent.tools': { input: void; output: Array<{ name: string; description: string }> };
  'workflow.start': { input: z.input<typeof pipelineInputSchema>; output: JobSnapshot };
  'agent.start': { input: z.input<typeof agentInputSchema>; output: JobSnapshot };
  'text.start': { input: z.input<typeof textInputSchema>; output: JobSnapshot };
  'text.suggestCuts': { input: z.input<typeof semanticCutsInputSchema>; output: JobSnapshot };
  'export.start': { input: z.input<typeof exportInputSchema>; output: JobSnapshot };
  /** F-0011: normal builds are read-only; internal-validation builds also register the two opaque-grant methods. */
  'jianying.capabilities': { input: void; output: JianyingCapabilities };
  'jianying.preflight': { input: JianyingPreflightInput; output: JianyingPreflightResult };
  'jianying.start': { input: JianyingStartInput; output: JobSnapshot };
  'plugins.list': { input: void; output: { profile: string; layers: string[]; plugins: PluginStatus[] } };
  'plugins.reload': { input: { id: string }; output: PluginStatus };
  /** Projects (F-0002): `server/plugins/projects.ts`, contract in `shared/projects.ts`. */
  'projects.list': { input: void; output: ProjectListItem[] };
  'projects.create': { input: z.input<typeof projectCreateSchema>; output: { projectId: string; videoId: string; revision: number; project: ProjectFile } };
  'projects.open': { input: z.input<typeof projectOpenSchema>; output: ProjectOpenResult };
  'projects.saveTranscript': { input: z.input<typeof saveTranscriptSchema>; output: SaveResult };
  'projects.saveEdits': { input: z.input<typeof saveEditsSchema>; output: SaveResult };
  'projects.duplicate': { input: z.input<typeof duplicateSchema>; output: { projectId: string; videoId: string; revision: number } };
  'projects.relinkMedia': { input: z.input<typeof relinkSchema>; output: SaveResult };
  'projects.thumbnail': { input: z.input<typeof thumbnailSchema>; output: { dataUrl: string | null } };
  /** Projects (F-0003): management, several videos per project, Trash. */
  'projects.createEmpty': { input: z.input<typeof createEmptySchema>; output: { projectId: string; revision: number } };
  'projects.detail': { input: z.input<typeof projectRefSchema>; output: ProjectDetailResult };
  'projects.rename': { input: z.input<typeof renameSchema>; output: SaveResult };
  'projects.trash': { input: z.input<typeof projectRefSchema>; output: { deletedAt: string; purgeAfter: string } };
  'projects.restore': { input: z.input<typeof projectRefSchema>; output: { revision: number } };
  'projects.trashList': { input: void; output: TrashItem[] };
  'projects.purge': { input: z.input<typeof projectRefSchema>; output: { ok: true } };
  'projects.emptyTrash': { input: z.input<typeof emptyTrashSchema>; output: { purged: string[]; failed: string[] } };
  'projects.addVideo': { input: z.input<typeof addVideoSchema>; output: { videoId: string; revision: number } };
  'projects.removeVideo': { input: z.input<typeof removeVideoSchema>; output: { revision: number } };
  'projects.saveVideoEdits': { input: z.input<typeof saveVideoEditsSchema>; output: SaveResultV2 };
  'projects.saveProjectStyle': { input: z.input<typeof saveProjectStyleSchema>; output: SaveResultV2 };
  'projects.createFromSnapshot': { input: z.input<typeof createFromSnapshotSchema>; output: { projectId: string; videoId: string } };
  /** F-0004: the Host's stable identity for crash-recovery copies. */
  'projects.identity': { input: void; output: HostIdentity };
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
