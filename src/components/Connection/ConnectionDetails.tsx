// F-0014：设置里的「连接」分区和顶栏状态弹窗共用的只读信息 + 操作。
import { useState } from 'react';
import { ExternalLink, LogOut, RefreshCw, Server, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnectionState, useHostSession } from '@/runtime/connectionHooks';
import { useConnectionText } from './useConnectionText';
import { HostSwitcherDialog } from './HostSwitcherDialog';

export function ConnectionDetails() {
  const { tc, language } = useConnectionText();
  const snapshot = useConnectionState();
  const session = useHostSession();
  const [switcher, setSwitcher] = useState(false);
  const target = snapshot.target;
  const identity = snapshot.identity;
  const capabilities = Object.entries(snapshot.capabilities ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
  const expiry = snapshot.sessionExpiresAt ? new Date(snapshot.sessionExpiresAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }) : undefined;
  const canSwitch = target?.source !== 'desktop';
  const canLogout = target?.source !== 'desktop';
  return (
    <div className="space-y-4" data-testid="connection-details">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Server className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{target?.label ?? tc('unknown')}</p>
          <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{target?.url ?? tc('unknown')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{tc('source')}: {target?.source ?? tc('unknown')}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">{tc('hostId')}</dt><dd className="break-all font-mono">{identity?.hostId ?? tc('unknown')}</dd>
        <dt className="text-muted-foreground">{tc('protocol')}</dt><dd className="font-mono">{identity?.protocolVersion ?? '—'}</dd>
        <dt className="text-muted-foreground">{tc('capabilities')}</dt><dd className="break-words">{capabilities.length ? capabilities.join('、') : tc('none')}</dd>
        <dt className="text-muted-foreground">{tc('session')}</dt><dd>{expiry ?? tc('sessionLocal')}</dd>
      </dl>
      <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
        <span>{tc('tenantWarning')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {canSwitch && <Button variant="outline" size="sm" onClick={() => setSwitcher(true)} data-testid="open-host-switcher">{tc('switchHost')}</Button>}
        <Button variant="ghost" size="sm" onClick={() => void session.retry()}><RefreshCw className="h-3.5 w-3.5" />{tc('retryNow')}</Button>
        {canLogout && <Button variant="ghost" size="sm" className="text-aimu-coral" onClick={() => void session.logout()} data-testid="logout-host"><LogOut className="h-3.5 w-3.5" />{tc('logout')}</Button>}
        <a href={session.selfHostingUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          {tc('selfHosting')}<ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <HostSwitcherDialog open={switcher} onOpenChange={setSwitcher} />
    </div>
  );
}
