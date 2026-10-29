import { createContext, useContext } from 'react';
import type { Context } from '@deepseek-ai/cordis';
export const RuntimeContext = createContext<Context | null>(null);
export function useClientRuntime() {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('Missing FlyCut Cordis runtime');
  return ctx;
}
