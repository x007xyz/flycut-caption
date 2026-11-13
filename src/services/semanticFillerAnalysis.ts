// F-0009: bounded semantic batches. Each batch is one cancellable Host job; completed batches
// remain available when a later batch fails or the user cancels.
import type { RemoteConnection } from '@/runtime/connection';
import type { JobSnapshot } from '../../shared/protocol';
import {
  SemanticContractError, validateSemanticModelResponse,
  type SemanticAnalysisResult, type SemanticSuggestionCandidate, type SemanticWindow,
} from '../../shared/editing/semanticFillers.ts';

export type SemanticBatchStatus = 'pending' | 'running' | 'success' | 'failed' | 'invalid' | 'cancelled';

export interface SemanticBatchState {
  id: string;
  index: number;
  window: SemanticWindow;
  status: SemanticBatchStatus;
  candidates: SemanticSuggestionCandidate[];
  error?: string;
}

export interface SemanticQueueProgress {
  completed: number;
  total: number;
  currentBatch?: number;
}

export class SemanticAnalysisRequestError extends Error {
  readonly kind: 'invalid' | 'failed';

  constructor(kind: 'invalid' | 'failed', message: string) {
    super(message);
    this.name = 'SemanticAnalysisRequestError';
    this.kind = kind;
  }
}

export function classifySemanticError(error: unknown): 'invalid' | 'failed' {
  if (error instanceof SemanticAnalysisRequestError) return error.kind;
  if (error instanceof SemanticContractError) return 'invalid';
  const message = error instanceof Error ? error.message : String(error);
  return /invalid analysis result|INVALID_|UNKNOWN_|STALE_BASE|NON_CONTIGUOUS|HALF_SENTENCE|PARTIAL_SENTENCE|OVERLAP|DUPLICATE_RANGE|OUT_OF_RANGE|REVERSED_RANGE|SCOPE_REQUIRED|INVALID_CATEGORY|INVALID_CONFIDENCE|INVALID_REASON|TOO_MANY_CANDIDATES|RANGE_TOO_LONG|分析结果无效/iu.test(message)
    ? 'invalid' : 'failed';
}

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

export async function runSemanticBatch(
  connection: Pick<RemoteConnection, 'call' | 'waitJob'>,
  configId: string,
  window: SemanticWindow,
  signal: AbortSignal,
): Promise<SemanticSuggestionCandidate[]> {
  let job: JobSnapshot;
  try {
    job = await connection.call('text.suggestCuts', { configId, request: window });
  } catch (error) {
    throw new SemanticAnalysisRequestError(classifySemanticError(error),
      error instanceof Error ? error.message : String(error));
  }
  let result: SemanticAnalysisResult;
  try {
    result = await connection.waitJob<SemanticAnalysisResult>(job.id, undefined, signal);
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    throw new SemanticAnalysisRequestError(classifySemanticError(error),
      error instanceof Error ? error.message : String(error));
  }
  if (result?.version !== 1 || result.base !== window.base || result.promptVersion !== 'f0009-v1') {
    throw new SemanticAnalysisRequestError('invalid', 'Invalid analysis result (INVALID_RESPONSE)');
  }
  try {
    return validateSemanticModelResponse(result, window);
  } catch (error) {
    throw new SemanticAnalysisRequestError('invalid',
      `Invalid analysis result (${error instanceof SemanticContractError ? error.code : 'INVALID_RESPONSE'})`);
  }
}

export interface RunSemanticBatchQueueInput {
  connection: Pick<RemoteConnection, 'call' | 'waitJob'>;
  configId: string;
  batches: SemanticBatchState[];
  signal: AbortSignal;
  onProgress?: (progress: SemanticQueueProgress, batches: SemanticBatchState[]) => void;
}

/**
 * Runs pending batches sequentially. Failed/invalid batches remain independently retryable;
 * cancellation marks pending/running batches without discarding prior successes.
 */
export async function runSemanticBatchQueue(input: RunSemanticBatchQueueInput): Promise<SemanticBatchState[]> {
  const batches = input.batches.map(batch => ({
    ...batch, status: batch.status === 'pending' ? 'pending' as const : batch.status,
    candidates: [...batch.candidates], error: batch.error,
  }));
  const total = batches.length;
  let completed = batches.filter(batch => batch.status === 'success').length;
  for (const batch of batches) {
    if (batch.status !== 'pending') continue;
    if (input.signal.aborted) {
      for (const pending of batches) if (pending.status === 'pending') pending.status = 'cancelled';
      break;
    }
    batch.status = 'running';
    input.onProgress?.({ completed, total, currentBatch: batch.index }, batches);
    try {
      batch.candidates = await runSemanticBatch(input.connection, input.configId, batch.window, input.signal);
      batch.status = 'success';
      completed += 1;
    } catch (error) {
      if (isCancellation(error, input.signal)) {
        batch.status = 'cancelled';
        for (const pending of batches) if (pending.status === 'pending') pending.status = 'cancelled';
        break;
      }
      batch.status = classifySemanticError(error) === 'invalid' ? 'invalid' : 'failed';
      batch.error = error instanceof Error ? error.message : String(error);
      completed += 1;
    }
    input.onProgress?.({ completed, total }, batches);
  }
  input.onProgress?.({ completed, total }, batches);
  return batches;
}
