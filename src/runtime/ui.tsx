import { createElement, Fragment, useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { ConnectionGate } from '@/components/Connection/ConnectionGate';
import type { UISlots } from './client';
import { useClientRuntime } from './context';

/** Renders every contribution registered for a slot, in order (exclusive slots hold at most one). */
export function PluginSlot<K extends keyof UISlots>({ id, ...props }: { id: K } & ComponentProps<UISlots[K]>) {
  const { ui } = useClientRuntime(); useSyncExternalStore(ui.subscribe, ui.version, ui.version);
  return createElement(Fragment, null, ...ui.list(id).map(item =>
    createElement(item.component as ComponentType<ComponentProps<UISlots[K]>>, { key: item.id, ...props } as ComponentProps<UISlots[K]>)));
}

/**
 * ConnectionGate owns discovery/connection state; ClientRuntime only consumes the established
 * connection service. Switching hosts remounts the inner runtime with a new runtime key.
 */
export function ClientRuntime({ shell, plugins, children }: { shell: UISlots['shell']; plugins?: object[]; children: ReactNode }) {
  return <ConnectionGate shell={shell} plugins={plugins}>{children}</ConnectionGate>;
}
