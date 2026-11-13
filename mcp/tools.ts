import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { CliHostError, discoverHostConnection, HostCliClient, type ConnectionConfig } from '../cli/client';
import { redactSecrets } from '../shared/errors';
import type { ProjectExportResult, ProjectSuggestResult, ProjectTranscribeResult } from '../shared/projectOps';
import type { OptionValue, ProviderModels } from '../shared/providers';
import type { JobSnapshot } from '../shared/protocol';
import type { McpResourceDefinition, McpToolCallResult, McpToolContext, McpToolDefinition } from './protocol';

type UuidString = `${string}-${string}-${string}-${string}-${string}`;

export interface McpRuntimeOptions {
  host?: string;
  token?: string;
  tokenFile?: string;
  home?: string;
  version: string;
}

const ID_FIELDS = new Set([
  'projectId',
  'videoId',
  'jobId',
  'confirmationId',
  'suggestionId',
  'configId',
  'assetId',
  'operationId',
]);

const SETUP_GUIDE = [
  'FlyCut Host is not connected or not running.',
  '1. Start FlyCut Desktop or run `pnpm host:dev` in the FlyCut Caption workspace.',
  '2. By default, FlyCut MCP discovers `~/.flycut-caption/host/connection.json`.',
  '3. Or pass `--host <url> --token <token>` / set `FLYCUT_HOST_URL` and `FLYCUT_HOST_TOKEN` (or `FLYCUT_HOST_HOME`).',
].join('\n');

function okResult(data: Record<string, unknown>): McpToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(
  code: string,
  message: string,
  extra: { next?: string; setup?: string; details?: Record<string, unknown>; [key: string]: unknown } = {},
): McpToolCallResult {
  const { next, setup, details, ...rest } = extra;
  const payload: Record<string, unknown> = {
    ok: false,
    ...rest,
    error: {
      code,
      message,
      ...(next ? { next } : {}),
      ...(setup ? { setup } : {}),
      ...(details && Object.keys(details).length ? { details } : {}),
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function toJSONSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
}

function parseZodError(error: z.ZodError): McpToolCallResult {
  const issues = error.issues.map(issue => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  const isInvalidId = error.issues.some(issue => {
    const head = issue.path[0];
    return typeof head === 'string' && ID_FIELDS.has(head) && issue.code === 'invalid_format';
  });
  return errorResult(
    isInvalidId ? 'INVALID_ID' : 'INVALID_ARGUMENT',
    error.issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; '),
    {
      next: 'Check the tool inputSchema; unknown arguments and malformed UUIDs are rejected.',
      details: { issues },
    },
  );
}

function formatToolError(error: unknown, ctx: McpToolContext, hostConfig?: ConnectionConfig): McpToolCallResult {
  if (error instanceof z.ZodError) {
    return parseZodError(error);
  }
  const redact = (value: string) => redactSecrets(value, hostConfig ? [hostConfig.token] : []);
  if (error instanceof CliHostError) {
    const safeMsg = redact(error.message);
    const safeNext = error.next ? redact(error.next) : undefined;
    return errorResult(error.code, safeMsg, {
      ...(safeNext ? { next: safeNext } : {}),
      ...(error.code === 'NO_HOST_CONNECTION' ? { setup: SETUP_GUIDE } : {}),
      ...(Object.keys(error.details).length ? { details: error.details } : {}),
    });
  }
  const msg = redact(error instanceof Error ? error.message : String(error));
  ctx.log(`tool execution failed: ${msg}`);
  return errorResult('RPC_ERROR', msg);
}

function resolveAsrModelRef(groups: ProviderModels[], providerArg?: string, modelArg?: string) {
  let providerId = providerArg;
  let modelId = modelArg;
  if (modelId && !providerId && modelId.includes('/')) {
    const slash = modelId.indexOf('/');
    providerId = modelId.slice(0, slash);
    modelId = modelId.slice(slash + 1);
  }
  if (!modelId) {
    throw new CliHostError('MODEL_REQUIRED', 'Missing ASR modelId (and providerId).', {
      next: 'Call flycut_list_models with role="asr" to discover available models, then pass providerId and modelId.',
    });
  }
  if (providerId) return { providerId, modelId };
  const matches = groups.filter(group => group.models.some(model => model.id === modelId && model.role === 'asr'));
  if (matches.length === 1) return { providerId: matches[0].provider.id, modelId };
  if (matches.length > 1) {
    throw new CliHostError('MODEL_REQUIRED', `Multiple providers offer ASR model "${modelId}"; specify providerId explicitly.`, {
      next: `Available providerId values: ${matches.map(match => match.provider.id).join(', ')}`,
    });
  }
  throw new CliHostError('NOT_FOUND', `ASR model not found: ${modelId}`, {
    next: 'Call flycut_list_models with role="asr" to inspect available ASR models.',
  });
}

async function verifyApprovedOverwriteConfirmation(client: HostCliClient, confirmationId: string) {
  const confirmation = await client.call('confirmations.get', { id: confirmationId });
  if (confirmation.kind !== 'overwrite-export') {
    throw new CliHostError('INVALID_ARGUMENT', `Confirmation ${confirmationId} is for ${confirmation.kind}, not overwrite-export.`);
  }
  if (confirmation.status === 'rejected') {
    throw new CliHostError('CONFIRMATION_REJECTED', 'Overwrite export request was rejected by the FlyCut client.');
  }
  if (confirmation.status === 'expired') {
    throw new CliHostError('CONFIRMATION_EXPIRED', 'Overwrite export confirmation expired; create a new confirmation request.');
  }
  if (confirmation.status === 'consumed') {
    throw new CliHostError('CONFIRMATION_ALREADY_CONSUMED', 'This overwrite confirmation was already consumed; request a new confirmation.');
  }
  if (confirmation.status !== 'approved') {
    throw new CliHostError('CONFIRMATION_NOT_APPROVED', 'Overwrite export has not been approved in the FlyCut UI client yet.', {
      details: { confirmationId, status: confirmation.status },
    });
  }
  return confirmation;
}

function makeClientEntry(projectId: string, videoId?: string): string {
  return videoId ? `#/projects/${projectId}/videos/${videoId}` : `#/projects/${projectId}`;
}

function emitJobProgress(ctx: McpToolContext, job: JobSnapshot) {
  const pct = typeof job.progress?.progress === 'number' ? Math.round(job.progress.progress) : undefined;
  const msg = job.progress?.data ? `${job.status}: ${job.progress.data}` : job.status;
  if (pct !== undefined) ctx.sendProgress(pct, 100, msg);
  else ctx.sendProgress(0, 100, msg);
}

function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  annotations?: McpToolDefinition['annotations'];
  requiresHost?: false;
  run: (args: z.infer<S>, helpers: { client: HostCliClient; ctx: McpToolContext }) => Promise<McpToolCallResult>;
}, getClient: (ctx: McpToolContext) => Promise<{ client: HostCliClient; conn: ConnectionConfig }>): McpToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: toJSONSchema(spec.schema),
    annotations: spec.annotations,
    handler: async (rawArgs, ctx) => {
      let conn: ConnectionConfig | undefined;
      try {
        const parsed = spec.schema.parse(rawArgs);
        const resolved = await getClient(ctx);
        conn = resolved.conn;
        return await spec.run(parsed, { client: resolved.client, ctx });
      } catch (error) {
        return formatToolError(error, ctx, conn);
      }
    },
  };
}

