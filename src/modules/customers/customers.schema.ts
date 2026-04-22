import { z } from '@hono/zod-openapi'

export const paymentModeSchema = z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI'])

export const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  sellingPrice: z.number().min(0),
  bookingAmount: z.number().min(0),
  paymentMode: paymentModeSchema.optional(),
  referenceNumber: z.string().trim().optional(),
  customerType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).optional(),
}).superRefine((data, ctx) => {
  if (data.bookingAmount > 0 && !data.paymentMode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Payment mode is required when recording a booking amount',
      path: ['paymentMode'],
    })
  }

  if (data.bookingAmount > 0 && data.paymentMode && data.paymentMode !== 'CASH' && !data.referenceNumber?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Reference number is required for non-cash booking payments',
      path: ['referenceNumber'],
    })
  }
})

export const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
})

export const cancelDealSchema = z.object({
  reason: z.string().trim().min(1),
  refundAmount: z.number().min(0),
})

export const customerResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  sellingPrice: z.number(),
  bookingAmount: z.number(),
  amountPaid: z.number(),
  remaining: z.number(),
  dealStatus: z.enum(['ACTIVE', 'CANCELLED']),
  customerType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).nullable(),
  flatId: z.string().nullable(),
  flatNumber: z.number().nullable(),
  floorNumber: z.number().nullable(),
  flatStatus: z.string().nullable(),
  customFlatId: z.string().nullable().optional(),
  floorName: z.string().nullable().optional(),
  cancelledAt: z.string().datetime().nullable(),
  cancellationReason: z.string().nullable(),
  cancelledByUserId: z.string().nullable(),
  cancelledFromFlatStatus: z.enum(['AVAILABLE', 'BOOKED', 'SOLD']).nullable(),
  cancelledFlatId: z.string().nullable(),
  cancelledFlatDisplay: z.string().nullable(),
  cancelledFloorNumber: z.number().nullable(),
  cancelledFloorName: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const customerPaymentSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
  paymentMode: paymentModeSchema,
  referenceNumber: z.string().trim().optional(),
}).superRefine((data, ctx) => {
  if (data.paymentMode !== 'CASH' && !data.referenceNumber?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Reference number is required for non-cash payments',
      path: ['referenceNumber'],
    })
  }
})

export const customerPaymentHistoryItemSchema = z.object({
  id: z.string(),
  amount: z.number(),
  direction: z.enum(['IN', 'OUT']),
  movementType: z.enum(['CUSTOMER_PAYMENT', 'CUSTOMER_REFUND']),
  paymentMode: paymentModeSchema.nullable(),
  referenceNumber: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

export const insufficientFundsErrorResponseSchema = errorResponseSchema.extend({
  availableFund: z.number().optional(),
  refundAmount: z.number().optional(),
  shortfall: z.number().optional(),
})
