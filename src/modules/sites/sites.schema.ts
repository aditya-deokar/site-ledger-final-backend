import { z } from '@hono/zod-openapi'

export const createSiteSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  projectType: z.enum(['NEW_CONSTRUCTION', 'REDEVELOPMENT']).optional().default('NEW_CONSTRUCTION'),
  totalFloors: z.number().int().min(1).optional(),
  totalFlats: z.number().int().min(1).optional(),
}).superRefine((data, ctx) => {
  if (data.totalFlats && !data.totalFloors) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalFloors'],
      message: 'At least one floor is required before creating flats.',
    })
  }
})

export const createFloorSchema = z.object({
  floorName: z.string().min(1),
})

export const updateFloorSchema = z.object({
  floorName: z.string().min(1),
})

export const createFlatSchema = z.object({
  customFlatId: z.string().min(1),
  unitType: z.string().trim().min(1).optional(),
  flatType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).optional().default('CUSTOMER'),
})

export const updateFlatDetailsSchema = z.object({
  customFlatId: z.string().min(1),
  unitType: z.string().trim().min(1).optional(),
  flatType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).optional().default('CUSTOMER'),
})

export const allocateFundSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})

export const transferSchema = z.object({
  amount: z.number().positive(),
  direction: z.enum(['COMPANY_TO_SITE', 'SITE_TO_COMPANY']),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})

export const createExpenseSchema = z.object({
  type: z.enum(['GENERAL', 'VENDOR']),
  reason: z.string().optional(),
  vendorId: z.string().optional(),
  description: z.string().optional(),
  amount: z.number().positive(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
})

export const updateFlatSchema = z.object({
  status: z.enum(['AVAILABLE', 'BOOKED', 'SOLD']),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})
