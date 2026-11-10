import { useStore } from 'zustand';
import { useClientRuntime } from './context';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import type { ConnectionState } from '@/stores/connectionStore';

export function useConnectionState<T = ConnectionState>(selector?: (state: ConnectionState) => T): T {
  const store = useRuntimeStoreApi('connection');
  return useStore(store, selector ?? (state => state as unknown as T));
}

export function useHostReady() {
  return useConnectionState(state => state.phase === 'connected');
}

export function useHostSession() {
  return useClientRuntime().hostSession;
}
