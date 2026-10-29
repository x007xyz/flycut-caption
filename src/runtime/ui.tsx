import { createElement, Fragment, useSyncExternalStore, useEffect, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { RuntimeContext, useClientRuntime } from './context';
import { createClientRuntime, type UISlots } from './client';
import { discoverHost } from './connection';

/** Renders every contribution registered for a slot, in order (exclusive slots hold at most one). */
export function PluginSlot<K extends keyof UISlots>({ id, ...props }: { id: K } & ComponentProps<UISlots[K]>) {
  const { ui } = useClientRuntime(); useSyncExternalStore(ui.subscribe, ui.version, ui.version);
  return createElement(Fragment, null, ...ui.list(id).map(item =>
    createElement(item.component as ComponentType<ComponentProps<UISlots[K]>>, { key: item.id, ...props } as ComponentProps<UISlots[K]>)));
}
export function ClientRuntime({ shell, plugins, children }: { shell: UISlots['shell']; plugins?: object[]; children: ReactNode }) {
  const [state, setState] = useState<{ ctx?: Context; error?: string }>({});
  useEffect(() => {
    let disposed = false; let owned: Context | undefined;
    void discoverHost().then(options => createClientRuntime(options, shell, plugins)).then(ctx => {
      if (disposed) { void ctx.fiber.dispose(); return; }
      owned = ctx; setState({ ctx });
    }, error => { if (!disposed) setState({ error: error instanceof Error ? error.message : String(error) }); });
    return () => { disposed = true; if (owned) void owned.fiber.dispose(); };
  }, [shell, plugins]);
  if (state.error) return <div role="alert" className="p-8">{state.error}</div>;
  if (!state.ctx) return <div role="status" className="p-8">正在连接 FlyCut Host…</div>;
  return <RuntimeContext.Provider value={state.ctx}>{children}</RuntimeContext.Provider>;
}
