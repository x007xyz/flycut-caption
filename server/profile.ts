import type { Context, Plugin } from '@deepseek-ai/cordis';
import { readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { load as loadYaml } from 'js-yaml';
import type { PluginStatus } from '../shared/protocol';
import { rpcPlugin } from './plugins/rpc';
import { storagePlugin } from './plugins/storage';
import { uploadsPlugin } from './plugins/uploads';
import { providerRegistryPlugin } from './plugins/providers';
import { modelsPlugin } from './plugins/models';
import { sherpaAsrPlugin } from './plugins/asr';
import { endpointsPlugin } from './plugins/endpoints';
import { cloudPlugin } from './plugins/cloud';
import { ttsPlugin } from './plugins/tts';
import { indexTts302Plugin } from './plugins/indexTts302';
import { voicesPlugin } from './plugins/voices';
import { speakersPlugin } from './plugins/speakers';
import { separationPlugin } from './plugins/separation';
import { clipsPlugin } from './plugins/clips';
import { clipBatchPlugin } from './plugins/clipBatch';
import { reframePlugin } from './plugins/reframe';
import { dubbingPlugin } from './plugins/dubbing';
import { aiSettingsPlugin } from './plugins/aiSettings';
import { deleteSilenceEditingPlugin, editingPlugin, removeFillersEditingPlugin } from './plugins/editing';
import { textPlugin } from './plugins/text';
import { exportPlugin } from './plugins/export';
import { projectsPlugin } from './plugins/projects';
import { confirmationsPlugin } from './plugins/confirmations';
import { projectOpsPlugin } from './plugins/projectOps';
import { builtinAgentToolsPlugin, langgraphPlugin } from './plugins/langgraph';
import { gatewayPlugin } from './plugins/gateway';
import { silencePlugin } from './plugins/silence';
import { jianyingPlugin } from './plugins/jianying';

/** A built-in or external plugin row. `provides` lets the resolver reject a profile with unmet `inject`s before boot. */
export interface PluginRow { id: string; plugin: Plugin; provides: string[]; config?: unknown; source: 'builtin' | 'external'; module?: string }
interface Builtin { plugin: Plugin; provides: string[] }

export const BUILTINS: Record<string, Builtin> = {
  rpc: { plugin: rpcPlugin, provides: ['rpc'] },
  'plugin-manager': { plugin: undefined as unknown as Plugin, provides: [] }, // filled below to avoid a cycle
  storage: { plugin: storagePlugin, provides: ['assets', 'jobs'] },
  uploads: { plugin: uploadsPlugin, provides: [] },
  providers: { plugin: providerRegistryPlugin, provides: ['providers'] },
  models: { plugin: modelsPlugin, provides: ['models'] },
  'asr-sherpa': { plugin: sherpaAsrPlugin, provides: [] },
  'asr-cloud': { plugin: cloudPlugin, provides: [] },
  endpoints: { plugin: endpointsPlugin, provides: [] },
  tts: { plugin: ttsPlugin, provides: [] },
  'tts-index302': { plugin: indexTts302Plugin, provides: [] },
  voices: { plugin: voicesPlugin, provides: [] },
  speakers: { plugin: speakersPlugin, provides: [] },
  separation: { plugin: separationPlugin, provides: [] },
  clips: { plugin: clipsPlugin, provides: [] },
  'clip-batch': { plugin: clipBatchPlugin, provides: [] },
  reframe: { plugin: reframePlugin, provides: [] },
  'ai-settings': { plugin: aiSettingsPlugin, provides: ['aiSettings'] },
  editing: { plugin: editingPlugin, provides: ['editorPlugins'] },
  'editing-delete-silence': { plugin: deleteSilenceEditingPlugin, provides: [] },
  'editing-remove-fillers': { plugin: removeFillersEditingPlugin, provides: [] },
  silence: { plugin: silencePlugin, provides: [] },
  text: { plugin: textPlugin, provides: ['text'] },
  export: { plugin: exportPlugin, provides: ['export'] },
  projects: { plugin: projectsPlugin, provides: ['projectStore'] },
  dubbing: { plugin: dubbingPlugin, provides: [] },
  confirmations: { plugin: confirmationsPlugin, provides: [] },
  'project-ops': { plugin: projectOpsPlugin, provides: ['projectOps'] },
  jianying: { plugin: jianyingPlugin, provides: [] },
  langgraph: { plugin: langgraphPlugin, provides: ['workflows', 'agents', 'agentTools'] },
  'agent-tools': { plugin: builtinAgentToolsPlugin, provides: [] },
  gateway: { plugin: gatewayPlugin, provides: ['httpServer'] },
};
const FULL = Object.keys(BUILTINS);
/** Named compositions. Order is the boot order; dependencies are still declared by each plugin's `inject`. */
export const PROFILES: Record<string, string[]> = {
  desktop: FULL,
  web: FULL,
  /** In-process embedding and tests: everything except the network gateway. */
  headless: FULL.filter(id => id !== 'gateway'),
  /** Transport plus jobs only; useful as a base for out-of-tree compositions. */
  minimal: ['rpc', 'plugin-manager', 'storage', 'providers', 'editing', 'gateway'],
  /** Remote deployment: no plugin management, no remote shutdown, no service addresses inside the server's network. */
  server: FULL.filter(id => id !== 'plugin-manager'),
};
/** Per-profile default plugin configs. A patch's `config.<id>` replaces the whole default for that row. */
export const PROFILE_CONFIG: Record<string, Record<string, unknown>> = {
  desktop: { jianying: { allowLinkedMedia: true } },
  server: { gateway: { shutdown: false }, endpoints: { privateNetwork: false },
    'ai-settings': { privateNetwork: false, secretBackend: 'encrypted-file' }, projects: { linkedMedia: false },
    'project-ops': { linkedMedia: false }, jianying: { allowLinkedMedia: false } },
};

export const profilePatchSchema = z.object({
  /** Replace the base profile (only honoured in the first layer that sets it). */
  profile: z.string().optional(),
  disable: z.array(z.string()).default([]),
  enable: z.array(z.string()).default([]),
  /** Whole-config replacement per row id (Harness `cordis.patch.yml` semantics). */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Out-of-tree plugins: an absolute module path or a path relative to `<home>/plugins`. */
  plugins: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), module: z.string(), config: z.unknown().optional(),
    provides: z.array(z.string()).default([]), after: z.string().optional() })).default([]),
});
export type ProfilePatch = z.input<typeof profilePatchSchema>;
export interface ProfileLayer { source: string; patch: ProfilePatch }
export interface ResolvedProfile { name: string; layers: string[]; rows: Array<Omit<PluginRow, 'plugin'> & { plugin?: Plugin }> }

