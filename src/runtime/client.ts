import { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import type { FlyCutCaptionProps } from '../types';
import { connectionPlugin, type RemoteConnection } from './connection';
import type { HostConnectionOptions, HostSessionService } from './connectionModel';
import { EnhancedVideoPlayer } from '../components/VideoPlayer/EnhancedVideoPlayer';
import { SubtitleEditorPanel } from '../components/SubtitleEditor/SubtitleEditorPanel';
import { ASRSettingsPanel } from '../components/ProcessingPanel/ASRSettingsPanel';
import { AgentPanel } from '../components/AgentPanel';
import { ASRService } from '../services/asrService';
import { AIService } from '../services/aiService';
import { HostExportEngine } from '../services/videoEngines/HostExportEngine';
import { VideoEngineRegistry } from '../services/videoEngines/VideoEngineFactory';
import { createAppStore } from '../stores/appStore';
import { createHistoryStore } from '../stores/historyStore';
import { createProjectStore } from '../stores/projectStore';
import { createConnectionStore, type ConnectionState } from '../stores/connectionStore';
import type { StoreApi } from 'zustand/vanilla';

/**
 * Typed UI extension points. `shell`, `player` and `subtitle-editor` are exclusive slots;
 * the others accept any number of contributions rendered in `order`.
 * Out-of-tree client plugins add slots with `declare module '<path>/runtime/client' { interface UISlots { ... } }`.
 */
export interface UISlots {
  shell: ComponentType<FlyCutCaptionProps>;
  player: typeof EnhancedVideoPlayer;
  'subtitle-editor': typeof SubtitleEditorPanel;
  /** Tools tab; contributions are stacked. */
  tools: ComponentType;
  /** Options tab; contributions are stacked. */
  options: ComponentType<{ onOpenSettings: () => void }>;
}
export interface UIContribution<K extends keyof UISlots = keyof UISlots> { id: string; slot: K; component: UISlots[K]; order: number }
export interface UIRegistry {
  /** Adds a contribution; exclusive slots reject a second one. Call inside `ctx.effect`. */
  register<K extends keyof UISlots>(slot: K, component: UISlots[K], options?: { id?: string; order?: number }): () => void;
  get<K extends keyof UISlots>(slot: K): UISlots[K] | undefined;
  list<K extends keyof UISlots>(slot: K): Array<UIContribution<K>>;
  subscribe(listener: () => void): () => void;
  version(): number;
}
declare module '@deepseek-ai/cordis' { interface Context { ui: UIRegistry; asr: ASRService; ai: AIService; videoEngines: VideoEngineRegistry } }

const EXCLUSIVE_SLOTS = new Set<keyof UISlots>(['shell', 'player', 'subtitle-editor']);

export const uiRegistryPlugin = { name: 'flycut-ui-registry', apply(ctx: Context) {
  const contributions = new Map<keyof UISlots, UIContribution[]>(); const listeners = new Set<() => void>(); let version = 0;
  const changed = () => { version++; listeners.forEach(listener => listener()); };
  const registry: UIRegistry = {
    get: slot => contributions.get(slot)?.[0]?.component as never,
    list: slot => [...(contributions.get(slot) ?? [])] as never,
    version: () => version,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    register(slot, component, options = {}) {
      const items = contributions.get(slot) ?? [];
      if (EXCLUSIVE_SLOTS.has(slot) && items.length) throw new Error(`Duplicate UI slot: ${String(slot)}`);
      const id = options.id ?? `${String(slot)}-${items.length}`;
      if (items.some(item => item.id === id)) throw new Error(`Duplicate UI contribution: ${id}`);
      const entry = { id, slot, component, order: options.order ?? 0 } as UIContribution;
      contributions.set(slot, [...items, entry].sort((a, b) => a.order - b.order)); changed();
      return () => {
        const current = contributions.get(slot) ?? [];
        if (!current.includes(entry)) return;
        contributions.set(slot, current.filter(item => item !== entry)); changed();
      };
    },
  };
  ctx.provide('ui', registry);
} };
export function uiPlugin<K extends keyof UISlots>(name: string, slot: K, component: UISlots[K], order = 0) {
  return { name, inject: ['ui'], apply(ctx: Context) { ctx.effect(() => ctx.ui.register(slot, component, { id: name, order })); } };
}

/** Business state lives in the Context: two FlyCut instances on one page do not share a timeline or history. */
export function storesPlugin(connection: StoreApi<ConnectionState> = createConnectionStore()) { return { name: 'flycut-stores', apply(ctx: Context) {
  const app = createAppStore();
  ctx.provide('stores', { app, history: createHistoryStore(), project: createProjectStore(), connection });
  // Per-instance migration and device detection (formerly a root-level StoreInitializer).
  void app.getState().initialize();
} }; }

/** Client services are scoped to one Context and its connection; nothing is a module singleton. */
export const asrClientPlugin = { name: 'flycut-asr-client', inject: ['connection'], apply(ctx: Context) {
  const service = new ASRService(ctx.connection); ctx.provide('asr', service);
  ctx.effect(() => () => service.destroy());
} };
export const aiClientPlugin = { name: 'flycut-ai-client', inject: ['connection'], apply(ctx: Context) {
  ctx.provide('ai', new AIService(ctx.connection));
} };
export const videoEngineRegistryPlugin = { name: 'flycut-video-engines', apply(ctx: Context) {
  ctx.provide('videoEngines', new VideoEngineRegistry());
} };
/** Host FFmpeg is the only export engine everywhere. */
export const hostExportEnginePlugin = { name: 'flycut-host-export-engine', inject: ['connection', 'videoEngines'], apply(ctx: Context) {
  const connection = ctx.connection;
  ctx.effect(() => ctx.videoEngines.register('host', () => new HostExportEngine(connection)));
} };
export interface EstablishedRuntime { connection: RemoteConnection; session?: HostSessionService }

/**
 * The session controller owns an established connection. A runtime may unmount (React StrictMode, host remount)
 * without closing the transport that other runtimes and the reconnect state machine still use.
 */
function borrowedConnection(connection: RemoteConnection): RemoteConnection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'close') return () => undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function createClientRuntime(options: HostConnectionOptions | EstablishedRuntime, shell: UISlots['shell'], plugins: object[] = []) {
  const ctx = new Context();
  const established = 'connection' in options ? options : undefined;
  const connectionStore = createConnectionStore(established?.session?.snapshot());
  const updateConnection = () => { if (established?.session) connectionStore.setState(established.session.snapshot(), true); };
  const connectionStorePlugin = { name: 'flycut-connection-store', apply(inner: Context) {
    if (!established?.session) return;
    inner.effect(() => { updateConnection(); return established.session!.subscribe(updateConnection); });
  } };
  const connectionInput = established ? borrowedConnection(established.connection) : options as HostConnectionOptions;
  try {
    for (const plugin of [uiRegistryPlugin, storesPlugin(connectionStore), connectionStorePlugin,
      connectionPlugin(connectionInput, { session: established?.session }), asrClientPlugin, aiClientPlugin,
      videoEngineRegistryPlugin, hostExportEnginePlugin,
      uiPlugin('flycut-editor-shell', 'shell', shell),
      uiPlugin('flycut-player-ui', 'player', EnhancedVideoPlayer),
      uiPlugin('flycut-subtitle-editor-ui', 'subtitle-editor', SubtitleEditorPanel),
      uiPlugin('flycut-agent-ui', 'tools', AgentPanel, 10),
      uiPlugin('flycut-asr-settings-ui', 'options', ASRSettingsPanel, 10),
      ...plugins]) await ctx.plugin(plugin as Parameters<Context['plugin']>[0]).await();
    return ctx;
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
