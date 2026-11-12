import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useConnectionState } from '@/runtime/connectionHooks';

/** Loads the current Host's public AI configuration projection and isolates late responses across Host switches. */
export function useHostAISettings() {
  const { connection, stores } = useClientRuntime();
  const status = useSyncExternalStore(connection.subscribe, connection.snapshot, connection.snapshot);
  const hostId = useConnectionState(state => state.identity?.hostId);
  const request = useRef(0);

  useEffect(() => {
    const generation = ++request.current;
    stores.app.getState().clearAISettings();
    if (status !== 'connected') return;
    void connection.call('aiSettings.list').then(snapshot => {
      if (request.current !== generation) return;
      if (hostId && snapshot.hostId !== hostId) return;
      stores.app.getState().applyAISettings(snapshot);
    }).catch(() => {
      if (request.current !== generation) return;
      stores.app.getState().clearAISettings();
    });
    return () => { request.current += 1; };
  }, [connection, hostId, status, stores.app]);
}
