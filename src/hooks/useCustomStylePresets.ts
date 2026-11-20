import { useCallback, useEffect, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useProjectStore } from '@/stores/projectStore';
import { ConnectionUnavailableError } from '@/runtime/connection';
import {
  customStylePresetSchema, presetNameKey, validatePresetName,
  type CustomStylePreset, type StylePresetsSnapshot,
} from '../../shared/stylePresets';
import { applyCustomStylePreset } from '@/subtitle/customPresets';
import type { SubtitleStylePair } from '@/subtitle';

export type CustomPresetPhase = 'idle' | 'loading' | 'ready' | 'saving' | 'stale' | 'error';
export type CustomPresetNotice = 'saved' | 'deleted' | 'applied' | 'font-missing';

export interface CustomPresetState {
  available: boolean;
  phase: CustomPresetPhase;
  presets: CustomStylePreset[];
  revision: number;
  notice?: CustomPresetNotice;
  error?: string;
  create: (name: string) => Promise<{ ok: boolean; error?: string; duplicateId?: string }>;
  overwrite: (id: string, name: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  apply: (id: string) => void;
  reload: () => Promise<void>;
  retry: () => Promise<boolean>;
  dismissNotice: () => void;
}

const isNetworkError = (error: unknown) => error instanceof ConnectionUnavailableError || error instanceof TypeError;

export function useCustomStylePresets(stylePair: SubtitleStylePair, onStylePairChange: (pair: SubtitleStylePair) => void): CustomPresetState {
  const ctx = useClientRuntime();
  const projectId = useProjectStore(state => state.current?.projectId);
  const [phase, setPhase] = useState<CustomPresetPhase>('idle');
  const [presets, setPresets] = useState<CustomStylePreset[]>([]);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<CustomPresetNotice | undefined>();
  const [error, setError] = useState<string | undefined>();
  const seq = useRef(0);
  const operationId = useRef<string | null>(null);
  const uncertain = useRef(false);
  const lastAttempt = useRef<Array<Pick<CustomStylePreset, 'id' | 'name' | 'primary' | 'secondary'>> | null>(null);
  const styleRef = useRef(stylePair);
  styleRef.current = stylePair;

  const load = useCallback(async () => {
    if (!projectId) { setPhase('idle'); setPresets([]); setRevision(0); return; }
    const run = ++seq.current;
    setPhase('loading'); setError(undefined); setNotice(undefined);
    try {
      const snapshot = await ctx.connection.call('projects.getStylePresets', { projectId }) as StylePresetsSnapshot;
      if (run !== seq.current) return;
      setPresets(snapshot.presets);
      setRevision(snapshot.revision);
      setPhase('ready');
    } catch (caught) {
      if (run !== seq.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('error');
    }
  }, [ctx, projectId]);

  useEffect(() => { void load(); }, [load]);

  const persist = useCallback(async (next: Array<Pick<CustomStylePreset, 'id' | 'name' | 'primary' | 'secondary'>>): Promise<boolean> => {
    if (!projectId || phase === 'saving') return false;
    const run = seq.current;
    const opId = operationId.current ?? crypto.randomUUID();
    operationId.current = opId;
    lastAttempt.current = next;
    setPhase('saving'); setError(undefined); setNotice(undefined);
    try {
      let baseRevision = revision;
      if (uncertain.current) {
        const snapshot = await ctx.connection.call('projects.getStylePresets', { projectId }) as StylePresetsSnapshot;
        if (run !== seq.current) return false;
        if (snapshot.revision !== revision) {
          setPresets(snapshot.presets); setRevision(snapshot.revision); setPhase('stale'); uncertain.current = false;
          return false;
        }
        baseRevision = snapshot.revision;
      }
      const result = await ctx.connection.call('projects.saveStylePresets', {
        projectId, baseRevision, operationId: opId,
        presets: next.map(preset => ({ ...(preset.id ? { id: preset.id } : {}), name: preset.name, primary: preset.primary, secondary: preset.secondary })),
      }) as { status: 'saved'; revision: number; presets: unknown[] } | { status: 'conflict'; revision: number; presets: unknown[] };
      if (run !== seq.current) return false;
      operationId.current = null;
      if (result.status === 'conflict') {
        setPresets(result.presets.map(item => customStylePresetSchema.parse(item)));
        setRevision(result.revision); setPhase('stale');
        return false;
      }
      setPresets(result.presets.map(item => customStylePresetSchema.parse(item)));
      setRevision(result.revision); setPhase('ready'); uncertain.current = false;
      return true;
    } catch (caught) {
      if (run !== seq.current) return false;
      uncertain.current = isNetworkError(caught);
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('error');
      return false;
    }
  }, [ctx, phase, projectId, revision]);

  const create = useCallback(async (rawName: string) => {
    const validation = validatePresetName(rawName, presets);
    if (validation.ok === false) {
      const duplicate = validation.code === 'duplicate' ? presets.find(preset => presetNameKey(preset.name) === presetNameKey(rawName)) : undefined;
      return { ok: false, error: validation.message, ...(duplicate ? { duplicateId: duplicate.id } : {}) };
    }
    const saved = await persist([...presets, { id: crypto.randomUUID(), name: validation.name,
      primary: { ...styleRef.current.primary }, secondary: { ...styleRef.current.secondary } }]);
    if (saved) setNotice('saved');
    return { ok: saved };
  }, [persist, presets]);

  const overwrite = useCallback(async (id: string, rawName: string) => {
    const validation = validatePresetName(rawName, presets, id);
    if (validation.ok === false) { setError(validation.message); return false; }
    const saved = await persist(presets.map(preset => preset.id === id
      ? { ...preset, name: validation.name, primary: { ...styleRef.current.primary }, secondary: { ...styleRef.current.secondary } }
      : preset));
    if (saved) setNotice('saved');
    return saved;
  }, [persist, presets]);

  const remove = useCallback(async (id: string) => {
    const saved = await persist(presets.filter(preset => preset.id !== id));
    if (saved) setNotice('deleted');
    return saved;
  }, [persist, presets]);

  const apply = useCallback((id: string) => {
    const preset = presets.find(item => item.id === id);
    if (!preset) return;
    const { pair, missingFont } = applyCustomStylePreset(styleRef.current, preset);
    onStylePairChange(pair);
    setNotice(missingFont ? 'font-missing' : 'applied');
  }, [onStylePairChange, presets]);

  return { available: !!projectId, phase, presets, revision, notice, error,
    create, overwrite, remove, apply, reload: load, retry: () => lastAttempt.current ? persist(lastAttempt.current) : Promise.resolve(false),
    dismissNotice: () => setNotice(undefined) };
}
