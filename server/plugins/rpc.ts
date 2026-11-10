import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTOCOL_VERSION, type EventFrame, type HostInfo, type RemoteEventName, type RemoteEvents, type RpcInput, type RpcMethod, type RpcOutput } from '../../shared/protocol';

interface Entry { schema?: z.ZodType; handler: (input: unknown) => unknown }

/**
 * A plain HTTP route owned by a plugin (media streaming, shell-only endpoints). The Gateway matches and authenticates;
 * `client` routes take the frontend token, `shell` routes only the desktop shell's secret (`HostConfig.shellToken`).
 */
export interface HttpRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  auth: 'client' | 'shell';
  /**
   * Desktop/dev local-bearer exception: `<video src>` cannot set an Authorization header, so this
   * read-only route may also accept `?token=`. Keep it off for writes and generic RPC.
   */
  queryToken?: boolean;
  handle(req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray): Promise<void>;
}

export interface RpcService {
  /** Registers a remote method; returns a disposer. Call inside `ctx.effect` so unloading the plugin withdraws it. */
  register<M extends RpcMethod, S extends z.ZodType<unknown, RpcInput<M>> = z.ZodVoid>(method: M, schema: S | undefined,
    handler: (input: z.output<S>) => RpcOutput<M> | Promise<RpcOutput<M>>): () => void;
  invoke(method: string, payload: unknown): Promise<unknown>;
  methods(): string[];
  /** Allows a Host Cordis event to cross the connection. Call inside `ctx.effect`. */
  expose<E extends RemoteEventName>(name: E): () => void;
  events(): string[];
  /** Transport listeners (the Gateway) receive sequenced frames for exposed events. */
  subscribe(listener: (frame: EventFrame) => void): () => void;
  generation: string;
  cursor(): number;
  /** Capability flags contributed to `host.info`. */
  capability(name: string, enabled?: boolean): () => void;
  /** Registers a plugin-owned HTTP route; returns a disposer. Call inside `ctx.effect`. */
  route(route: HttpRoute): () => void;
  /** The route matching a request, if any. */
  match(method: string, pathname: string): { route: HttpRoute; match: RegExpMatchArray } | undefined;
}

declare module '@deepseek-ai/cordis' {
  interface Context { rpc: RpcService }
  interface Events {
    'job/updated'(payload: RemoteEvents['job/updated']): void;
    'agent/message'(payload: RemoteEvents['agent/message']): void;
    'agent/tool-result'(payload: RemoteEvents['agent/tool-result']): void;
  }
}

/** Method registry and event allowlist shared by every transport. Owns the connection generation. */
export const rpcPlugin = { name: 'flycut-rpc', apply(ctx: Context) {
  const entries = new Map<string, Entry>();
  const exposed = new Map<string, () => void>();
  const listeners = new Set<(frame: EventFrame) => void>();
  const capabilities = new Map<string, boolean>();
  const routes = new Set<HttpRoute>();
  const generation = randomUUID();
  let sequence = 0;
  const service: RpcService = {
    generation, cursor: () => sequence,
    register(method, schema, handler) {
      if (entries.has(method)) throw new Error(`Duplicate RPC method: ${method}`);
      const entry: Entry = { schema, handler: handler as Entry['handler'] };
      entries.set(method, entry);
      return () => { if (entries.get(method) === entry) entries.delete(method); };
    },
    async invoke(method, payload) {
      const entry = entries.get(method); if (!entry) throw new Error(`Unknown RPC method: ${method}`);
      return entry.handler(entry.schema ? entry.schema.parse(payload) : undefined);
    },
    methods: () => [...entries.keys()].sort(),
    expose(name) {
      if (exposed.has(name)) throw new Error(`Event already exposed: ${name}`);
      const off = ctx.on(name, ((payload: RemoteEvents[typeof name]) => {
        const frame = { type: 'event', generation, seq: ++sequence, name, payload: structuredClone(payload) } as EventFrame;
        for (const listener of listeners) { try { listener(frame); } catch (error) { console.error('Event transport failed', error); } }
      }) as never);
      exposed.set(name, off);
      return () => { if (exposed.get(name) === off) { off(); exposed.delete(name); } };
    },
    events: () => [...exposed.keys()].sort(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    capability(name, enabled = true) {
      capabilities.set(name, enabled);
      return () => { capabilities.delete(name); };
    },
    route(route) { routes.add(route); return () => { routes.delete(route); }; },
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = pathname.match(route.pattern); if (match) return { route, match };
      }
      return undefined;
    },
  };
  ctx.provide('rpc', service);
  ctx.effect(() => service.register('host.info', undefined, (): HostInfo => ({
    protocolVersion: PROTOCOL_VERSION, generation, methods: service.methods(), events: service.events(),
    providers: entries.has('providers.list') ? (entries.get('providers.list')!.handler(undefined) as HostInfo['providers']) : [],
    capabilities: Object.fromEntries(capabilities),
  })));
  ctx.effect(() => () => { listeners.clear(); });
} };
