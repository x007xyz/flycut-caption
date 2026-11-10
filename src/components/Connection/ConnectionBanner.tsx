// F-0014 AC-5、AC-6：断线重连常驻提示；不遮挡编辑器，只放顶部。
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, WifiOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConnectionSnapshot, HostSessionService } from '@/runtime/connectionModel';
import { useConnectionText } from './useConnectionText';

export function ConnectionBanner({ snapshot, session }: { snapshot: ConnectionSnapshot; session: HostSessionService }) {
  const { tc } = useConnectionText();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!snapshot.nextRetryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [snapshot.nextRetryAt]);

  if (snapshot.phase === 'switching' || snapshot.phase === 'signing-out') {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 backdrop-blur-[1px]" role="alertdialog" aria-busy="true">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-5 py-4 text-sm text-foreground shadow-lg">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />{snapshot.phase === 'switching' ? tc('switching') : tc('signingOut')}
        </div>
      </div>
    );
  }
  if (snapshot.identityChanged) {
    return (
      <div className="fixed top-3 left-1/2 z-[90] flex w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-lg border border-amber-500/40 bg-card px-4 py-3 text-sm shadow-lg" role="status" data-testid="connection-identity-changed">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1"><p className="font-medium">{tc('identityChanged')}</p><p className="mt-0.5 text-xs text-muted-foreground">{tc('identityChangedHint')}</p></div>
        <button type="button" aria-label={tc('dismiss')} onClick={() => session.dismissIdentityChange()} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>
    );
  }
  if (snapshot.phase !== 'reconnecting' && snapshot.phase !== 'unreachable') return null;
  const unreachable = snapshot.phase === 'unreachable';
  const seconds = snapshot.nextRetryAt ? Math.max(0, Math.ceil((snapshot.nextRetryAt - now) / 1000)) : undefined;
  return (
    <div className="fixed top-3 left-1/2 z-[90] flex w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-card px-4 py-3 text-sm shadow-lg"
      role={unreachable ? 'alert' : 'status'} data-testid="connection-banner">
      {unreachable ? <WifiOff className="h-4 w-4 flex-shrink-0 text-aimu-coral" /> : <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-amber-500" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{unreachable ? tc('unreachable') : tc('disconnectedReconnecting')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {unreachable ? snapshot.error?.message ?? tc('offlineHint') : seconds !== undefined ? tc('retryIn', { seconds }) : tc('offline')}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void session.retry()} data-testid="connection-retry"><RefreshCw className="h-3.5 w-3.5" />{tc('retryNow')}</Button>
      <Button variant="ghost" size="sm" onClick={() => session.cancel()}>{tc('cancel')}</Button>
    </div>
  );
}
