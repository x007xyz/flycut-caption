// F-0014 AC-2、AC-3：首次连接 / 地址校验 / 连接中 / 失败状态。
import { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, Loader2, RefreshCw, Server, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { validateHostUrl, SELF_HOSTING_DOC_URL, type ConnectionSnapshot } from '@/runtime/connectionModel';
import type { HostSessionService } from '@/runtime/connectionModel';
import { useConnectionText } from './useConnectionText';

export interface ConnectionPanelProps {
  snapshot: ConnectionSnapshot;
  session: HostSessionService;
}

export function ConnectionPanel({ snapshot, session }: ConnectionPanelProps) {
  const { tc } = useConnectionText();
  const [input, setInput] = useState(snapshot.target?.url ?? session.lastTargetUrl() ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (snapshot.target?.url) setInput(snapshot.target.url); }, [snapshot.target?.url]);

  const connecting = snapshot.phase === 'connecting' || snapshot.phase === 'validating';
  const checked = validateHostUrl(input);
  const showValidation = touched && input.trim() !== '' && !checked.ok;
  const canConnect = !!checked.ok && !connecting && !busy;
  const connect = () => {
    setTouched(true);
    if (!checked.ok || !checked.url) return;
    setBusy(true);
    void session.switchHost(checked.url).finally(() => setBusy(false));
  };
  const retry = () => {
    const target = snapshot.target?.url ?? session.lastTargetUrl();
    if (target) { setInput(target); setBusy(true); void session.switchHost(target).finally(() => setBusy(false)); }
    else void session.retry();
  };

  const error = snapshot.error;
  const title = snapshot.phase === 'unreachable' ? tc('unreachable')
    : snapshot.phase === 'auth-expired' ? tc('signInExpired')
      : snapshot.phase === 'access-denied' ? tc('accessDenied')
        : snapshot.phase === 'incompatible' ? tc('incompatible')
          : tc('title');
  const hint = snapshot.phase === 'unreachable' ? error?.message
    : snapshot.phase === 'auth-expired' ? tc('signInExpiredHint')
      : snapshot.phase === 'access-denied' ? tc('accessDeniedHint')
        : snapshot.phase === 'incompatible' ? tc('incompatibleHint')
          : tc('subtitle');

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground" data-testid="connection-panel">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-7 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {connecting ? <Loader2 className="h-5 w-5 animate-spin" /> : snapshot.phase === 'auth-expired' || snapshot.phase === 'access-denied' ? <ShieldAlert className="h-5 w-5" /> : <Server className="h-5 w-5" />}
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{connecting ? tc('connecting') : title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{connecting ? snapshot.target?.label ?? tc('connectingHint') : hint}</p>
          </div>
        </div>

        {connecting ? (
          <div className="mt-6 rounded-lg border border-border bg-muted/30 px-4 py-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{tc('connectingHint')}</div>
            <div className="mt-4 flex justify-end"><Button variant="outline" onClick={() => session.cancel()} data-testid="connection-cancel">{tc('cancel')}</Button></div>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <label htmlFor="connection-url" className="text-xs font-medium text-muted-foreground">{tc('hostAddress')}</label>
            <div className="flex gap-2">
              <Input id="connection-url" data-testid="connection-url-input" value={input} onChange={event => { setInput(event.target.value); setTouched(true); }}
                onKeyDown={event => { if (event.key === 'Enter') connect(); }} placeholder="https://flycut.example.com"
                aria-invalid={showValidation || undefined} autoComplete="off" spellCheck={false} />
              <Button onClick={connect} disabled={!canConnect} data-testid="connection-connect">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{tc('connect')}
              </Button>
            </div>
            {showValidation && <p role="alert" data-testid="connection-invalid" className="text-xs text-aimu-coral">
              {tc('invalidAddress')}
              {checked.error === 'insecure' && <span className="mt-1 block text-muted-foreground">{tc('invalidHint')}</span>}
            </p>}
            {!showValidation && snapshot.error?.code === 'invalid-address' && <p role="alert" className="text-xs text-aimu-coral">{tc('invalidAddress')}</p>}
            {snapshot.error && snapshot.phase !== 'config' && snapshot.error.code !== 'invalid-address' && (
              <p role="alert" className="rounded-md bg-aimu-red-bg px-3 py-2 text-xs text-aimu-coral">{snapshot.error.message}</p>
            )}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {(snapshot.phase === 'unreachable' || snapshot.phase === 'auth-expired' || snapshot.phase === 'access-denied' || snapshot.phase === 'incompatible') &&
                <Button variant="outline" size="sm" onClick={retry}><RefreshCw className="h-3.5 w-3.5" />{tc('retry')}</Button>}
              {session.cloudAvailable() && <Button variant="ghost" size="sm" onClick={() => void session.retry()}>{tc('connectCloud')}</Button>}
              <a href={SELF_HOSTING_DOC_URL} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {tc('selfHosting')}<ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        )}
        {!connecting && <p className="mt-5 border-t border-border pt-4 text-[11px] leading-5 text-muted-foreground">{tc('selfHostingWarning')}</p>}
      </div>
    </div>
  );
}