export function createFlycutMcpTools(options: McpRuntimeOptions): {
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
} {
  const getClient = async (ctx: { log: (msg: string) => void; registerSecret: (secret: string) => void }) => {
    if (options.token) ctx.registerSecret(options.token);
    if (process.env.FLYCUT_HOST_TOKEN) ctx.registerSecret(process.env.FLYCUT_HOST_TOKEN);
    const conn = await discoverHostConnection({
      host: options.host,
      token: options.token,
      tokenFile: options.tokenFile,
      home: options.home,
    });
    ctx.registerSecret(conn.token);
    const client = new HostCliClient(conn, message => ctx.log(message));
    return { conn, client };
  };

  const tools: McpToolDefinition[] = [
    defineTool({
      name: 'flycut_host_status',
      description: 'Check connection to the running FlyCut Host, returning hostId, capabilities, and available RPC/event metadata (no tokens or secrets).',
      schema: z.strictObject({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (_args, { client }) => {
        const [info, identity] = await Promise.all([
          client.call('host.info'),
          client.call('projects.identity'),
        ]);
        return okResult({
          ok: true,
          connected: true,
          hostUrl: client.url,
          hostId: identity.hostId,
          protocolVersion: info.protocolVersion,
          generation: info.generation,
          capabilities: info.capabilities,
          providers: info.providers,
          methodsCount: info.methods.length,
          events: info.events,
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_list_providers',
      description: 'List registered speech/TTS/VAD providers on the FlyCut Host.',
      schema: z.strictObject({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (_args, { client }) => {
        const providers = await client.call('providers.list');
        return okResult({ ok: true, providers, count: providers.length });
      },
    }, getClient),

    defineTool({
      name: 'flycut_list_models',
      description: 'List available models across providers and their readiness status (ready, download, unavailable).',
      schema: z.strictObject({
        role: z.enum(['asr', 'vad', 'punc', 'speaker', 'align', 'tts']).optional().describe('Optional model role filter.'),
        providerId: z.string().min(1).optional().describe('Optional provider ID filter.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const raw = await client.call('providers.models');
        const groups = raw
          .filter(group => !args.providerId || group.provider.id === args.providerId)
          .map(group => ({
            provider: group.provider,
            models: args.role ? group.models.filter(model => model.role === args.role) : group.models,
          }))
          .filter(group => !args.role || group.models.length > 0);
        return okResult({ ok: true, groups, count: groups.reduce((total, group) => total + group.models.length, 0) });
      },
    }, getClient),

    defineTool({
      name: 'flycut_prepare_model',
      description: 'Download or prepare a Host model. By default wait=false submits the job and returns jobId immediately; pass wait=true to stream progress until ready.',
      schema: z.strictObject({
        providerId: z.string().min(1).describe('Provider ID, e.g. sherpa-onnx.'),
        modelId: z.string().min(1).describe('Model ID to prepare.'),
        wait: z.boolean().default(false).describe('If true, wait for preparation to finish while emitting progress notifications.'),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe('Optional wait timeout in milliseconds when wait=true.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client, ctx }) => {
        const job = await client.call('providers.prepare', { providerId: args.providerId, modelId: args.modelId });
        if (!args.wait) {
          return okResult({
            ok: true,
            completed: false,
            submitted: true,
            jobId: job.id,
            hostStatus: job.status,
            providerId: args.providerId,
            modelId: args.modelId,
            pollTool: 'flycut_get_job',
            cancelTool: 'flycut_cancel_job',
          });
        }
        try {
          const settled = await client.waitForJob(job.id, {
            signal: ctx.signal,
            timeoutMs: args.timeoutMs,
            handleSigint: false,
            onProgress: current => emitJobProgress(ctx, current),
          });
          return okResult({
            ok: true,
            completed: true,
            jobId: settled.id,
            hostStatus: settled.status,
            providerId: args.providerId,
            modelId: args.modelId,
          });
        } catch (error) {
          if (error instanceof CliHostError && error.code === 'INTERRUPTED') {
            return okResult({
              ok: true,
              completed: false,
              stoppedWaiting: true,
              reason: error.details.reason ?? 'cancelled',
              hostTaskCancelled: false,
              hostStillRunning: Boolean(error.details.hostStillRunning),
              hostStatus: error.details.hostStatus ?? 'unknown',
              jobId: job.id,
              pollTool: 'flycut_get_job',
              cancelTool: 'flycut_cancel_job',
              message: error.message,
            });
          }
          throw error;
        }
      },
    }, getClient),

    defineTool({
      name: 'flycut_list_ai_configs',
      description: 'List redacted Host AI model configurations (contains hasApiKey boolean only, never API keys).',
      schema: z.strictObject({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (_args, { client }) => {
        const snapshot = await client.call('aiSettings.list');
        return okResult({ ok: true, ...snapshot });
      },
    }, getClient),

    defineTool({
      name: 'flycut_list_projects',
      description: 'List active FlyCut projects on the Host. Returns an empty array when no projects exist.',
      schema: z.strictObject({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (_args, { client }) => {
        const projects = await client.call('projects.list');
        return okResult({ ok: true, projects, count: projects.length });
      },
    }, getClient),

    defineTool({
      name: 'flycut_get_project',
      description: 'Open and inspect a project and video, including transcript summary, formal edits summary, pending suggestions count, and UI entry route.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        videoId: z.uuid().optional().describe('Optional video UUID inside the project (defaults to first video).'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const opened = await client.call('projects.open', {
          projectId: args.projectId,
          ...(args.videoId ? { videoId: args.videoId } : {}),
        });
        if (opened.status !== 'ok') {
          throw new CliHostError(
            opened.status === 'trashed' ? 'PROJECT_TRASHED' : 'VERSION_CONFLICT',
            `Project cannot be opened (${opened.status}): ${opened.name}`,
          );
        }
        const suggestions = await client.call('projects.suggestions.list', {
          projectId: args.projectId,
          videoId: opened.video.id,
        });
        return okResult({
          ok: true,
          status: opened.status,
          project: {
            id: opened.project.id,
            name: opened.project.name,
            revision: opened.project.revision,
            styleRevision: opened.project.styleRevision,
            updatedAt: opened.project.updatedAt,
          },
          video: opened.video,
          videos: opened.videos,
          media: opened.media,
          hasTranscript: !!opened.transcript,
          transcript: opened.transcript
            ? {
              language: opened.transcript.language,
              duration: opened.transcript.duration,
              chunkCount: opened.transcript.chunks.length,
              wordCount: opened.transcript.wordChunks?.length ?? 0,
              hasWordTimestamps: opened.transcript.hasWordTimestamps === true,
              chunks: opened.transcript.chunks,
            }
            : null,
          edits: opened.edits
            ? {
              chunkCount: opened.edits.chunks.length,
              deletedCount: opened.edits.editing?.edl.deleted.length ?? 0,
              edl: opened.edits.editing?.edl ?? null,
            }
            : null,
          pendingSuggestionsCount: suggestions.reduce((sum, item) => sum + item.batch.items.length, 0),
          pendingSuggestions: suggestions,
          clientEntry: makeClientEntry(opened.project.id, opened.video.id),
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_create_project',
      description: 'Create a FlyCut project from a local media filePath (uploaded to Host), an existing assetId, or as an empty project.',
      schema: z.strictObject({
        name: z.string().trim().min(1).max(240).describe('Project name.'),
        filePath: z.string().min(1).optional().describe('Local media file path to upload and attach.'),
        assetId: z.uuid().optional().describe('Existing Host uploaded asset UUID.'),
        empty: z.boolean().default(false).describe('Create an empty project without initial media.'),
        operationId: z.uuid().optional().describe('Idempotency UUID; retrying with the same operationId returns the original project.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client }) => {
        if (args.filePath && args.assetId) {
          throw new CliHostError('INVALID_ARGUMENT', 'Provide either filePath or assetId, not both.');
        }
        const operationId = (args.operationId as UuidString | undefined) ?? randomUUID();
        if (args.empty || (!args.filePath && !args.assetId)) {
          if (!args.empty) {
            throw new CliHostError('INVALID_ARGUMENT', 'Provide filePath, assetId, or set empty=true.');
          }
          const created = await client.call('projects.createEmpty', { name: args.name });
          return okResult({
            ok: true,
            projectId: created.projectId,
            revision: created.revision,
            empty: true,
            operationId,
            clientEntry: makeClientEntry(created.projectId),
          });
        }

        let assetId = args.assetId;
        let videoName = basename(args.filePath ?? 'media');
        let mimeType = '';
        if (args.filePath) {
          const uploaded = await client.uploadMediaFile(args.filePath, operationId);
          assetId = uploaded.assetId;
          videoName = uploaded.fileName;
          mimeType = uploaded.mimeType;
        }
        const created = await client.call('projects.create', {
          name: args.name,
          videoName,
          durationSeconds: 0,
          media: { assetId: assetId as UuidString, mimeType },
          operationId,
        });
        return okResult({
          ok: true,
          projectId: created.projectId,
          videoId: created.videoId,
          revision: created.revision,
          assetId,
          operationId,
          clientEntry: makeClientEntry(created.projectId, created.videoId),
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_add_video',
      description: 'Add a video or audio file to an existing project from local filePath or an existing Host assetId.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        filePath: z.string().min(1).optional().describe('Local media file path to upload.'),
        assetId: z.uuid().optional().describe('Existing Host uploaded asset UUID.'),
        videoName: z.string().trim().min(1).max(280).optional().describe('Optional display name for the added video.'),
        operationId: z.uuid().optional().describe('Idempotency UUID for safe retries.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client }) => {
        if (!args.filePath && !args.assetId) {
          throw new CliHostError('INVALID_ARGUMENT', 'Provide either filePath or assetId.');
        }
        if (args.filePath && args.assetId) {
          throw new CliHostError('INVALID_ARGUMENT', 'Provide either filePath or assetId, not both.');
        }
        const operationId = (args.operationId as UuidString | undefined) ?? randomUUID();
        let assetId = args.assetId;
        let videoName = args.videoName ?? basename(args.filePath ?? 'video');
        let mimeType = '';
        if (args.filePath) {
          const uploaded = await client.uploadMediaFile(args.filePath, operationId);
          assetId = uploaded.assetId;
          videoName = args.videoName ?? uploaded.fileName;
          mimeType = uploaded.mimeType;
        }
        const added = await client.call('projects.addVideo', {
          projectId: args.projectId,
          videoName,
          durationSeconds: 0,
          media: { assetId: assetId as UuidString, mimeType },
          operationId,
        });
        return okResult({
          ok: true,
          projectId: args.projectId,
          videoId: added.videoId,
          revision: added.revision,
          assetId,
          operationId,
          clientEntry: makeClientEntry(args.projectId, added.videoId),
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_transcribe',
      description: 'Transcribe a project video on the Host using a ModelRef. By default wait=false returns jobId with completed=false; pass wait=true to wait and verify transcript persistence.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        videoId: z.uuid().optional().describe('Optional video UUID (defaults to first video).'),
        providerId: z.string().min(1).optional().describe('ASR provider ID (e.g. sherpa-onnx).'),
        modelId: z.string().min(1).describe('ASR model ID (or providerId/modelId).'),
        language: z.string().min(1).max(32).default('auto').describe('Language code or "auto".'),
        options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Provider-specific model options.'),
        wait: z.boolean().default(false).describe('If true, wait for Host transcription completion and verify persisted transcript.'),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe('Optional wait timeout in milliseconds when wait=true.'),
        operationId: z.uuid().optional().describe('Idempotency UUID for safe retries.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client, ctx }) => {
        const operationId = (args.operationId as UuidString | undefined) ?? randomUUID();
        const groups = await client.call('providers.models');
        const model = resolveAsrModelRef(groups, args.providerId, args.modelId);
        const job = await client.call('projects.transcribe', {
          projectId: args.projectId,
          ...(args.videoId ? { videoId: args.videoId } : {}),
          model,
          language: args.language,
          ...(args.options ? { options: args.options as Record<string, OptionValue> } : {}),
          operationId,
        });
        if (!args.wait) {
          return okResult({
            ok: true,
            completed: false,
            submitted: true,
            jobId: job.id,
            hostStatus: job.status,
            operationId: job.operationId ?? operationId,
            projectId: args.projectId,
            ...(args.videoId ? { videoId: args.videoId } : {}),
            model,
            pollTool: 'flycut_get_job',
            cancelTool: 'flycut_cancel_job',
            clientEntry: makeClientEntry(args.projectId, args.videoId),
          });
        }
        try {
          const settled = await client.waitForJob(job.id, {
            signal: ctx.signal,
            timeoutMs: args.timeoutMs,
            handleSigint: false,
            onProgress: current => emitJobProgress(ctx, current),
          });
          const result = settled.result as ProjectTranscribeResult;
          const opened = await client.call('projects.open', {
            projectId: result.projectId,
            videoId: result.videoId,
          });
          if (opened.status !== 'ok' || !opened.transcript) {
            throw new CliHostError('RPC_ERROR', 'Host reported transcription complete, but transcript verification failed.');
          }
          return okResult({
            ok: true,
            completed: true,
            jobId: settled.id,
            hostStatus: settled.status,
            operationId: settled.operationId ?? operationId,
            ...result,
            clientEntry: makeClientEntry(result.projectId, result.videoId),
          });
        } catch (error) {
          if (error instanceof CliHostError && error.code === 'INTERRUPTED') {
            return okResult({
              ok: true,
              completed: false,
              stoppedWaiting: true,
              reason: error.details.reason ?? 'cancelled',
              hostTaskCancelled: false,
              hostStillRunning: Boolean(error.details.hostStillRunning),
              hostStatus: error.details.hostStatus ?? 'unknown',
              jobId: job.id,
              projectId: args.projectId,
              ...(args.videoId ? { videoId: args.videoId } : {}),
              pollTool: 'flycut_get_job',
              cancelTool: 'flycut_cancel_job',
              message: error.message,
            });
          }
          throw error;
        }
      },
    }, getClient),

    defineTool({
      name: 'flycut_suggest_edits',
      description: 'Generate review-only pending edit suggestions (fillers, silence, semantic) without altering formal subtitles, EDL, or exports. Returns suggestionId and UI clientEntry for user confirmation.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        videoId: z.uuid().optional().describe('Optional video UUID.'),
        kind: z.enum(['fillers', 'silence', 'semantic', 'all']).default('fillers').describe('Suggestion category.'),
        silenceMethod: z.enum(['auto', 'vad', 'gap']).default('auto').describe('Silence detection method.'),
        configId: z.uuid().optional().describe('Host AI config UUID for semantic suggestions.'),
        vadProviderId: z.string().min(1).optional().describe('Optional VAD provider ID.'),
        vadModelId: z.string().min(1).optional().describe('Optional VAD model ID.'),
        gapThresholdSeconds: z.number().finite().min(0.2).max(10).optional().describe('Gap threshold in seconds when using gap silence detection.'),
        wait: z.boolean().default(false).describe('If true, wait for suggestion generation to finish.'),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe('Optional wait timeout in milliseconds when wait=true.'),
        operationId: z.uuid().optional().describe('Idempotency UUID for safe retries.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client, ctx }) => {
        if ((args.vadProviderId && !args.vadModelId) || (!args.vadProviderId && args.vadModelId)) {
          throw new CliHostError('INVALID_ARGUMENT', 'Provide both vadProviderId and vadModelId together.');
        }
        const operationId = (args.operationId as UuidString | undefined) ?? randomUUID();
        const vadModel = args.vadProviderId && args.vadModelId
          ? { providerId: args.vadProviderId, modelId: args.vadModelId }
          : undefined;
        const job = await client.call('projects.suggestEdits', {
          projectId: args.projectId,
          ...(args.videoId ? { videoId: args.videoId } : {}),
          kind: args.kind,
          silenceMethod: args.silenceMethod,
          ...(args.configId ? { configId: args.configId } : {}),
          ...(vadModel ? { vadModel } : {}),
          ...(args.gapThresholdSeconds !== undefined ? { gapThresholdSeconds: args.gapThresholdSeconds } : {}),
          operationId,
        });
        if (!args.wait) {
          return okResult({
            ok: true,
            completed: false,
            submitted: true,
            jobId: job.id,
            hostStatus: job.status,
            operationId: job.operationId ?? operationId,
            projectId: args.projectId,
            ...(args.videoId ? { videoId: args.videoId } : {}),
            reviewOnly: true,
            formalEdlModified: false,
            pollTool: 'flycut_get_job',
            cancelTool: 'flycut_cancel_job',
            clientEntry: makeClientEntry(args.projectId, args.videoId),
          });
        }
        try {
          const settled = await client.waitForJob(job.id, {
            signal: ctx.signal,
            timeoutMs: args.timeoutMs,
            handleSigint: false,
            onProgress: current => emitJobProgress(ctx, current),
          });
          const result = settled.result as ProjectSuggestResult;
          return okResult({
            ok: true,
            completed: true,
            jobId: settled.id,
            hostStatus: settled.status,
            operationId: settled.operationId ?? operationId,
            ...result,
            reviewOnly: true,
            formalEdlModified: false,
            clientEntry: makeClientEntry(result.projectId, result.videoId),
          });
        } catch (error) {
          if (error instanceof CliHostError && error.code === 'INTERRUPTED') {
            return okResult({
              ok: true,
              completed: false,
              stoppedWaiting: true,
              reason: error.details.reason ?? 'cancelled',
              hostTaskCancelled: false,
              hostStillRunning: Boolean(error.details.hostStillRunning),
              hostStatus: error.details.hostStatus ?? 'unknown',
              jobId: job.id,
              projectId: args.projectId,
              ...(args.videoId ? { videoId: args.videoId } : {}),
              pollTool: 'flycut_get_job',
              cancelTool: 'flycut_cancel_job',
              message: error.message,
            });
          }
          throw error;
        }
      },
    }, getClient),

    defineTool({
      name: 'flycut_list_suggestions',
      description: 'List pending review-only edit suggestions stored on the Host for a project video. Returns an empty array when none exist.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        videoId: z.uuid().optional().describe('Optional video UUID.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const suggestions = await client.call('projects.suggestions.list', {
          projectId: args.projectId,
          ...(args.videoId ? { videoId: args.videoId } : {}),
        });
        return okResult({
          ok: true,
          projectId: args.projectId,
          ...(args.videoId ? { videoId: args.videoId } : {}),
          suggestions,
          count: suggestions.length,
          clientEntry: makeClientEntry(args.projectId, args.videoId ?? suggestions[0]?.videoId),
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_dismiss_suggestion',
      description: 'Dismiss a pending review-only edit suggestion batch on the Host.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        videoId: z.uuid().describe('Target video UUID.'),
        suggestionId: z.uuid().describe('Pending suggestion batch UUID.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client }) => {
        const res = await client.call('projects.suggestions.dismiss', args);
        return okResult({
          ok: true,
          dismissed: res.ok,
          projectId: args.projectId,
          videoId: args.videoId,
          suggestionId: args.suggestionId,
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_export',
      description: 'Export video or subtitles from formal project state. Writing to a new file is allowed directly; overwriting an existing file requires client UI approval (confirmationId).',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        videoId: z.uuid().optional().describe('Optional video UUID.'),
        format: z.enum(['mp4', 'webm', 'srt', 'vtt', 'json', 'ass']).default('mp4').describe('Export format.'),
        quality: z.enum(['high', 'medium', 'low']).default('medium').describe('Video quality preset.'),
        preserveAudio: z.boolean().default(true).describe('Whether to include audio track.'),
        joinFadeMs: z.number().min(0).max(100).default(0).describe('Audio crossfade at cuts in ms.'),
        subtitleProcessing: z.enum(['none', 'soft', 'hard']).default('none').describe('Subtitle embedding mode for video exports.'),
        subtitleExportMode: z.enum(['Bilingual', 'Main', 'Second']).default('Bilingual').describe('Subtitle track mode.'),
        outPath: z.string().min(1).optional().describe('Optional local file path to save the exported artifact when wait=true (or to pre-check overwrite confirmation).'),
        overwrite: z.boolean().default(false).describe('Set true only when supplying an approved confirmationId to overwrite an existing file.'),
        confirmationId: z.uuid().optional().describe('Approved overwrite-export confirmation UUID from FlyCut UI client.'),
        wait: z.boolean().default(false).describe('If true, wait for export completion (and write outPath if provided).'),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe('Optional wait timeout in milliseconds when wait=true.'),
        operationId: z.uuid().optional().describe('Idempotency UUID for safe retries.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client, ctx }) => {
        const operationId = args.operationId ?? randomUUID();
        const absOut = args.outPath ? resolve(args.outPath) : undefined;
        const targetExists = absOut ? !!(await stat(absOut).catch(() => undefined)) : false;
        const needsOverwriteConfirmation = targetExists || args.overwrite;

        if (needsOverwriteConfirmation) {
          if (!args.confirmationId) {
            const confirmation = await client.call('confirmations.create', {
              kind: 'overwrite-export',
              source: 'mcp',
              target: {
                projectId: args.projectId,
                ...(args.videoId ? { videoId: args.videoId } : {}),
                outputName: absOut ? basename(absOut) : `export.${args.format}`,
                format: args.format,
              },
              operationId,
            });
            return errorResult('CONFIRMATION_REQUIRED', `Target file exists or overwrite requested; client confirmation required (${confirmation.id}).`, {
              status: 'pending_confirmation',
              executed: false,
              confirmationId: confirmation.id,
              operationId: confirmation.operationId ?? operationId,
              outPath: absOut,
              clientEntry: '#/projects',
              clientOnlyApproval: true,
              confirmation,
              next: `Ask the user to approve confirmation ${confirmation.id} in the FlyCut UI client, then retry with confirmationId="${confirmation.id}".`,
            });
          }
          await verifyApprovedOverwriteConfirmation(client, args.confirmationId);
        }

        const job = await client.call('projects.export', {
          projectId: args.projectId,
          ...(args.videoId ? { videoId: args.videoId } : {}),
          format: args.format,
          quality: args.quality,
          preserveAudio: args.preserveAudio,
          joinFadeMs: args.joinFadeMs,
          subtitleProcessing: args.subtitleProcessing,
          subtitleExportMode: args.subtitleExportMode,
          operationId,
        });

        if (!args.wait) {
          return okResult({
            ok: true,
            completed: false,
            submitted: true,
            jobId: job.id,
            hostStatus: job.status,
            operationId: job.operationId ?? operationId,
            projectId: args.projectId,
            ...(args.videoId ? { videoId: args.videoId } : {}),
            format: args.format,
            ...(absOut ? { outPath: absOut } : {}),
            ...(args.confirmationId ? { confirmationId: args.confirmationId } : {}),
            pollTool: 'flycut_get_job',
            cancelTool: 'flycut_cancel_job',
            clientEntry: makeClientEntry(args.projectId, args.videoId),
            ...(absOut ? { nextStep: 'After flycut_get_job reports status="complete", call flycut_save_export with result.assetId and outPath.' } : {}),
          });
        }

        try {
          const settled = await client.waitForJob(job.id, {
            signal: ctx.signal,
            timeoutMs: args.timeoutMs,
            handleSigint: false,
            onProgress: current => emitJobProgress(ctx, current),
          });
          const result = settled.result as ProjectExportResult;
          if (!absOut) {
            return okResult({
              ok: true,
              completed: true,
              jobId: settled.id,
              hostStatus: settled.status,
              operationId: settled.operationId ?? operationId,
              ...result,
              clientEntry: makeClientEntry(result.projectId, result.videoId),
              nextStep: 'Call flycut_save_export with assetId and a local outPath to write the file.',
            });
          }
          let consumedConfirmation = false;
          const downloaded = await client.downloadAssetToFile(
            result.assetId,
            absOut,
            needsOverwriteConfirmation,
            async ({ targetExists: racedExists }) => {
              if (racedExists || args.overwrite) {
                if (!args.confirmationId) {
                  throw new CliHostError('CONFIRMATION_REQUIRED', `Target appeared before write; refusing unconfirmed overwrite: ${absOut}`);
                }
                await client.call('confirmations.consume', { id: args.confirmationId });
                consumedConfirmation = true;
              }
            },
          );
          await client.call('assets.delete', { assetId: result.assetId }).catch(() => undefined);
          return okResult({
            ok: true,
            completed: true,
            jobId: settled.id,
            hostStatus: settled.status,
            operationId: settled.operationId ?? operationId,
            ...result,
            outPath: downloaded.outPath,
            sizeBytes: downloaded.sizeBytes,
            ...(consumedConfirmation && args.confirmationId ? { confirmationConsumed: args.confirmationId } : {}),
            clientEntry: makeClientEntry(result.projectId, result.videoId),
          });
        } catch (error) {
          if (error instanceof CliHostError && error.code === 'INTERRUPTED') {
            return okResult({
              ok: true,
              completed: false,
              stoppedWaiting: true,
              reason: error.details.reason ?? 'cancelled',
              hostTaskCancelled: false,
              hostStillRunning: Boolean(error.details.hostStillRunning),
              hostStatus: error.details.hostStatus ?? 'unknown',
              jobId: job.id,
              projectId: args.projectId,
              ...(args.videoId ? { videoId: args.videoId } : {}),
              pollTool: 'flycut_get_job',
              cancelTool: 'flycut_cancel_job',
              message: error.message,
            });
          }
          throw error;
        }
      },
    }, getClient),

    defineTool({
      name: 'flycut_save_export',
      description: 'Download a completed export asset from the Host to a local file path. Overwriting an existing file requires client UI approval (confirmationId).',
      schema: z.strictObject({
        assetId: z.uuid().describe('Exported Host asset UUID from a completed export job.'),
        outPath: z.string().min(1).describe('Local destination file path.'),
        projectId: z.uuid().optional().describe('Project UUID (required when creating a new overwrite confirmation request).'),
        videoId: z.uuid().optional().describe('Optional video UUID.'),
        format: z.enum(['mp4', 'webm', 'srt', 'vtt', 'json', 'ass']).optional().describe('Export format label.'),
        overwrite: z.boolean().default(false).describe('Explicit overwrite intent; requires an approved confirmationId.'),
        confirmationId: z.uuid().optional().describe('Approved overwrite-export confirmation UUID from FlyCut UI client.'),
        operationId: z.uuid().optional().describe('Idempotency UUID for confirmation creation.'),
        deleteAssetAfterSave: z.boolean().default(true).describe('Release temporary Host asset after writing to disk.'),
      }),
      annotations: { idempotentHint: false },
      run: async (args, { client }) => {
        const absOut = resolve(args.outPath);
        const targetExists = !!(await stat(absOut).catch(() => undefined));
        const needsOverwriteConfirmation = targetExists || args.overwrite;
        const operationId = args.operationId ?? randomUUID();

        if (needsOverwriteConfirmation) {
          if (!args.confirmationId) {
            if (!args.projectId) {
              return errorResult('CONFIRMATION_REQUIRED', `Target file exists or overwrite requested (${absOut}); provide projectId to create a client confirmation request or choose a new outPath.`, {
                status: 'pending_confirmation',
                outPath: absOut,
              });
            }
            const confirmation = await client.call('confirmations.create', {
              kind: 'overwrite-export',
              source: 'mcp',
              target: {
                projectId: args.projectId,
                ...(args.videoId ? { videoId: args.videoId } : {}),
                outputName: basename(absOut),
                ...(args.format ? { format: args.format } : {}),
              },
              operationId,
            });
            return errorResult('CONFIRMATION_REQUIRED', `Target file exists or overwrite requested; client confirmation required (${confirmation.id}).`, {
              status: 'pending_confirmation',
              executed: false,
              confirmationId: confirmation.id,
              operationId: confirmation.operationId ?? operationId,
              outPath: absOut,
              clientEntry: '#/projects',
              clientOnlyApproval: true,
              confirmation,
              next: `Ask the user to approve confirmation ${confirmation.id} in the FlyCut UI client, then retry with confirmationId="${confirmation.id}".`,
            });
          }
          await verifyApprovedOverwriteConfirmation(client, args.confirmationId);
        }

        let consumedConfirmation = false;
        const downloaded = await client.downloadAssetToFile(
          args.assetId,
          absOut,
          needsOverwriteConfirmation,
          async ({ targetExists: racedExists }) => {
            if (racedExists || args.overwrite) {
              if (!args.confirmationId) {
                throw new CliHostError('CONFIRMATION_REQUIRED', `Target appeared before write; refusing unconfirmed overwrite: ${absOut}`);
              }
              await client.call('confirmations.consume', { id: args.confirmationId });
              consumedConfirmation = true;
            }
          },
        );
        if (args.deleteAssetAfterSave) {
          await client.call('assets.delete', { assetId: args.assetId }).catch(() => undefined);
        }
        return okResult({
          ok: true,
          saved: true,
          assetId: args.assetId,
          outPath: downloaded.outPath,
          sizeBytes: downloaded.sizeBytes,
          ...(consumedConfirmation && args.confirmationId ? { confirmationConsumed: args.confirmationId } : {}),
          ...(args.projectId ? { projectId: args.projectId } : {}),
          ...(args.videoId ? { videoId: args.videoId } : {}),
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_list_jobs',
      description: 'List recent and running background jobs on the Host.',
      schema: z.strictObject({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (_args, { client }) => {
        const jobs = await client.call('jobs.list');
        return okResult({ ok: true, jobs, count: jobs.length });
      },
    }, getClient),

    defineTool({
      name: 'flycut_get_job',
      description: 'Read current status, progress, result, or error of a Host background job by jobId.',
      schema: z.strictObject({
        jobId: z.uuid().describe('Host job UUID.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const job = await client.call('jobs.get', { id: args.jobId });
        return okResult({
          ok: true,
          job,
          jobId: job.id,
          status: job.status,
          completed: job.status === 'complete',
          failed: job.status === 'error',
          cancelled: job.status === 'cancelled',
          running: job.status === 'queued' || job.status === 'running',
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_cancel_job',
      description: 'Request cancellation of a running Host background job and return the actual Host job status.',
      schema: z.strictObject({
        jobId: z.uuid().describe('Host job UUID to cancel.'),
      }),
      annotations: { idempotentHint: true },
      run: async (args, { client }) => {
        const job = await client.call('jobs.cancel', { id: args.jobId });
        return okResult({
          ok: true,
          job,
          jobId: job.id,
          status: job.status,
          hostTaskCancelled: job.status === 'cancelled',
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_list_confirmations',
      description: 'List client-side destructive confirmation requests (pending or all). Approval can only be performed by the user in the FlyCut UI client.',
      schema: z.strictObject({
        status: z.enum(['pending', 'all']).default('pending').describe('Filter by pending or all confirmation requests.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const confirmations = await client.call('confirmations.list', { status: args.status });
        return okResult({ ok: true, confirmations, count: confirmations.length });
      },
    }, getClient),

    defineTool({
      name: 'flycut_get_confirmation',
      description: 'Read status and details of a client-side confirmation request by confirmationId.',
      schema: z.strictObject({
        confirmationId: z.uuid().describe('Confirmation request UUID.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const confirmation = await client.call('confirmations.get', { id: args.confirmationId });
        return okResult({ ok: true, confirmation });
      },
    }, getClient),

    defineTool({
      name: 'flycut_request_delete_project',
      description: 'Create a pending client confirmation request to trash or purge a project. Never executes immediately and cannot self-approve; retries with the same operationId return the original confirmationId.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        purge: z.boolean().default(false).describe('If true, request permanent purge of an already-trashed project; otherwise request moving to trash.'),
        operationId: z.uuid().optional().describe('Idempotency UUID for deduplicating retries.'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const operationId = args.operationId ?? randomUUID();
        const confirmation = await client.call('confirmations.create', {
          kind: args.purge ? 'purge-project' : 'trash-project',
          source: 'mcp',
          target: { projectId: args.projectId },
          operationId,
        });
        return okResult({
          ok: true,
          status: 'pending_confirmation',
          executed: false,
          confirmationId: confirmation.id,
          operationId: confirmation.operationId ?? operationId,
          kind: confirmation.kind,
          source: confirmation.source,
          target: confirmation.target,
          summary: confirmation.summary,
          expiresAt: confirmation.expiresAt,
          clientEntry: '#/projects',
          clientOnlyApproval: true,
          pollTool: 'flycut_get_confirmation',
          next: `Ask the user to approve or reject confirmation ${confirmation.id} in the FlyCut UI client.`,
        });
      },
    }, getClient),

    defineTool({
      name: 'flycut_request_remove_video',
      description: 'Create a pending client confirmation request to remove a video from a project. Never executes immediately and cannot self-approve.',
      schema: z.strictObject({
        projectId: z.uuid().describe('Target project UUID.'),
        videoId: z.uuid().describe('Target video UUID.'),
        operationId: z.uuid().optional().describe('Idempotency UUID for deduplicating retries.'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
      run: async (args, { client }) => {
        const operationId = args.operationId ?? randomUUID();
        const confirmation = await client.call('confirmations.create', {
          kind: 'remove-video',
          source: 'mcp',
          target: { projectId: args.projectId, videoId: args.videoId },
          operationId,
        });
        return okResult({
          ok: true,
          status: 'pending_confirmation',
          executed: false,
          confirmationId: confirmation.id,
          operationId: confirmation.operationId ?? operationId,
          kind: confirmation.kind,
          source: confirmation.source,
          target: confirmation.target,
          summary: confirmation.summary,
          expiresAt: confirmation.expiresAt,
          clientEntry: makeClientEntry(args.projectId),
          clientOnlyApproval: true,
          pollTool: 'flycut_get_confirmation',
          next: `Ask the user to approve or reject confirmation ${confirmation.id} in the FlyCut UI client.`,
        });
      },
    }, getClient),
  ];

  const resources: McpResourceDefinition[] = [
    {
      uri: 'flycut://docs/setup',
      name: 'FlyCut MCP Setup Guide',
      description: 'How to connect FlyCut MCP Server to a running FlyCut Host and handle confirmations.',
      mimeType: 'text/markdown',
      read: async () => [
        '# FlyCut Caption MCP Server Setup',
        '',
        '1. Start FlyCut Caption Desktop or run `pnpm host:dev` so the local Host is listening.',
        '2. By default, `flycut-mcp` reads `~/.flycut-caption/host/connection.json`.',
        '3. Or set `FLYCUT_HOST_URL` and `FLYCUT_HOST_TOKEN` (or `FLYCUT_HOST_HOME`).',
        '4. Edit suggestions stay review-only in Host until confirmed in the FlyCut editor UI.',
        '5. Destructive requests (delete project, remove video, overwrite export) always require user approval in the FlyCut UI client.',
      ].join('\n'),
    },
    {
      uri: 'flycut://host/status',
      name: 'FlyCut Host Live Status',
      description: 'Current FlyCut Host connection status (tokens and API keys omitted).',
      mimeType: 'application/json',
      read: async ctx => {
        try {
          const { client } = await getClient(ctx);
          const [info, identity] = await Promise.all([
            client.call('host.info'),
            client.call('projects.identity'),
          ]);
          return JSON.stringify({
            connected: true,
            hostUrl: client.url,
            hostId: identity.hostId,
            protocolVersion: info.protocolVersion,
            capabilities: info.capabilities,
            providers: info.providers,
          }, null, 2);
        } catch (error) {
          const code = error instanceof CliHostError ? error.code : 'NO_HOST_CONNECTION';
          const message = error instanceof Error ? error.message : String(error);
          return JSON.stringify({
            connected: false,
            error: { code, message, setup: SETUP_GUIDE },
          }, null, 2);
        }
      },
    },
  ];

  return { tools, resources };
}

