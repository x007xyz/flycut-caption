import type { JobSnapshot, PipelineInput, PipelineResult, ExportInput, AgentInput, TextInput, SemanticCutsInput, KeywordSuggestInput } from '../shared/protocol';
import type { ExportResult } from '../shared/protocol';
import type { AsrRequest, ModelInfo, ModelRef, ProviderKind, ProviderModels, ProviderSummary, TtsAudioFormat, TtsRequest, VoiceActivityResult } from '../shared/providers';
import type { ValidatedTtsAudio } from '../shared/tts/audio';
import type { ASRProgress, SubtitleTranscript } from '../src/types/subtitle';
import type { AISettingsImportInput, AISettingsMutationResult, AISettingsRemoveResult, AISettingsSaveInput,
  AISettingsSaveResult, AISettingsSnapshot, AISettingsTestResult, ResolvedAIConfig } from '../shared/aiSettings';
import type { Server } from 'node:http';
import type { EditorPlugin } from '../src/types/plugin';
import type { z } from 'zod';
import type { ProjectStore } from './projects/store';

export interface HostConfig { home: string; port: number; token: string; resourceRoot: string; 
  /** Resolved profile name (after profile patches). Used for non-overridable deployment boundaries. */
  profileName?: string;
  /** User model catalog and downloads (desktop app data dir). Defaults to `<home>/app-data`. */
  appData?: string;
  /** Assets unused for this long are deleted (default 24). */
  assetTtlHours?: number;
  /** Listen address (default `127.0.0.1`). Anything else makes the Host reachable beyond this machine. */
  bind?: string;
  /** Browser origins allowed besides loopback and Tauri, e.g. `https://flycut.example.com`. */
  allowedOrigins?: string[];
  /** Built frontend (`dist/`) served by the Host together with the connection bootstrap. */
  webRoot?: string;
  /** Secret only the desktop shell holds; authorizes `shell` routes. Unset: those routes reject every request. */
  shellToken?: string;
  /** Browser session lifetime in milliseconds (default 12 hours). Sessions live in Host memory. */
  sessionTtlMs?: number;
  /** F-0015 resumable media limits. Defaults live in `shared/uploads.ts`. */
  uploadChunkBytes?: number;
  uploadMaxBytes?: number;
  uploadSessionTtlHours?: number;
  uploadDiskReserveBytes?: number;
  /** F-0018: minimum free disk reserve in bytes before model download (defaults to 64 MiB). */
  modelDiskReserveBytes?: number }
export type ProgressReporter = (progress: ASRProgress) => void;

export interface TtsSynthesizeProviderInput extends TtsRequest {
  /** Resolved local path on the Host for reference audio when cloning is authorized. */
  referenceAudioPath?: string;
}

export interface TtsProviderAudio {
  bytes: Buffer;
  mimeType?: string;
  format?: TtsAudioFormat;
  durationSeconds?: number;
  sampleRate?: number;
}

export interface TtsSynthesizeOutput extends ValidatedTtsAudio {
  bytes: Buffer;
}

/**
 * One inference backend. Capabilities are optional methods: implement only what the backend does.
 * Rules: docs/subsystems/providers.md.
 */
