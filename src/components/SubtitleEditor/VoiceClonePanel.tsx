import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, Mic, Play, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useClientRuntime } from '@/runtime/context';
import { useProjectStore } from '@/stores/projectStore';
import { useAppStore } from '@/stores/appStore';
import type { JobSnapshot } from '../../../shared/protocol';
import type { VoiceProfile } from '../../../shared/tts/voices';

type Phase = 'idle' | 'loading' | 'ready' | 'saving' | 'completed' | 'error';

export function VoiceClonePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connection } = useClientRuntime();
  const current = useProjectStore(state => state.current);
  const videoDuration = useAppStore(state => state.videoPlayerState.duration);
  const [phase, setPhase] = useState<Phase>('idle');
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [name, setName] = useState('我的音色');
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('5');
  const [confirmed, setConfirmed] = useState(false);
  const [statement, setStatement] = useState('这是我本人的声音，或我已获得说话人授权');
  const [error, setError] = useState<string | undefined>();
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();
  const duration = Math.max(0, Number(end) - Number(start));
  const controllerRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!current) return;
    setPhase('loading'); setError(undefined);
    try {
      setProfiles(await connection.call('voices.list', { projectId: current.projectId }) as VoiceProfile[]);
      setPhase('ready');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error'); }
  }, [connection, current]);

  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => { if (open && videoDuration > 0 && Number(end) > videoDuration) { setStart('0'); setEnd(String(Math.min(5, Math.floor(videoDuration)))); } }, [open, videoDuration, end]);

  const create = useCallback(async () => {
    if (!current) return;
    if (!confirmed) { setError('请先确认本人或说话人授权'); return; }
    if (!(duration >= 1 && duration <= 15)) { setError('样本必须在 1–15 秒之间'); return; }
    setPhase('saving'); setError(undefined); setProgress(0);
    try {
      const controller = new AbortController(); controllerRef.current = controller;
      const job = await connection.call('voices.create', { projectId: current.projectId, videoId: current.videoId,
        start: Number(start), end: Number(end), name, authorization: { confirmed: true, statement,
          confirmedAt: new Date().toISOString(), sourceLabel: '当前项目视频片段' } }) as JobSnapshot;
      jobIdRef.current = job.id;
      await connection.waitJob(job.id, snapshot => { if (snapshot.progress?.progress !== undefined) setProgress(snapshot.progress.progress); }, controller.signal);
      jobIdRef.current = null;
      await load(); setPhase('completed');
    } catch (caught) {
      if (controllerRef.current?.signal.aborted) { setPhase('ready'); return; }
      setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error');
    }
  }, [confirmed, connection, current, duration, end, load, name, start, statement]);

  const play = useCallback(async (profile: VoiceProfile) => {
    if (!current) return;
    try {
      const path = `/projects/${current.projectId}/videos/${profile.sourceVideoId}/voices/${profile.id}`;
      const blob = connection.downloadPath ? await connection.downloadPath(path) : await (await fetch(connection.resourceUrl(path), { credentials: 'include' })).blob();
      const url = URL.createObjectURL(blob); setPlaying(profile.id);
      const audio = new Audio(url); audio.onended = () => { URL.revokeObjectURL(url); setPlaying(undefined); }; await audio.play();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [connection, current]);

  const remove = useCallback(async (id: string) => {
    if (!current) return;
    try {
      const result = await connection.call('voices.delete', { projectId: current.projectId, id }) as { deleted: boolean; note: string };
      setConfirmDelete(undefined); await load();
      if (result.note) setError(result.note);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [connection, current, load]);

  if (!open) return null;
  return <section data-testid="voice-clone-panel" className="border-b border-aimu-border bg-aimu-panel p-2 text-xs">
    <div className="flex items-center gap-2">
      <strong className="flex items-center gap-1 text-aimu-text-primary"><Mic className="h-3.5 w-3.5" />声音克隆 / Voice clone</strong>
      <span className="text-aimu-text-muted">{profiles.length} 个音色</span>
      <span className="ml-auto" />
      <Button size="sm" variant="ghost" onClick={onClose}><X className="h-3.5 w-3.5" /></Button>
    </div>

    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
      <label className="flex flex-col gap-1"><span className="text-[11px] text-aimu-text-muted">名称</span>
        <input data-testid="voice-name" value={name} onChange={event => setName(event.target.value)} className="h-7 rounded border border-aimu-border bg-aimu-input px-2" /></label>
      <label className="flex flex-col gap-1"><span className="text-[11px] text-aimu-text-muted">开始(s)</span>
        <input data-testid="voice-start" type="number" min={0} step={0.1} value={start} onChange={event => setStart(event.target.value)} className="h-7 rounded border border-aimu-border bg-aimu-input px-2" /></label>
      <label className="flex flex-col gap-1"><span className="text-[11px] text-aimu-text-muted">结束(s)</span>
        <input data-testid="voice-end" type="number" min={0} step={0.1} value={end} onChange={event => setEnd(event.target.value)} className="h-7 rounded border border-aimu-border bg-aimu-input px-2" /></label>
      <div className="flex flex-col gap-1"><span className="text-[11px] text-aimu-text-muted">时长</span><span className="flex h-7 items-center">{duration.toFixed(1)}s / 1–15s</span></div>
    </div>

    <label className="mt-2 flex items-start gap-1.5 text-[11px]">
      <input data-testid="voice-authorization" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5" />
      <span>这是我本人的声音，或我已获得说话人授权 / This is my voice, or I have the speaker’s permission</span>
    </label>
    <input data-testid="voice-statement" value={statement} onChange={event => setStatement(event.target.value)}
      className="mt-1 w-full rounded border border-aimu-border bg-aimu-input px-2 py-1 text-[11px]" />
    <p className="mt-1 text-[10px] text-aimu-text-muted">样本会先转换为 16k 单声道 WAV，上传到 302.ai IndexTTS；302.ai 不提供远端删除接口。</p>

    <div className="mt-2 flex flex-wrap gap-1.5">
      <Button size="sm" variant="outline" data-testid="voice-preview-source" onClick={async () => {
        if (!current) return;
        try {
          const path = `/projects/${current.projectId}/media/${current.videoId}`;
          const blob = connection.downloadPath ? await connection.downloadPath(path) : await (await fetch(connection.resourceUrl(path), { credentials: 'include' })).blob();
          const audio = new Audio(URL.createObjectURL(blob)); audio.currentTime = Number(start);
          audio.ontimeupdate = () => { if (audio.currentTime >= Number(end)) { audio.pause(); URL.revokeObjectURL(audio.src); } };
          await audio.play();
        } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
      }}>试听原片段</Button>
      <Button size="sm" data-testid="voice-create" disabled={phase === 'saving' || !current || !confirmed} onClick={() => void create()}>
        {phase === 'saving' ? '正在处理…' : '创建音色 / Create'}
      </Button>
      {phase === 'saving' && <><span role="status" className="flex items-center gap-1 text-aimu-text-muted"><Loader2 className="h-3 w-3 animate-spin" />{progress}%</span>
        <Button size="sm" variant="outline" data-testid="voice-cancel" onClick={() => { controllerRef.current?.abort(); if (jobIdRef.current) void connection.call('jobs.cancel', { id: jobIdRef.current }); }}>取消 / Cancel</Button></>}
      {phase === 'completed' && <span role="status" data-testid="voice-completed" className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><Check className="h-3 w-3" />已完成 / Completed</span>}
    </div>

    {error && <p role="alert" data-testid="voice-error" className="mt-1 text-aimu-coral">{error}</p>}
    {phase === 'loading' && <p role="status" className="mt-1 flex items-center gap-1 text-aimu-text-muted"><Loader2 className="h-3 w-3 animate-spin" />正在加载…</p>}
    {phase !== 'loading' && profiles.length === 0 && <p data-testid="voice-empty" className="mt-2 text-aimu-text-muted">暂无内容 / Nothing here yet</p>}
    {profiles.length > 0 && <div data-testid="voice-list" className="mt-2 space-y-1">
      {profiles.map(profile => <div key={profile.id} data-testid="voice-item" className="flex items-center gap-1.5 rounded border border-aimu-border bg-background p-1.5">
        <span className="min-w-0 flex-1 truncate">{profile.name}</span>
        <span className="text-[10px] text-aimu-text-muted">{profile.durationSeconds.toFixed(1)}s</span>
        <Button size="sm" variant="ghost" data-testid={`voice-play-${profile.id}`} onClick={() => void play(profile)}><Play className="h-3 w-3" />{playing === profile.id ? '播放中' : '试听'}</Button>
        {confirmDelete === profile.id ? <>
          <span className="text-[10px] text-aimu-text-muted">确认删除？</span>
          <Button size="sm" variant="destructive" data-testid="voice-confirm-delete" onClick={() => void remove(profile.id)}>删除</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(undefined)}>保留</Button>
        </> : <Button size="sm" variant="ghost" data-testid={`voice-delete-${profile.id}`} onClick={() => setConfirmDelete(profile.id)}><Trash2 className="h-3 w-3" /></Button>}
      </div>)}
    </div>}
    {profiles.length > 0 && <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300"><AlertTriangle className="mr-1 inline h-3 w-3" />删除只清理本地样本；302.ai 远端留存按服务条款处理。</p>}
  </section>;
}
