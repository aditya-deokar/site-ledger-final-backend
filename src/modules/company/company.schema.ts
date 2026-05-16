import { z } from '@hono/zod-openapi'

export const createCompanySchema = z.object({
  name: z.string().trim().min(1),
  tradeName: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  tan: z.string().optional(),
  cin: z.string().optional(),
  reraNumber: z.string().optional(),
  msmeUdyamNumber: z.string().optional(),
  epfNumber: z.string().optional(),
  esicNumber: z.string().optional(),
  bocwNumber: z.string().optional(),
  logo: z.string().url().optional(),
})

export const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  tradeName: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  tan: z.string().optional(),
  cin: z.string().optional(),
  reraNumber: z.string().optional(),
  msmeUdyamNumber: z.string().optional(),
  epfNumber: z.string().optional(),
  esicNumber: z.string().optional(),
  bocwNumber: z.string().optional(),
  logo: z.string().url().nullable().optional(),
})

export const receiptSettingsSchema = z.object({
  showCompanyLogo: z.boolean().optional(),
  showGstin: z.boolean().optional(),
  showPan: z.boolean().optional(),
  showReraNumber: z.boolean().optional(),
  showCorporateAddress: z.boolean().optional(),
  showSupportContact: z.boolean().optional(),
})

export const updateReceiptSettingsSchema = z.object({
  receiptSettings: receiptSettingsSchema,
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
  paymentDate: z.string().optional().refine(
    (v) => !v || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v),
    { message: 'Invalid datetime' },
  ).transform((v) => (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00` : v)),
  idempotencyKey: z.string().optional(),
})

export const withdrawalPaymentSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})

export const updateWithdrawalSchema = z.object({
  note: z.string().optional(),
})
