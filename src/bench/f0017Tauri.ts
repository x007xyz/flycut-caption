// Development-only driver for `pnpm bench:f0017:tauri`. It runs inside the real Tauri
// WebView, opens the seeded project five times, and reports browser-side timings back to
// the isolated benchmark collector started by `scripts/bench-f0017-tauri.ts`.

type TauriBenchState =
  | { phase: 'waiting' }
  | { phase: 'ready'; projectName: string; firstText: string }
  | { phase: 'error'; error?: string };

interface TauriOpenSample {
  elapsedMs: number;
  maxLongTaskMs: number;
  renderedRows: number;
  textareas: number;
}

interface LongTask { startTime: number; duration: number }

interface BenchWindow extends Window {
  __f0017TauriStarted?: boolean;
  __f0017LongTasks?: LongTask[];
  __f0017MeasureStart?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs: number, message: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(message);
}

function visibleButtonContaining(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.offsetParent !== null && (button.textContent ?? '').includes(text));
}

function visibleSubtitleInput(): HTMLTextAreaElement | undefined {
  return [...document.querySelectorAll<HTMLTextAreaElement>('[data-testid="subtitle-main-text"]')]
    .find(input => input.offsetParent !== null);
}

async function fetchState(base: string): Promise<TauriBenchState> {
  const response = await fetch(`${base}/state`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`benchmark state returned ${response.status}`);
  return await response.json() as TauriBenchState;
}

async function waitForState(base: string): Promise<Extract<TauriBenchState, { phase: 'ready' }>> {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const state = await fetchState(base).catch(() => ({ phase: 'waiting' } as const));
    if (state.phase === 'ready') return state as Extract<TauriBenchState, { phase: 'ready' }>;
    if (state.phase === 'error') throw new Error(state.error ?? 'benchmark seed failed');
    await sleep(200);
  }
  throw new Error('the benchmark seed did not become ready within 120 seconds');
}

function resetMeasurement(): void {
  const target = window as BenchWindow;
  target.__f0017LongTasks = [];
  target.__f0017MeasureStart = performance.now();
}

function inputAndRestore(input: HTMLTextAreaElement): void {
  const original = input.value;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('textarea value setter is unavailable');
  input.focus();
  setter.call(input, `${original}测`);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (input.value !== `${original}测`) throw new Error('the first subtitle did not accept immediate input');
  setter.call(input, original);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.blur();
}

async function runOnce(state: Extract<TauriBenchState, { phase: 'ready' }>): Promise<TauriOpenSample> {
  location.hash = '#/projects';
  const card = await waitFor(() => visibleButtonContaining(state.projectName!), 20_000,
    `project card "${state.projectName}" was not rendered`);
  await sleep(100);
  resetMeasurement();
  card.click();
  let input: HTMLTextAreaElement;
  try {
    input = await waitFor(() => {
      const candidate = visibleSubtitleInput();
      return candidate && candidate.value.includes(state.firstText!) ? candidate : undefined;
    }, 20_000, 'the first subtitle did not become editable');
  } catch (error) {
    const detail = {
      hash: location.hash,
      textareaCount: document.querySelectorAll('textarea').length,
      firstValues: [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].slice(0, 3).map(input => input.value),
      body: document.body.innerText.slice(0, 800),
    };
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(detail)}`);
  }
  const elapsedMs = performance.now() - (window as BenchWindow).__f0017MeasureStart!;
  inputAndRestore(input);
  const editableAt = (window as BenchWindow).__f0017MeasureStart! + elapsedMs;
  const renderedRows = document.querySelectorAll('[data-chunk-id]').length;
  const textareas = document.querySelectorAll('textarea').length;
  await sleep(1_000);
  const maxLongTaskMs = Math.max(0, ...((window as BenchWindow).__f0017LongTasks ?? [])
    .filter(entry => entry.startTime + entry.duration >= editableAt).map(entry => entry.duration));
  return { elapsedMs: Math.round(elapsedMs), maxLongTaskMs: Math.round(maxLongTaskMs), renderedRows, textareas };
}

/** Called from main.tsx only in Vite development when the collector query is present. */
export async function startF0017TauriBenchmark(collectorPort: string): Promise<void> {
  const target = window as BenchWindow;
  if (target.__f0017TauriStarted) return;
  target.__f0017TauriStarted = true;
  const base = `http://127.0.0.1:${collectorPort}`;
  try {
    const state = await waitForState(base);
    await waitFor(() => visibleButtonContaining(state.projectName!), 30_000,
      'the seeded project did not appear on the home page');
    const runs: TauriOpenSample[] = [];
    for (let index = 0; index < 5; index += 1) runs.push(await runOnce(state));
    await fetch(`${base}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, runs, environment: {
        userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        devicePixelRatio: window.devicePixelRatio, theme: new URLSearchParams(location.search).get('f0017Theme') ?? 'light',
      } }),
    });
  } catch (error) {
    await fetch(`${base}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    }).catch(() => undefined);
  }
}
