import { useCallback, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useAppStore } from '@/stores/appStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import { buildVideoExportSegments } from '@/utils/videoExportSegments';
import { buildExportSubtitleScene } from '@/subtitle/graphicsScene';
import { loadMediaBlob } from '@/utils/mediaSource';
import { pickVideoExportSaveTarget, writeProcessedVideo } from '@/utils/exportSavePath';
import type { JobSnapshot } from '../../shared/protocol';

export interface ClipExportController {
  phase: 'idle' | 'running' | 'completed' | 'error';
  progress: number;
  error?: string;
  exportClip: (clip: { id: string; start: number; end: number }) => Promise<void>;
  cancel: () => void;
  batch?: { requestId: string; status: string; items: Array<{ name: string; status: string; error?: string }> };
  batchExport: (clips: Array<{ id: string; name: string; start: number; end: number }>) => Promise<void>;
  batchCancel: () => Promise<void>;
  hasReframe: boolean;
  followSubject: boolean;
  setFollowSubject: (value: boolean) => void;
}

export function useClipExport(): ClipExportController {
  const { connection } = useClientRuntime();
  const videoFile = useAppStore(s => s.videoFile);
  const stylePair = useAppStore(s => s.subtitleStylePair);
  const displayMode = useAppStore(s => s.display);
  const chunks = useHistoryStore(s => s.chunks);
  const wordChunks = useHistoryStore(s => s.wordChunks);
  const hasWordTimestamps = useHistoryStore(s => s.hasWordTimestamps);
  const edl = useHistoryStore(s => s.edl);
  const current = useProjectStore(s => s.current);
  const [phase, setPhase] = useState<ClipExportController['phase']>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const [batch, setBatch] = useState<ClipExportController['batch']>();
  const [followSubject, setFollowSubject] = useState(true);
  const batchRef = useRef<string | undefined>(undefined);
  const duration = useMemo(() => edl ? edl.sourceDurationUs / 1_000_000 : 0, [edl]);

  const exportClip = useCallback(async (clip: { id: string; start: number; end: number }) => {
    if (!videoFile || !edl || !current) { setError('缺少视频或编辑数据'); setPhase('error'); return; }
    const controller = new AbortController(); abortRef.current = controller;
    setPhase('running'); setProgress(0); setError(undefined);
    try {
      const baseSegments = buildVideoExportSegments({ chunks, wordChunks, hasWordTimestamps, duration, edl });
      const segments = baseSegments.flatMap(segment => {
        if (!segment.keep) return [];
        const start = Math.max(segment.start, clip.start); const end = Math.min(segment.end, clip.end);
        return end > start ? [{ ...segment, start, end }] : [];
      });
      if (!segments.length) throw new Error('片段内没有可保留的内容');
      const outputSeconds = segments.reduce((total, segment) => total + segment.end - segment.start, 0);
      const cropSamples = (() => {
        const samples: Array<{ time: number; centerX: number }> = [];
        let offset = 0;
        for (const segment of segments) {
          for (const sample of current.reframe?.samples ?? []) {
            if (sample.time >= segment.start && sample.time <= segment.end) samples.push({ time: offset + sample.time - segment.start, centerX: sample.centerX });
          }
          offset += segment.end - segment.start;
        }
        return followSubject ? samples.slice(0, 2000) : [];
      })();
      const scene = buildExportSubtitleScene({ chunks, wordChunks, hasWordTimestamps, keptSegments: segments,
        stylePair, displayMode, videoWidth: 1080, videoHeight: 1920, fps: 30, duration: outputSeconds });
      const assetId = await connection.upload(await loadMediaBlob(videoFile));
      const target = await pickVideoExportSaveTarget('mp4', `${current.videoName || 'clip'}-vertical.mp4`);
      if (!target) { setPhase('idle'); return; }
      const job = await connection.call('export.start', { operationId: crypto.randomUUID(), assetId, segments,
        options: { format: 'mp4', quality: 'high', preserveAudio: true, subtitleProcessing: 'hard',
          subtitleTransport: 'skia-band', subtitleScene: scene, crop: '9:16', cropSamples } }) as JobSnapshot;
      const result = await connection.waitJob<{ assetId: string; mimeType: string }>(job.id, snapshot => {
        if (snapshot.progress?.progress !== undefined) setProgress(snapshot.progress.progress);
      }, controller.signal);
      const blob = await connection.download(result.assetId);
      await writeProcessedVideo(blob, target);
      void connection.call('assets.delete', { assetId: result.assetId }).catch(() => undefined);
      void connection.call('assets.delete', { assetId }).catch(() => undefined);
      setProgress(100); setPhase('completed');
    } catch (caught) {
      if (controller.signal.aborted) { setPhase('idle'); return; }
      setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error');
    }
  }, [chunks, connection, current, displayMode, duration, edl, followSubject, hasWordTimestamps, stylePair, videoFile, wordChunks]);

  const buildRequest = useCallback((clip: { id: string; name: string; start: number; end: number }) => {
    if (!edl) return undefined;
    const baseSegments = buildVideoExportSegments({ chunks, wordChunks, hasWordTimestamps, duration, edl });
    const segments = baseSegments.flatMap(segment => {
      if (!segment.keep) return [];
      const start = Math.max(segment.start, clip.start); const end = Math.min(segment.end, clip.end);
      return end > start ? [{ ...segment, start, end }] : [];
    });
    if (!segments.length) return undefined;
    const outputSeconds = segments.reduce((total, segment) => total + segment.end - segment.start, 0);
    const scene = buildExportSubtitleScene({ chunks, wordChunks, hasWordTimestamps, keptSegments: segments,
      stylePair, displayMode, videoWidth: 1080, videoHeight: 1920, fps: 30, duration: outputSeconds });
    return { clipId: clip.id, name: clip.name, segments, subtitleProcessing: 'hard' as const, scene };
  }, [chunks, displayMode, duration, edl, hasWordTimestamps, stylePair, wordChunks]);

  const batchExport = useCallback(async (clips: Array<{ id: string; name: string; start: number; end: number }>) => {
    if (!current) return;
    const items = clips.map(buildRequest).filter((item): item is NonNullable<typeof item> => !!item);
    if (!items.length) { setError('没有可导出的短片'); setPhase('error'); return; }
    try {
      const requestId = crypto.randomUUID(); batchRef.current = requestId;
      interface BatchView { status: string; items: Array<{ name: string; status: string; error?: string }> }
      const started = await connection.call('clips.batchStart', { projectId: current.projectId, videoId: current.videoId, requestId, items }) as BatchView;
      setBatch({ requestId, status: started.status, items: started.items });
      for (let i = 0; i < 1800; i += 1) {
        await new Promise(done => setTimeout(done, 1000));
        const snapshot = await connection.call('clips.batchStatus', { projectId: current.projectId, requestId }) as BatchView | null;
        if (!snapshot) continue;
        setBatch({ requestId, status: snapshot.status, items: snapshot.items });
        if (['completed', 'partial', 'cancelled', 'failed'].includes(snapshot.status)) { setPhase(snapshot.status === 'completed' ? 'completed' : 'error'); break; }
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error'); }
  }, [buildRequest, connection, current]);

  const batchCancel = useCallback(async () => {
    if (!current || !batchRef.current) return;
    await connection.call('clips.batchCancel', { projectId: current.projectId, requestId: batchRef.current }).catch(() => undefined);
    setBatch(previous => previous ? { ...previous, status: 'cancelled' } : previous);
  }, [connection, current]);

  return { phase, progress, error, exportClip, batch, batchExport, batchCancel, hasReframe: !!current?.reframe, followSubject, setFollowSubject, cancel: () => { abortRef.current?.abort(); setPhase('idle'); } };
}
