import { z } from '@hono/zod-openapi'

export const paymentModeSchema = z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI'])
export const bookingAgreementLineTypeSchema = z.enum(['CHARGE', 'TAX', 'DISCOUNT', 'CREDIT'])

export const bookingAgreementLineSchema = z.object({
  type: bookingAgreementLineTypeSchema,
  label: z.string().trim().min(1),
  amount: z.number().min(0),
  ratePercent: z.number().min(0).optional(),
  calculationBase: z.number().min(0).optional(),
  affectsProfit: z.boolean().optional(),
  note: z.string().optional(),
})

export const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  sellingPrice: z.number().min(0),
  bookingAmount: z.number().min(0),
  paymentMode: paymentModeSchema.optional(),
  referenceNumber: z.string().trim().optional(),
  customerType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).optional(),
  agreementLines: z.array(bookingAgreementLineSchema).optional(),
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

  data.agreementLines?.forEach((line, index) => {
    if (line.type === 'TAX' && (line.ratePercent === undefined || line.ratePercent <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tax lines must include a percentage greater than zero',
        path: ['agreementLines', index, 'ratePercent'],
      })
    }

    if (line.type === 'DISCOUNT') {
      const hasRatePercent = line.ratePercent !== undefined && line.ratePercent > 0
      const hasFixedAmount = line.amount > 0
      if (!hasRatePercent && !hasFixedAmount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Discount needs a fixed amount or percentage',
          path: ['agreementLines', index, 'amount'],
        })
      }
    }
  })
})

export const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  sellingPrice: z.number().min(0).optional(),
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
  wingId: z.string().nullable().optional(),
  wingName: z.string().nullable().optional(),
  unitType: z.string().nullable().optional(),
  flatType: z.string().nullable().optional(),
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
  movementType: z.enum(['CUSTOMER_PAYMENT', 'CUSTOMER_REFUND', 'REVERSAL']),
  paymentMode: paymentModeSchema.nullable(),
  referenceNumber: z.string().nullable(),
  note: z.string().nullable(),
  isReversed: z.boolean().optional(),
  reversedAt: z.string().datetime().nullable().optional(),
  reversalPaymentId: z.string().nullable().optional(),
  receiptId: z.string().nullable().optional(),
  receiptNumber: z.string().nullable().optional(),
  receiptStatus: z.enum(['ACTIVE', 'VOIDED']).nullable().optional(),
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
