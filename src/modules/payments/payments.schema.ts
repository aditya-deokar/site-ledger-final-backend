import { z } from '@hono/zod-openapi'

export const receiptStatusSchema = z.enum(['ACTIVE', 'VOIDED'])

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(1),
  idempotencyKey: z.string().trim().optional(),
})

export const paymentReceiptSchema = z.object({
  id: z.string(),
  receiptNumber: z.string(),
  status: receiptStatusSchema,
  voidedAt: z.string().datetime().nullable(),
  voidReason: z.string().nullable(),
  createdByUserId: z.string(),
  createdAt: z.string().datetime(),
  snapshot: z.any(),
})

export const reversalPaymentSummarySchema = z.object({
  id: z.string(),
  amount: z.number(),
  direction: z.enum(['IN', 'OUT']),
  movementType: z.literal('REVERSAL'),
  reversalOfPaymentId: z.string(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const originalPaymentReversalSchema = z.object({
  id: z.string(),
  amount: z.number(),
  direction: z.enum(['IN', 'OUT']),
  movementType: z.string(),
  reversedAt: z.string().datetime(),
  reversalReason: z.string().nullable(),
})

export const reversePaymentResponseSchema = z.object({
  payment: originalPaymentReversalSchema,
  reversal: reversalPaymentSummarySchema,
  receipt: z.object({
    id: z.string(),
    receiptNumber: z.string(),
    status: receiptStatusSchema,
    voidedAt: z.string().datetime().nullable(),
    voidReason: z.string().nullable(),
    createdAt: z.string().datetime(),
  }).nullable(),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})