async function readLayer(file: string): Promise<ProfileLayer | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    // YAML is a superset of JSON for these documents; `.json` keeps strict JSON errors.
    const patch = file.endsWith('.json') ? JSON.parse(text) : loadYaml(text) ?? {};
    return { source: file, patch: patch as ProfilePatch };
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error(`无法读取 Profile 补丁 ${file}：${(error as Error).message}`); }
}

/** Layers in order: base profile → `<home>/profile.patch.{yml,yaml,json}` → `FLYCUT_PROFILE_PATCH` files → programmatic patches. */
export async function collectLayers(home: string, extra: ProfileLayer[] = []) {
  const layers: ProfileLayer[] = [];
  const homeLayers = (await Promise.all(['profile.patch.yml', 'profile.patch.yaml', 'profile.patch.json'].map(name => readLayer(join(home, name)))))
    .filter((layer): layer is ProfileLayer => !!layer);
  if (homeLayers.length > 1) throw new Error(`Host home 中只能有一个 Profile 补丁：${homeLayers.map(layer => layer.source).join('、')}`);
  layers.push(...homeLayers);
  for (const file of (process.env.FLYCUT_PROFILE_PATCH ?? '').split(delimiter).filter(Boolean)) {
    const layer = await readLayer(resolve(file)); if (!layer) throw new Error(`Profile 补丁不存在：${file}`); layers.push(layer);
  }
  return [...layers, ...extra];
}

export function resolveProfile(base: string, layers: ProfileLayer[], home: string): ResolvedProfile {
  const patches = layers.map(layer => ({ source: layer.source, patch: profilePatchSchema.parse(layer.patch) }));
  const name = patches.find(item => item.patch.profile)?.patch.profile ?? base;
  const ids = PROFILES[name]; if (!ids) throw new Error(`未知 Profile：${name}（可用：${Object.keys(PROFILES).join('、')}）`);
  const rows: ResolvedProfile['rows'] = ids.map(id => ({ id, source: 'builtin', provides: BUILTINS[id].provides, plugin: BUILTINS[id].plugin,
    config: PROFILE_CONFIG[name]?.[id] }));
  for (const { source, patch } of patches) {
    for (const id of patch.enable) {
      if (rows.some(row => row.id === id)) continue;
      if (!BUILTINS[id]) throw new Error(`${source}: 未知内置插件 ${id}`);
      // Keep built-in boot order for re-enabled rows.
      const index = FULL.indexOf(id); const before = rows.findIndex(row => row.source === 'builtin' && FULL.indexOf(row.id) > index);
      rows.splice(before < 0 ? rows.length : before, 0, { id, source: 'builtin', provides: BUILTINS[id].provides, plugin: BUILTINS[id].plugin,
        config: PROFILE_CONFIG[name]?.[id] });
    }
    for (const id of patch.disable) {
      const index = rows.findIndex(row => row.id === id); if (index < 0) throw new Error(`${source}: 无法停用不存在的插件 ${id}`);
      rows.splice(index, 1);
    }
    for (const item of patch.plugins) {
      if (rows.some(row => row.id === item.id)) throw new Error(`${source}: 插件 ID 重复 ${item.id}`);
      const module = isAbsolute(item.module) ? item.module : resolve(home, 'plugins', item.module);
      const row = { id: item.id, source: 'external' as const, module, provides: item.provides, config: item.config };
      // External rows boot before the gateway by default so their RPC methods exist when clients connect.
      const anchor = item.after ? rows.findIndex(existing => existing.id === item.after) + 1 : rows.findIndex(existing => existing.id === 'gateway');
      rows.splice(anchor <= 0 ? rows.length : anchor, 0, row);
    }
    for (const [id, config] of Object.entries(patch.config)) {
      const row = rows.find(item => item.id === id); if (!row) throw new Error(`${source}: 配置指向不存在的插件 ${id}`);
      row.config = config;
    }
  }
  return { name, layers: patches.map(item => item.source), rows };
}

