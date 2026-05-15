import { z } from '@hono/zod-openapi'

export const investorTypeEnum = z.enum(['EQUITY', 'FIXED_RATE'])
export const fixedRateCadenceEnum = z.enum(['YEARLY', 'MONTHLY'])
export const investorTransactionKindEnum = z.enum(['PRINCIPAL_IN', 'PRINCIPAL_OUT', 'INTEREST'])
export const paymentStatusEnum = z.enum(['PENDING', 'PARTIAL', 'COMPLETED'])

export const createInvestorSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  type: investorTypeEnum,
  siteId: z.string().optional(),
  equityPercentage: z.number().min(0).max(100).optional(),
  fixedRate: z.number().min(0).optional(),
  fixedRateCadence: fixedRateCadenceEnum.optional(),
}).superRefine((data, ctx) => {
  if (data.type === 'FIXED_RATE') {
    if (data.fixedRate === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fixedRate is required for fixed-rate investors',
        path: ['fixedRate'],
      })
    }

    if (data.fixedRateCadence === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fixedRateCadence is required for fixed-rate investors',
        path: ['fixedRateCadence'],
      })
    }
  }
})

export const updateInvestorSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  equityPercentage: z.number().min(0).max(100).optional(),
  fixedRate: z.number().min(0).optional(),
  fixedRateCadence: fixedRateCadenceEnum.optional(),
})

export const addTransactionSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().optional().refine(
    (v) => !v || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v),
    { message: 'Invalid datetime' },
  ).transform((v) => (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00` : v)),
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
  fixedRateCadence: fixedRateCadenceEnum.nullable(),
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
