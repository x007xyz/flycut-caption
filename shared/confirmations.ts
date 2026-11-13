import { z } from 'zod';

export const confirmationKindSchema = z.enum(['trash-project', 'purge-project', 'remove-video', 'overwrite-export']);
export type ConfirmationKind = z.infer<typeof confirmationKindSchema>;

export const confirmationSourceSchema = z.enum(['cli', 'mcp', 'agent']);
export type ConfirmationSource = z.infer<typeof confirmationSourceSchema>;

export const confirmationStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'executed',
  'consumed',
  'expired',
]);
export type ConfirmationStatus = z.infer<typeof confirmationStatusSchema>;

export const confirmationTargetSchema = z.strictObject({
  projectId: z.uuid().optional(),
  projectName: z.string().max(240).optional(),
  videoId: z.uuid().optional(),
  videoName: z.string().max(280).optional(),
  outputName: z.string().max(280).optional(),
  format: z.string().max(20).optional(),
});
export type ConfirmationTarget = z.infer<typeof confirmationTargetSchema>;

export const confirmationCreateInputSchema = z.strictObject({
  kind: confirmationKindSchema,
  source: confirmationSourceSchema.default('cli'),
  target: confirmationTargetSchema,
  operationId: z.uuid().optional(),
  summary: z.string().max(500).optional(),
});
export type ConfirmationCreateInput = z.input<typeof confirmationCreateInputSchema>;

export const confirmationIdSchema = z.strictObject({ id: z.uuid() });

export const confirmationListInputSchema = z.strictObject({
  status: z.enum(['pending', 'all']).optional(),
}).optional();

export const confirmationDecideInputSchema = z.strictObject({
  id: z.uuid(),
  decision: z.enum(['approve', 'reject']),
  actor: z.literal('ui-client'),
});
export type ConfirmationDecideInput = z.infer<typeof confirmationDecideInputSchema>;

export const confirmationConsumeInputSchema = z.strictObject({ id: z.uuid() });

export interface ConfirmationRequest {
  id: string;
  operationId?: string;
  kind: ConfirmationKind;
  source: ConfirmationSource;
  target: ConfirmationTarget;
  summary: string;
  status: ConfirmationStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: 'ui-client';
  executedAt?: string;
  result?: unknown;
  error?: string;
}
