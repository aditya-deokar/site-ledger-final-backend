import { z } from '@hono/zod-openapi'

export const investorTypeEnum = z.enum(['EQUITY', 'FIXED_RATE'])
export const investorTransactionKindEnum = z.enum(['PRINCIPAL_IN', 'PRINCIPAL_OUT', 'INTEREST'])
export const paymentStatusEnum = z.enum(['PENDING', 'PARTIAL', 'COMPLETED'])

export const createInvestorSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  type: investorTypeEnum,
  siteId: z.string().optional(),
  equityPercentage: z.number().min(0).max(100).optional(),
  fixedRate: z.number().min(0).optional(),
})

export const updateInvestorSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  equityPercentage: z.number().min(0).max(100).optional(),
  fixedRate: z.number().min(0).optional(),
})

export const addTransactionSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
})

export const updateTransactionPaymentSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})

export const investorResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  type: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  equityPercentage: z.number().nullable(),
  fixedRate: z.number().nullable(),
  totalInvested: z.number(),
  totalReturned: z.number(),
  interestPaid: z.number(),
  outstandingPrincipal: z.number(),
  isClosed: z.boolean(),
  createdAt: z.string().datetime(),
})

export const transactionResponseSchema = z.object({
  id: z.string(),
  kind: investorTransactionKindEnum,
  amount: z.number(),
  note: z.string().nullable(),
  amountPaid: z.number(),
  remaining: z.number(),
  paymentDate: z.string().datetime().nullable(),
  paymentStatus: paymentStatusEnum,
  createdAt: z.string().datetime(),
})

export const paymentHistoryItemSchema = z.object({
  id: z.string(),
  amount: z.number(),
  direction: z.enum(['IN', 'OUT']),
  movementType: z.string(),
  reversalOfPaymentId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})