export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  models(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Downloads or prepares a model whose status is `download`. */
  prepare?(modelId: string, signal: AbortSignal, report: ProgressReporter): Promise<void>;
  /** Optional VAD capability; audioPath is 16 kHz mono PCM16 WAV. */
  detectVoice?(modelId: string, audioPath: string, signal: AbortSignal, report: ProgressReporter): Promise<VoiceActivityResult>;
  /** `audioPath` is a 16 kHz mono PCM16 WAV. The registry validates the result. */
  transcribe?(request: AsrRequest, audioPath: string, signal: AbortSignal, report: ProgressReporter): Promise<SubtitleTranscript>;
  /** Optional TTS capability; only implemented when the backend provides `role: 'tts'` models. */
  synthesize?(request: TtsSynthesizeProviderInput, signal: AbortSignal, report: ProgressReporter): Promise<TtsProviderAudio>;
}
export interface ProviderRegistry {
  register(provider: Provider): () => void;
  get(id: string): Provider;
  list(): ProviderSummary[];
  /** Every Provider's models; one failing Provider is reported in its group, not thrown. */
  models(): Promise<ProviderModels[]>;
  /** Looks up the model, checks its declared options, runs the Provider and validates the transcript. */
  transcribe(request: AsrRequest, audioPath: string, signal: AbortSignal, report: ProgressReporter): Promise<SubtitleTranscript>;
  prepare(ref: ModelRef, signal: AbortSignal, report: ProgressReporter): Promise<void>;
  detectVoice(ref: ModelRef, audioPath: string, signal: AbortSignal, report: ProgressReporter): Promise<VoiceActivityResult>;
  /** Looks up the TTS model, validates capabilities & cloning authorization, runs synthesis and validates audio bytes. */
  synthesize(request: TtsSynthesizeProviderInput, signal: AbortSignal, report: ProgressReporter): Promise<TtsSynthesizeOutput>;
}
export interface JobService {
  /** `id` and `operationId` are optional for idempotent producers; clients cannot choose a job ID over RPC. */
  create(run: (signal: AbortSignal, report: ProgressReporter, id: string) => Promise<unknown>, options?: string | { id?: string; operationId?: string }): JobSnapshot;
  get(id: string): JobSnapshot;
  list(): JobSnapshot[];
  cancel(id: string): Promise<JobSnapshot>;
}
export interface AssetService {
  put(bytes: Buffer): Promise<string>;
  /** Streams a body into a new asset, rejecting it once it exceeds `limit` bytes. */
  putStream(source: NodeJS.ReadableStream, limit: number): Promise<string>;
  /** Moves a finished file (e.g. an export output) into the asset store without copying. */
  adopt(file: string, id?: string): Promise<string>;
  /** Moves an uploaded asset out of the store to `target` (e.g. into a project), so the TTL cleanup no longer applies. */
  claim(id: string, target: string): Promise<void>;
  read(id: string): Promise<Buffer>;
  size(id: string): Promise<number>;
  path(id: string): string;
  delete(id: string): Promise<void>;
}
export interface WorkflowService {
  start(input: PipelineInput): JobSnapshot;
  /** Runs inside an existing job (used by Agent tools) without creating a second job. */
  run(input: PipelineInput, signal: AbortSignal, report: ProgressReporter): Promise<PipelineResult>;
}
export interface AgentToolContext { jobId: string; input: AgentInput; signal: AbortSignal; report: ProgressReporter }
export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string; description: string; schema: S;
  invoke(args: z.infer<S>, context: AgentToolContext): Promise<string>;
}
export interface AgentToolRegistry { register<S extends z.ZodObject>(tool: AgentTool<S>): () => void; list(): AgentTool[] }
export interface AgentService { start(input: AgentInput): JobSnapshot }
export interface ExportProbeInfo { width?: number; height?: number; fps?: number; duration?: number; hasAudio: boolean }
export interface ExportService {
  start(input: ExportInput): JobSnapshot;
  probeFile(source: string, signal?: AbortSignal): Promise<ExportProbeInfo>;
  runFromFile(source: string, input: Omit<ExportInput, 'assetId'>, signal: AbortSignal, report: ProgressReporter): Promise<ExportResult>;
}
export interface EditorPluginRegistry {
  register(plugin: EditorPlugin): () => void;
  get(id: string): EditorPlugin;
  has(id: string): boolean;
  list(): EditorPlugin['manifest'][];
}
export interface TextService {
  start(input: TextInput): JobSnapshot;
  /** F-0009: resolve the saved AI config on the Host and validate word-ID candidates. */
  suggestCuts(input: SemanticCutsInput): JobSnapshot;
  /** F-0025: resolve the saved AI config on the Host and recommend grounded subtitle keywords. */
  suggestKeywords(input: KeywordSuggestInput): JobSnapshot;
}
export interface AISettingsService {
  snapshot(): Promise<AISettingsSnapshot>;
  save(input: Omit<AISettingsSaveInput, 'hostId'>): Promise<AISettingsSaveResult>;
  remove(configId: string, expectedRevision: number): Promise<AISettingsRemoveResult>;
  select(configId: string | null, expectedRevision: number): Promise<AISettingsMutationResult>;
  test(configId: string): Promise<AISettingsTestResult>;
  import(input: Omit<AISettingsImportInput, 'hostId'>): Promise<import('../shared/aiSettings').AISettingsImportResult>;
  /** Host-only: resolves the secret for an upstream request. Never expose this value through RPC. */
  resolve(configId: string): Promise<ResolvedAIConfig>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    hostConfig: HostConfig;
    providers: ProviderRegistry;
    jobs: JobService;
    assets: AssetService;
    workflows: WorkflowService;
    agents: AgentService;
    agentTools: AgentToolRegistry;
    export: ExportService;
    httpServer: Server;
    editorPlugins: EditorPluginRegistry;
    text: TextService;
    aiSettings: AISettingsService;
    projectStore: ProjectStore;
  }
  interface Events {
    /**
     * Policy hook before an Agent tool executes. Returning a string bails out: the string becomes the
     * tool result and the tool is not run (e.g. approval or sandbox policies).
     */
    'agent/before-tool'(call: { jobId: string; name: string; args: unknown }): string | undefined | Promise<string | undefined>;
  }
}
