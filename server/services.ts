import type { JobSnapshot, PipelineInput, PipelineResult, ExportInput, AgentInput, TextInput } from '../shared/protocol';
import type { AsrRequest, ModelInfo, ModelRef, ProviderKind, ProviderModels, ProviderSummary } from '../shared/providers';
import type { ASRProgress, SubtitleTranscript } from '../src/types/subtitle';
import type { Server } from 'node:http';
import type { EditorPlugin } from '../src/types/plugin';
import type { z } from 'zod';

export interface HostConfig { home: string; port: number; token: string; resourceRoot: string; 
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
  shellToken?: string }
export type ProgressReporter = (progress: ASRProgress) => void;
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
  /** `audioPath` is a 16 kHz mono PCM16 WAV. The registry validates the result. */
  transcribe?(request: AsrRequest, audioPath: string, signal: AbortSignal, report: ProgressReporter): Promise<SubtitleTranscript>;
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
}
export interface JobService {
  create(run: (signal: AbortSignal, report: ProgressReporter, id: string) => Promise<unknown>): JobSnapshot;
  get(id: string): JobSnapshot;
  list(): JobSnapshot[];
  cancel(id: string): Promise<JobSnapshot>;
}
export interface AssetService {
  put(bytes: Buffer): Promise<string>;
  /** Streams a body into a new asset, rejecting it once it exceeds `limit` bytes. */
  putStream(source: NodeJS.ReadableStream, limit: number): Promise<string>;
  /** Moves a finished file (e.g. an export output) into the asset store without copying. */
  adopt(file: string): Promise<string>;
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
export interface ExportService { start(input: ExportInput): JobSnapshot }
export interface EditorPluginRegistry {
  register(plugin: EditorPlugin): () => void;
  get(id: string): EditorPlugin;
  has(id: string): boolean;
  list(): EditorPlugin['manifest'][];
}
export interface TextService { start(input: TextInput): JobSnapshot }
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
  }
  interface Events {
    /**
     * Policy hook before an Agent tool executes. Returning a string bails out: the string becomes the
     * tool result and the tool is not run (e.g. approval or sandbox policies).
     */
    'agent/before-tool'(call: { jobId: string; name: string; args: unknown }): string | undefined | Promise<string | undefined>;
  }
}
