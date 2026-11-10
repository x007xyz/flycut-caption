// F-0014 AC-4、AC-7：会话过期、无权限、已退出、协议不兼容时替换内容区。
import { LogIn, RefreshCw, ServerOff, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConnectionSnapshot, HostSessionService } from '@/runtime/connectionModel';
import { useConnectionText } from './useConnectionText';

export function SessionEndedPage({ snapshot, session, onSwitch }: { snapshot: ConnectionSnapshot; session: HostSessionService; onSwitch: () => void }) {
  const { tc } = useConnectionText();
  const expired = snapshot.phase === 'auth-expired';
  const denied = snapshot.phase === 'access-denied';
  const incompatible = snapshot.phase === 'incompatible';
  const signedOut = snapshot.phase === 'signed-out';
  const icon = expired || denied ? <ShieldAlert className="h-6 w-6" /> : incompatible ? <ServerOff className="h-6 w-6" /> : <LogIn className="h-6 w-6" />;
  const title = expired ? tc('signInExpired') : denied ? tc('accessDenied') : incompatible ? tc('incompatible') : tc('signedOut');
  const hint = expired ? tc('signInExpiredHint') : denied ? tc('accessDeniedHint') : incompatible ? tc('incompatibleHint') : tc('signedOutHint');
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-7 text-center shadow-sm" role="alert">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-aimu-red-bg text-aimu-coral">{icon}</div>
        <h1 className="mt-4 text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{hint}</p>
        {snapshot.error?.message && <p className="mt-2 break-words text-xs text-muted-foreground">{snapshot.error.message}</p>}
        {signedOut && snapshot.logoutError && (
          <div className="mt-3 rounded-md bg-aimu-red-bg px-3 py-2 text-left text-xs text-aimu-coral">
            {tc('logoutFailed')}: {snapshot.logoutError}
            <button type="button" className="ml-1 underline" onClick={() => void session.retryLogout()}>{tc('retry')}</button>
          </div>
        )}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {(expired || signedOut) && <Button onClick={() => void session.retry()}><LogIn className="h-4 w-4" />{tc('signInAgain')}</Button>}
          {incompatible && <Button onClick={() => void session.retry()}><RefreshCw className="h-4 w-4" />{tc('retry')}</Button>}
          {!signedOut && <Button variant="outline" onClick={onSwitch}>{tc('switchHost')}</Button>}
          {signedOut && <Button variant="outline" onClick={onSwitch}>{tc('connectHost')}</Button>}
        </div>
      </div>
    </div>
  );
}
