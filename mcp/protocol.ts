import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { redactSecrets } from '../shared/errors';

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolContext {
  requestId: JsonRpcId;
  signal: AbortSignal;
  progressToken?: string | number;
  sendProgress: (progress: number, total?: number, message?: string) => void;
  log: (message: string) => void;
  registerSecret: (secret: string) => void;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: unknown, ctx: McpToolContext) => Promise<McpToolCallResult>;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: (ctx: { log: (message: string) => void; registerSecret: (secret: string) => void }) => Promise<string>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  tools: McpToolDefinition[];
  resources?: McpResourceDefinition[];
}

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidId(id: unknown): id is JsonRpcId {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

function requestKey(id: JsonRpcId): string {
  return typeof id === 'string' ? `s:${id}` : `n:${id}`;
}

export function createMcpStdioServer(options: McpServerOptions) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const secrets = new Set<string>();
  const registerSecret = (secret: string) => {
    const trimmed = secret.trim();
    if (trimmed.length >= 4) secrets.add(trimmed);
  };
  const redact = (value: string) => redactSecrets(value, secrets);

  const log = (message: string) => {
    stderr.write(`[flycut-mcp] ${redact(message)}\n`);
  };

  const writeFrame = (payload: unknown) => {
    const serialized = redact(JSON.stringify(payload));
    stdout.write(`${serialized}\n`);
  };

  const sendError = (id: JsonRpcId | null, code: number, message: string, data?: unknown) => {
    const frame: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: redact(message),
        ...(data !== undefined ? { data } : {}),
      },
    };
    writeFrame(frame);
  };

  const sendResult = (id: JsonRpcId, result: unknown) => {
    writeFrame({ jsonrpc: '2.0', id, result });
  };

  const sendNotification = (method: string, params: Record<string, unknown>) => {
    writeFrame({ jsonrpc: '2.0', method, params });
  };

  const toolMap = new Map(options.tools.map(tool => [tool.name, tool]));
  const resourceMap = new Map((options.resources ?? []).map(resource => [resource.uri, resource]));
  const inflight = new Map<string, AbortController>();
  const activeTasks = new Set<Promise<void>>();

  const handleRequest = async (msg: Record<string, unknown>) => {
    const rawId = msg.id;
    const hasId = rawId !== undefined && rawId !== null;
    const id = isValidId(rawId) ? rawId : null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !msg.method) {
      if (hasId) sendError(id, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
      return;
    }

    const method = msg.method;
    const params = msg.params;

    // Notifications (no id)
    if (!hasId) {
      if (method === 'notifications/initialized') {
        return;
      }
      if (method === 'notifications/cancelled') {
        if (isRecord(params) && isValidId(params.requestId)) {
          const controller = inflight.get(requestKey(params.requestId));
          if (controller) {
            log(`received notifications/cancelled for request ${String(params.requestId)}`);
            controller.abort(new Error('Client cancelled wait'));
          }
        }
        return;
      }
      return;
    }

    if (id === null) {
      sendError(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC request id');
      return;
    }

    if (method === 'initialize') {
      const requested = isRecord(params) && typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : undefined;
      const negotiated = requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      sendResult(id, {
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: options.name,
          version: options.version,
        },
        ...(options.instructions ? { instructions: redact(options.instructions) } : {}),
      });
      return;
    }

    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, {
        tools: options.tools.map(tool => ({
          name: tool.name,
          description: redact(tool.description),
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      });
      return;
    }

    if (method === 'tools/call') {
      if (!isRecord(params) || typeof params.name !== 'string' || !params.name) {
        sendError(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a non-empty tool name');
        return;
      }
      const tool = toolMap.get(params.name);
      if (!tool) {
        sendError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${params.name}`);
        return;
      }
      const meta = isRecord(params._meta) ? params._meta : undefined;
      const progressToken = meta && (typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number')
        ? meta.progressToken
        : undefined;

      const controller = new AbortController();
      const key = requestKey(id);
      inflight.set(key, controller);

      const ctx: McpToolContext = {
        requestId: id,
        signal: controller.signal,
        progressToken,
        sendProgress: (progress, total, message) => {
          if (progressToken === undefined) return;
          sendNotification('notifications/progress', {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            ...(message ? { message: redact(message) } : {}),
          });
        },
        log,
        registerSecret,
      };

      try {
        const result = await tool.handler(params.arguments ?? {}, ctx);
        const safeResult: McpToolCallResult = {
          content: result.content.map(block => ({
            type: 'text',
            text: redact(block.text),
          })),
          ...(result.structuredContent !== undefined
            ? { structuredContent: JSON.parse(redact(JSON.stringify(result.structuredContent))) as Record<string, unknown> }
            : {}),
          ...(result.isError ? { isError: true } : {}),
        };
        sendResult(id, safeResult);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'RPC_ERROR', message } }) }],
          structuredContent: { ok: false, error: { code: 'RPC_ERROR', message } },
          isError: true,
        });
      } finally {
        inflight.delete(key);
      }
      return;
    }

    if (method === 'resources/list') {
      sendResult(id, {
        resources: (options.resources ?? []).map(resource => ({
          uri: resource.uri,
          name: resource.name,
          description: redact(resource.description),
          mimeType: resource.mimeType,
        })),
      });
      return;
    }

    if (method === 'resources/read') {
      if (!isRecord(params) || typeof params.uri !== 'string' || !params.uri) {
        sendError(id, JSON_RPC_INVALID_PARAMS, 'resources/read requires a resource uri');
        return;
      }
      const resource = resourceMap.get(params.uri);
      if (!resource) {
        sendError(id, JSON_RPC_INVALID_PARAMS, `Unknown resource uri: ${params.uri}`);
        return;
      }
      try {
        const text = redact(await resource.read({ log, registerSecret }));
        sendResult(id, {
          contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
        });
      } catch (error) {
        sendError(id, JSON_RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    sendError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  };

  const run = async (): Promise<void> => {
    const rl = createInterface({ input: stdin, crlfDelay: Infinity });
    await new Promise<void>(resolveRun => {
      rl.on('line', line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          sendError(null, JSON_RPC_PARSE_ERROR, 'Invalid JSON');
          return;
        }
        if (!isRecord(parsed)) {
          sendError(null, JSON_RPC_INVALID_REQUEST, 'JSON-RPC message must be an object');
          return;
        }
        const task = handleRequest(parsed).catch(error => {
          log(`unhandled request error: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => {
          activeTasks.delete(task);
        });
        activeTasks.add(task);
      });
      rl.once('close', () => {
        for (const controller of inflight.values()) {
          controller.abort(new Error('MCP client disconnected'));
        }
        void Promise.allSettled([...activeTasks]).then(() => resolveRun());
      });
    });
  };

  return { run, log, registerSecret };
}

