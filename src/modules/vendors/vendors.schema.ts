import { z } from '@hono/zod-openapi'

const booleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

export const vendorTypeSchema = z.string().trim().min(1)
export const vendorStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED', 'ARCHIVED'])
export const vendorSiteAssignmentStatusSchema = z.enum(['ACTIVE', 'INACTIVE'])
export const paymentStatusSchema = z.enum(['PENDING', 'PARTIAL', 'COMPLETED'])
export const receiptStatusSchema = z.enum(['ACTIVE', 'VOIDED'])
export const paymentModeSchema = z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI'])

export const vendorListQuerySchema = z.object({
  type: vendorTypeSchema.optional(),
  search: z.string().trim().optional(),
  status: vendorStatusSchema.optional(),
  siteId: z.string().optional(),
  hasOutstanding: booleanQuerySchema.optional(),
  hasDocuments: booleanQuerySchema.optional(),
  includeArchived: booleanQuerySchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(1000).optional(),
})

const vendorMasterInputShape = {
  name: z.string().trim().min(1),
  type: vendorTypeSchema,
  status: vendorStatusSchema.optional(),
  contactPersonName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().email().optional(),
  address: z.string().trim().optional(),
  gstin: z.string().trim().optional(),
  pan: z.string().trim().optional(),
  bankAccountName: z.string().trim().optional(),
  bankName: z.string().trim().optional(),
  accountNumber: z.string().trim().optional(),
  ifscCode: z.string().trim().optional(),
  upiId: z.string().trim().optional(),
  paymentTermsDays: z.number().int().min(0).max(3650).optional(),
  notes: z.string().trim().optional(),
  openingBalanceAmount: z.number().min(0).optional(),
  openingBalanceDate: z.string().datetime().optional(),
} satisfies Record<string, z.ZodTypeAny>

export const createVendorSchema = z.object(vendorMasterInputShape)
export const updateVendorSchema = z.object(
  Object.fromEntries(
    Object.entries(vendorMasterInputShape).map(([key, value]) => [key, value.optional()]),
  ) as Record<string, z.ZodTypeAny>,
)

export const patchVendorStatusSchema = z.object({
  status: vendorStatusSchema,
})

export const vendorSiteAssignmentUpsertSchema = z.object({
  status: vendorSiteAssignmentStatusSchema.optional(),
  isPreferred: z.boolean().optional(),
  paymentTermsDaysOverride: z.number().int().min(0).max(3650).nullable().optional(),
  notes: z.string().trim().optional(),
})

export const uploadVendorDocumentSchema = z.object({
  documentType: z.string().trim().min(1),
  documentName: z.string().trim().min(1),
  fileUrl: z.string().url(),
  note: z.string().trim().optional(),
  siteId: z.string().optional(),
  expenseId: z.string().optional(),
})

export const vendorDocumentUploadResponseSchema = z.object({
  key: z.string(),
  url: z.string(),
})

export const vendorBaseResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  status: vendorStatusSchema,
  contactPersonName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  gstin: z.string().nullable(),
  pan: z.string().nullable(),
  bankAccountName: z.string().nullable(),
  bankName: z.string().nullable(),
  accountNumber: z.string().nullable(),
  ifscCode: z.string().nullable(),
  upiId: z.string().nullable(),
  paymentTermsDays: z.number().int().nullable(),
  notes: z.string().nullable(),
  openingBalanceAmount: z.number(),
  openingBalanceDate: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const vendorResponseSchema = vendorBaseResponseSchema

export const vendorAssignmentSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  status: vendorSiteAssignmentStatusSchema,
  isPreferred: z.boolean(),
  paymentTermsDaysOverride: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const vendorListItemSchema = vendorBaseResponseSchema.extend({
  siteCount: z.number().int(),
  documentCount: z.number().int(),
  billCount: z.number().int(),
  paymentCount: z.number().int(),
  overdueBillCount: z.number().int(),
  totalExpenses: z.number(),
  totalBilled: z.number(),
  totalPaid: z.number(),
  totalOutstanding: z.number(),
  remainingBalance: z.number(),
  lastBillDate: z.string().datetime().nullable(),
  lastPaymentDate: z.string().datetime().nullable(),
})

export const vendorSummarySchema = vendorListItemSchema.extend({
  assignments: z.array(vendorAssignmentSchema),
})

export const vendorDocumentSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  expenseId: z.string().nullable(),
  billNumber: z.string().nullable(),
  documentType: z.string(),
  documentName: z.string(),
  fileUrl: z.string(),
  note: z.string().nullable(),
  uploadedAt: z.string().datetime(),
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
  billNumber: z.string().nullable(),
  billDate: z.string().datetime(),
  dueDate: z.string().datetime().nullable(),
  isOverdue: z.boolean(),
  documentCount: z.number().int(),
  createdAt: z.string().datetime(),
})

export const vendorPaymentReceiptSummarySchema = z.object({
  id: z.string(),
  receiptNumber: z.string(),
  status: receiptStatusSchema,
  createdAt: z.string().datetime(),
})

export const vendorPaymentSchema = z.object({
  id: z.string(),
  expenseId: z.string(),
  expenseAmount: z.number(),
  amount: z.number(),
  direction: z.enum(['IN', 'OUT']),
  note: z.string().nullable(),
  paymentMode: paymentModeSchema.nullable(),
  referenceNumber: z.string().nullable(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  billNumber: z.string().nullable(),
  createdAt: z.string().datetime(),
  paymentDate: z.string().datetime(),
  receipt: vendorPaymentReceiptSummarySchema.nullable(),
})

export const vendorReceiptSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  expenseId: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  siteAddress: z.string().nullable(),
  vendorId: z.string(),
  vendorName: z.string(),
  vendorType: z.string(),
  contactPersonName: z.string().nullable(),
  vendorPhone: z.string().nullable(),
  vendorEmail: z.string().nullable(),
  vendorAddress: z.string().nullable(),
  vendorGstin: z.string().nullable(),
  vendorPan: z.string().nullable(),
  billNumber: z.string().nullable(),
  billAmount: z.number(),
  billDate: z.string().datetime(),
  dueDate: z.string().datetime().nullable(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  amount: z.number(),
  paymentMode: paymentModeSchema.nullable(),
  referenceNumber: z.string().nullable(),
  note: z.string().nullable(),
  date: z.string().datetime(),
  receiptNumber: z.string(),
  status: receiptStatusSchema,
  createdAt: z.string().datetime(),
})

export const vendorStatementEntrySchema = z.object({
  id: z.string(),
  entryType: z.enum(['OPENING_BALANCE', 'BILL', 'PAYMENT']),
  referenceId: z.string(),
  expenseId: z.string().nullable(),
  date: z.string().datetime(),
  billAmount: z.number(),
  paymentAmount: z.number(),
  balance: z.number(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  billNumber: z.string().nullable(),
  dueDate: z.string().datetime().nullable(),
  paymentMode: paymentModeSchema.nullable(),
  referenceNumber: z.string().nullable(),
})

export const paginationSchema = z.object({
  page: z.number().int(),
  size: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})
