import { z } from '@hono/zod-openapi'

export const vendorTypeSchema = z.string().trim().min(1)
export const paymentStatusSchema = z.enum(['PENDING', 'PARTIAL', 'COMPLETED'])

export const createVendorSchema = z.object({
  name: z.string().min(1),
  type: vendorTypeSchema,
  phone: z.string().optional(),
  email: z.string().email().optional(),
})

export const updateVendorSchema = z.object({
  name: z.string().min(1).optional(),
  type: vendorTypeSchema.optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
})

export const vendorResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const vendorSummarySchema = vendorResponseSchema.extend({
  totalExpenses: z.number(),
  totalBilled: z.number(),
  totalPaid: z.number(),
  totalOutstanding: z.number(),
  remainingBalance: z.number(),
  expenseCount: z.number(),
  billCount: z.number(),
})

export const vendorBillSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  amount: z.number(),
  amountPaid: z.number(),
  remaining: z.number(),
  paymentDate: z.string().datetime().nullable(),
  paymentStatus: paymentStatusSchema,
  description: z.string().nullable(),
  reason: z.string().nullable(),
  siteName: z.string(),
  createdAt: z.string().datetime(),
  billDate: z.string().datetime(),
})

export const vendorPaymentSchema = z.object({
  id: z.string(),
  expenseId: z.string(),
  expenseAmount: z.number(),
  amount: z.number(),
  note: z.string().nullable(),
  siteId: z.string(),
  siteName: z.string(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  paymentDate: z.string().datetime(),
})

export const vendorStatementEntrySchema = z.object({
  id: z.string(),
  entryType: z.enum(['BILL', 'PAYMENT']),
  referenceId: z.string(),
  expenseId: z.string(),
  date: z.string().datetime(),
  billAmount: z.number(),
  paymentAmount: z.number(),
  balance: z.number(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  siteId: z.string(),
  siteName: z.string(),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})