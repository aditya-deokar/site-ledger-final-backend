import { z } from '@hono/zod-openapi'

export const employeeStatusSchema = z.enum(['active', 'inactive', 'terminated'])
export const attendanceStatusSchema = z.enum(['present', 'absent', 'half_day'])
export const employeeTransactionTypeSchema = z.enum(['salary', 'bonus', 'deduction', 'advance', 'reimbursement'])
export const employeePaymentMethodSchema = z.enum(['cash', 'bank_transfer', 'cheque'])
export const employeeTransactionStatusSchema = z.enum(['pending', 'paid', 'failed'])
export const salaryReminderStatusSchema = z.enum(['pending', 'paid', 'overdue'])

export const createEmployeeSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email().optional(),
  phone: z.string().trim().min(1),
  address: z.string().trim().min(1),
  photo: z.string().url().optional(),
  employeeId: z.string().trim().min(1).optional(),
  designation: z.string().trim().min(1),
  department: z.string().trim().min(1),
  dateOfJoining: z.coerce.date(),
  salary: z.number().nonnegative(),
  status: employeeStatusSchema.optional(),
})

export const updateEmployeeSchema = z.object({
  name: z.string().trim().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().min(1).optional(),
  address: z.string().trim().min(1).optional(),
  photo: z.string().url().optional(),
  employeeId: z.string().trim().min(1).optional(),
  designation: z.string().trim().min(1).optional(),
  department: z.string().trim().min(1).optional(),
  dateOfJoining: z.coerce.date().optional(),
  salary: z.number().nonnegative().optional(),
  status: employeeStatusSchema.optional(),
})

export const employeeListQuerySchema = z.object({
  search: z.string().trim().optional(),
  department: z.string().trim().optional(),
  status: employeeStatusSchema.optional(),
})

export const uploadDocumentSchema = z
  .object({
    documentType: z.string().trim().min(1),
    documentName: z.string().trim().min(1),
    fileUrl: z.string().url().optional(),
    keyValueData: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => Boolean(value.fileUrl || value.keyValueData), {
    message: 'Either fileUrl or keyValueData is required',
  })

export const markAttendanceSchema = z.object({
  employeeId: z.string(),
  date: z.coerce.date(),
  status: attendanceStatusSchema,
  checkInTime: z.coerce.date().optional(),
  checkOutTime: z.coerce.date().optional(),
  reasonOfAbsenteeism: z.string().trim().optional(),
})

export const attendanceHistoryQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
})

export const createEmployeeTransactionSchema = z.object({
  employeeId: z.string(),
  type: employeeTransactionTypeSchema,
  amount: z.number().positive(),
  description: z.string().trim().min(1),
  date: z.coerce.date(),
  paymentMethod: employeePaymentMethodSchema.optional(),
})

export const employeeTransactionQuerySchema = z.object({
  type: employeeTransactionTypeSchema.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
})

export const updateEmployeeTransactionStatusSchema = z.object({
  status: employeeTransactionStatusSchema,
  paidAt: z.coerce.date().optional(),
})

export const generateSalaryRemindersSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  employeeIds: z.array(z.string()).optional(),
})

export const salaryReminderQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  status: salaryReminderStatusSchema.optional(),
})

export const markReminderPaidSchema = z.object({
  paidAt: z.coerce.date().optional(),
  transactionId: z.string().optional(),
})

export const employeeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string(),
  address: z.string(),
  photo: z.string().nullable(),
  employeeId: z.string(),
  designation: z.string(),
  department: z.string(),
  dateOfJoining: z.string().datetime(),
  salary: z.number(),
  status: employeeStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const employeeDocumentResponseSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  documentType: z.string(),
  documentName: z.string(),
  fileUrl: z.string().nullable(),
  keyValueData: z.record(z.string(), z.string()).optional(),
  uploadedAt: z.string().datetime(),
})

export const attendanceResponseSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  date: z.string().datetime(),
  status: attendanceStatusSchema,
  checkInTime: z.string().datetime().nullable(),
  checkOutTime: z.string().datetime().nullable(),
  reasonOfAbsenteeism: z.string().nullable(),
  markedBy: z.string(),
  createdAt: z.string().datetime(),
})

export const monthlyAttendanceSummarySchema = z.object({
  employeeId: z.string(),
  month: z.number().int(),
  year: z.number().int(),
  totalDays: z.number().int(),
  presentDays: z.number().int(),
  absentDays: z.number().int(),
  halfDays: z.number().int(),
  workDays: z.number(),
  attendancePercentage: z.number(),
})

export const employeeTransactionResponseSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  type: employeeTransactionTypeSchema,
  amount: z.number(),
  description: z.string(),
  date: z.string().datetime(),
  paymentMethod: employeePaymentMethodSchema.nullable(),
  status: employeeTransactionStatusSchema,
  createdAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
})

export const salaryReminderResponseSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  month: z.number().int(),
  year: z.number().int(),
  salaryAmount: z.number(),
  dueDate: z.string().datetime(),
  status: salaryReminderStatusSchema,
  reminderSent: z.boolean(),
  createdAt: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
  transactionId: z.string().nullable(),
})

export const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})