const injectsOf = (plugin: Plugin | undefined) => {
  const inject = (plugin as { inject?: string[] | Record<string, unknown> } | undefined)?.inject;
  return Array.isArray(inject) ? inject : inject ? Object.keys(inject) : [];
};

/** Fails before boot when an enabled plugin injects a service nothing in the profile provides. */
export function checkDependencies(rows: PluginRow[]) {
  const provided = new Set(['hostConfig', 'pluginHost', ...rows.flatMap(row => row.provides)]);
  const missing = rows.flatMap(row => injectsOf(row.plugin).filter(name => !provided.has(name)).map(name => `${row.id} → ${name}`));
  if (missing.length) throw new Error(`Profile 依赖不满足：${missing.join('；')}`);
}

async function importExternal(module: string, fresh: boolean): Promise<Plugin> {
  await stat(module).catch(() => { throw new Error(`外部插件不存在：${module}`); });
  const loaded = await import(`${pathToFileURL(module).href}${fresh ? `?v=${Date.now()}` : ''}`) as { default?: Plugin; plugin?: Plugin };
  const plugin = loaded.default ?? loaded.plugin;
  if (!plugin) throw new Error(`外部插件 ${module} 需要 default 导出一个 Cordis 插件`);
  return plugin;
}

export interface PluginHost {
  profile: ResolvedProfile;
  list(): PluginStatus[];
  /** Disposes and loads a row again; external modules are re-imported (hot reload). */
  reload(id: string): Promise<PluginStatus>;
}
declare module '@deepseek-ai/cordis' { interface Context { pluginHost: PluginHost } }

const STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'];

/** Loads resolved rows into a Context and keeps their fibers for listing and reloading. */
export async function bootProfile(ctx: Context, profile: ResolvedProfile) {
  const rows: PluginRow[] = [];
  for (const row of profile.rows) rows.push({ ...row, plugin: row.plugin ?? await importExternal(row.module!, false) });
  checkDependencies(rows);
  const fibers = new Map<string, ReturnType<Context['plugin']>>();
  const errors = new Map<string, string>();
  const watchers: FSWatcher[] = [];
  const status = (row: PluginRow): PluginStatus => {
    const fiber = fibers.get(row.id);
    return { id: row.id, source: row.source, module: row.module, state: fiber ? STATES[fiber.state] ?? String(fiber.state) : 'stopped', error: errors.get(row.id) };
  };
  const host: PluginHost = {
    profile,
    list: () => rows.map(status),
    async reload(id) {
      const row = rows.find(item => item.id === id); if (!row) throw new Error(`未知插件：${id}`);
      if (['rpc', 'plugin-manager', 'gateway'].includes(id)) throw new Error(`${id} 是运行时核心插件，不能在运行中重载`);
      errors.delete(id);
      await fibers.get(id)?.dispose();
      try {
        if (row.source === 'external') row.plugin = await importExternal(row.module!, true);
        const fiber = ctx.plugin(row.plugin, row.config); fibers.set(id, fiber); await fiber.await();
      } catch (error) { errors.set(id, error instanceof Error ? error.message : String(error)); }
      return status(row);
    },
  };
  ctx.provide('pluginHost', host);
  for (const row of rows) {
    const fiber = ctx.plugin(row.plugin, row.config); fibers.set(row.id, fiber);
    await fiber.await();
  }
  if (process.env.FLYCUT_PLUGIN_WATCH === '1') {
    // Config-only HMR analogue: external modules reload on change; built-ins require a Host restart.
    for (const row of rows.filter(item => item.source === 'external')) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      watchers.push(watch(row.module!, () => {
        clearTimeout(timer); timer = setTimeout(() => { void host.reload(row.id).then(result => console.log(`[plugins] reloaded ${row.id}: ${result.state}`)); }, 150);
      }));
    }
  }
  ctx.effect(() => () => watchers.forEach(watcher => watcher.close()));
  return host;
}

export const pluginManagerPlugin = { name: 'flycut-plugin-manager', inject: ['rpc', 'pluginHost'], apply(ctx: Context) {
  ctx.effect(() => ctx.rpc.register('plugins.list', undefined, () => ({ profile: ctx.pluginHost.profile.name, layers: ctx.pluginHost.profile.layers, plugins: ctx.pluginHost.list() })));
  ctx.effect(() => ctx.rpc.register('plugins.reload', z.object({ id: z.string().min(1) }), ({ id }) => ctx.pluginHost.reload(id)));
} };
BUILTINS['plugin-manager'].plugin = pluginManagerPlugin;
