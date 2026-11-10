// F-0014：顶栏连接状态。显示当前目标/阶段，点开看身份、能力、会话并切换/登出。
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PlugZap, WifiOff } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConnectionState } from '@/runtime/connectionHooks';
import { useConnectionText } from './useConnectionText';
import { ConnectionDetails } from './ConnectionDetails';

export function ConnectionStatus() {
  const { tc } = useConnectionText();
  const snapshot = useConnectionState();
  const [open, setOpen] = useState(false);
  const phase = snapshot.phase;
  const label = phase === 'connected' ? tc('connected')
    : phase === 'reconnecting' ? tc('reconnecting')
      : phase === 'unreachable' ? tc('unreachableShort')
        : phase === 'auth-expired' ? tc('signInExpiredShort')
          : phase === 'access-denied' ? tc('accessDeniedShort')
            : phase === 'switching' ? tc('switching')
              : phase === 'signing-out' || phase === 'signed-out' ? tc('signingOut')
                : phase === 'incompatible' ? tc('incompatibleShort') : tc('connecting');
  const tone = phase === 'connected' ? 'text-emerald-600 dark:text-emerald-400'
    : phase === 'reconnecting' || phase === 'switching' || phase === 'connecting' ? 'text-amber-600 dark:text-amber-400'
      : 'text-aimu-coral';
  const icon = phase === 'connected' ? <CheckCircle2 className="h-3.5 w-3.5" />
    : phase === 'reconnecting' || phase === 'switching' || phase === 'connecting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
      : phase === 'unreachable' ? <WifiOff className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="connection-status"
        className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:bg-aimu-hover hover:text-foreground"
        title={tc('connectionDetails')}>
        <span className={tone}>{icon}</span>
        <span className="truncate">{label}</span>
        {snapshot.target && <span className="hidden max-w-[90px] truncate text-muted-foreground/70 lg:inline">· {snapshot.target.label}</span>}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" data-testid="connection-status-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><PlugZap className="h-4 w-4 text-primary" />{tc('connectionDetails')}</DialogTitle>
          </DialogHeader>
          <DialogBody><ConnectionDetails /></DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
