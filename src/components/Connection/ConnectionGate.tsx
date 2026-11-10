// F-0014：连接门。负责发现目标、首次连接、重连/切换/登出展示；ClientRuntime 只接收已建立的连接。
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import { RuntimeContext } from '@/runtime/context';
import { createClientRuntime, type UISlots } from '@/runtime/client';
import { HostSessionController } from '@/runtime/HostSessionController';
import { createCurrentBackendCloudAdapter } from '@/runtime/cloudAdapter';
import { ConnectionPanel } from './ConnectionPanel';
import { ConnectionBanner } from './ConnectionBanner';
import { SessionEndedPage } from './SessionEndedPage';

interface ProjectHooks {
  prepareHostChange?: () => Promise<boolean>;
  clearForSessionEnd?: () => void;
  resetForIdentityChange?: () => void;
  resumeAfterReconnect?: () => void | Promise<void>;
}

function projectsOf(ctx: Context): ProjectHooks | undefined {
  return (ctx as unknown as { projects?: ProjectHooks }).projects;
}

function RuntimeMount({ connection, controller, shell, plugins, children, runtimeKey }: {
  connection: NonNullable<ReturnType<HostSessionController['currentConnection']>>;
  controller: HostSessionController;
  shell: UISlots['shell'];
  plugins?: object[];
  children: ReactNode;
  runtimeKey: string;
}) {
  const [state, setState] = useState<{ ctx?: Context; error?: string }>({});
  useEffect(() => {
    let disposed = false;
    let owned: Context | undefined;
    let hooks: Parameters<HostSessionController['attachRuntime']>[0] | undefined;
    setState({});
    void createClientRuntime({ connection, session: controller }, shell, plugins).then(ctx => {
      if (disposed) { void ctx.fiber.dispose(); return; }
      owned = ctx;
      const projects = projectsOf(ctx);
      hooks = {
        beforeSwitch: async () => projects?.prepareHostChange ? projects.prepareHostChange() : true,
        beforeLogout: async () => projects?.prepareHostChange ? projects.prepareHostChange() : true,
        onSessionEnded: () => projects?.clearForSessionEnd?.(),
        onIdentityChanged: () => projects?.resetForIdentityChange?.(),
        onReconnected: () => { void projects?.resumeAfterReconnect?.(); },
      };
      controller.attachRuntime(hooks);
      setState({ ctx });
    }, error => { if (!disposed) setState({ error: error instanceof Error ? error.message : String(error) }); });
    return () => {
      disposed = true;
      controller.detachRuntime(hooks);
      if (owned) void owned.fiber.dispose();
    };
    // runtimeKey is the identity of this mount; connection and controller are stable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeKey]);
  if (state.error) return <div role="alert" className="p-8 text-sm text-aimu-coral">{state.error}</div>;
  if (!state.ctx) return <div role="status" className="flex min-h-screen items-center justify-center gap-2 bg-background p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在准备编辑运行时…</div>;
  return <RuntimeContext.Provider value={state.ctx}>{children}</RuntimeContext.Provider>;
}

export function ConnectionGate({ shell, plugins, children }: { shell: UISlots['shell']; plugins?: object[]; children: ReactNode }) {
  const [controller] = useState(() => new HostSessionController({ cloudAdapter: createCurrentBackendCloudAdapter() }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [showConfig, setShowConfig] = useState(false);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  useEffect(() => {
    if (snapshot.phase === 'connecting' || snapshot.phase === 'switching') setShowConfig(false);
  }, [snapshot.phase]);

  if (snapshot.phase === 'boot') {
    return <div role="status" className="flex min-h-screen items-center justify-center gap-2 bg-background p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在发现 FlyCut Host…</div>;
  }
  const connection = controller.currentConnection();
  const sessionEnded = snapshot.phase === 'auth-expired' || snapshot.phase === 'access-denied' || snapshot.phase === 'signed-out' || snapshot.phase === 'incompatible';
  if (showConfig) {
    return <ConnectionPanel snapshot={snapshot} session={controller} />;
  }
  if (sessionEnded) return <SessionEndedPage snapshot={snapshot} session={controller} onSwitch={() => setShowConfig(true)} />;
  if (!connection || !snapshot.runtimeKey || snapshot.phase === 'config' || snapshot.phase === 'validating' || snapshot.phase === 'unreachable' && !connection) {
    return <ConnectionPanel snapshot={snapshot} session={controller} />;
  }
  return (
    <>
      <ConnectionBanner snapshot={snapshot} session={controller} />
      <RuntimeMount key={snapshot.runtimeKey} runtimeKey={snapshot.runtimeKey} connection={connection} controller={controller} shell={shell} plugins={plugins}>{children}</RuntimeMount>
    </>
  );
}
