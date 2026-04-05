import { z } from '@hono/zod-openapi'

export const createCompanySchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
})

export const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
})

export const createPartnerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  investmentAmount: z.number().min(0).default(0),
  stakePercentage: z.number().min(0).max(100).default(0),
})

export const updatePartnerSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  investmentAmount: z.number().min(0).optional(),
  stakePercentage: z.number().min(0).max(100).optional(),
})

export const paymentStatusEnum = z.enum(['PENDING', 'PARTIAL', 'COMPLETED'])

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

export const withdrawalResponseSchema = z.object({
  id: z.string(),
  amount: z.number(),
  note: z.string().nullable(),
  amountPaid: z.number(),
  remaining: z.number(),
  paymentDate: z.string().datetime().nullable(),
  paymentStatus: paymentStatusEnum,
  createdAt: z.string().datetime(),
})

export const withdrawSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
})

export const withdrawalPaymentSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})
