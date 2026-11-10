import type { Context } from '@deepseek-ai/cordis';
import type { EditorPlugin } from '../../src/types/plugin';
import type { EditorPluginRegistry } from '../services';
import { deleteSilencePlugin } from '../../shared/editing/deleteSilencePlugin';
import { removeFillersPlugin } from '../../shared/editing/fillerPlugin';

/** Registry of edit analyzers. Each registered id is also a Workflow step capability. */
export const editingPlugin = { name: 'flycut-editing-analysis', inject: ['rpc'], apply(ctx: Context) {
  const plugins = new Map<string, EditorPlugin>();
  const registry: EditorPluginRegistry = {
    register(plugin) {
      const { id } = plugin.manifest;
      if (plugins.has(id)) throw new Error(`Duplicate editor plugin: ${id}`);
      plugins.set(id, plugin);
      return () => { if (plugins.get(id) === plugin) plugins.delete(id); };
    },
    get(id) { const plugin = plugins.get(id); if (!plugin) throw new Error(`Editor plugin unavailable: ${id}`); return plugin; },
    has: id => plugins.has(id),
    list: () => [...plugins.values()].map(plugin => plugin.manifest),
  };
  ctx.provide('editorPlugins', registry);
  ctx.effect(() => ctx.rpc.register('editing.list', undefined, () => registry.list()));
} };

export const deleteSilenceEditingPlugin = { name: 'flycut-editing-delete-silence', inject: ['editorPlugins'], apply(ctx: Context) {
  ctx.effect(() => ctx.editorPlugins.register(deleteSilencePlugin));
} };

export const removeFillersEditingPlugin = { name: 'flycut-editing-remove-fillers', inject: ['editorPlugins'], apply(ctx: Context) {
  ctx.effect(() => ctx.editorPlugins.register(removeFillersPlugin));
} };
