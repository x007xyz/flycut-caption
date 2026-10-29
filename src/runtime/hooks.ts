import { useEffect, useState } from 'react';
import type { RpcMethod, RpcOutput, RpcInput } from '../../shared/protocol';
import { useClientRuntime } from './context';

type QueryMethod = { [M in RpcMethod]: RpcInput<M> extends void ? M : never }[RpcMethod];

/** Reads a payload-free Host query once per mount; Host registries are the single source of truth. */
export function useHostQuery<M extends QueryMethod>(method: M): { data?: RpcOutput<M>; error?: string } {
  const { connection } = useClientRuntime();
  const [state, setState] = useState<{ data?: RpcOutput<M>; error?: string }>({});
  useEffect(() => {
    let active = true;
    const query = connection.call as (name: M) => Promise<RpcOutput<M>>;
    query.call(connection, method).then(data => { if (active) setState({ data }); },
      error => { if (active) setState({ error: error instanceof Error ? error.message : String(error) }); });
    return () => { active = false; };
  }, [connection, method]);
  return state;
}
