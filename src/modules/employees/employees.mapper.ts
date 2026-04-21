import type {
  Attendance,
  AttendanceStatus,
  Employee,
  EmployeeDocument,
  EmployeePaymentMethod,
  EmployeeStatus,
  EmployeeTransaction,
  EmployeeTransactionStatus,
  EmployeeTransactionType,
  SalaryReminder,
  SalaryReminderStatus,
} from '@prisma/client'

type EmployeeStatusApi = 'active' | 'inactive' | 'terminated'
type AttendanceStatusApi = 'present' | 'absent' | 'half_day'
type EmployeeTransactionTypeApi = 'salary' | 'bonus' | 'deduction' | 'advance' | 'reimbursement'
type EmployeePaymentMethodApi = 'cash' | 'bank_transfer' | 'cheque'
type EmployeeTransactionStatusApi = 'pending' | 'paid' | 'failed'
type SalaryReminderStatusApi = 'pending' | 'paid' | 'overdue'

const employeeStatusToDbMap: Record<EmployeeStatusApi, EmployeeStatus> = {
  active: 'ACTIVE',
  inactive: 'INACTIVE',
  terminated: 'TERMINATED',
}

const employeeStatusFromDbMap: Record<EmployeeStatus, EmployeeStatusApi> = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  TERMINATED: 'terminated',
}

const attendanceStatusToDbMap: Record<AttendanceStatusApi, AttendanceStatus> = {
  present: 'PRESENT',
  absent: 'ABSENT',
  half_day: 'HALF_DAY',
}

const attendanceStatusFromDbMap: Record<AttendanceStatus, AttendanceStatusApi> = {
  PRESENT: 'present',
  ABSENT: 'absent',
  HALF_DAY: 'half_day',
}

const transactionTypeToDbMap: Record<EmployeeTransactionTypeApi, EmployeeTransactionType> = {
  salary: 'SALARY',
  bonus: 'BONUS',
  deduction: 'DEDUCTION',
  advance: 'ADVANCE',
  reimbursement: 'REIMBURSEMENT',
}

const transactionTypeFromDbMap: Record<EmployeeTransactionType, EmployeeTransactionTypeApi> = {
  SALARY: 'salary',
  BONUS: 'bonus',
  DEDUCTION: 'deduction',
  ADVANCE: 'advance',
  REIMBURSEMENT: 'reimbursement',
}

const paymentMethodToDbMap: Record<EmployeePaymentMethodApi, EmployeePaymentMethod> = {
  cash: 'CASH',
  bank_transfer: 'BANK_TRANSFER',
  cheque: 'CHEQUE',
}

const paymentMethodFromDbMap: Record<EmployeePaymentMethod, EmployeePaymentMethodApi> = {
  CASH: 'cash',
  BANK_TRANSFER: 'bank_transfer',
  CHEQUE: 'cheque',
}

const transactionStatusToDbMap: Record<EmployeeTransactionStatusApi, EmployeeTransactionStatus> = {
  pending: 'PENDING',
  paid: 'PAID',
  failed: 'FAILED',
}

const transactionStatusFromDbMap: Record<EmployeeTransactionStatus, EmployeeTransactionStatusApi> = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
}

const reminderStatusToDbMap: Record<SalaryReminderStatusApi, SalaryReminderStatus> = {
  pending: 'PENDING',
  paid: 'PAID',
  overdue: 'OVERDUE',
}

const reminderStatusFromDbMap: Record<SalaryReminderStatus, SalaryReminderStatusApi> = {
  PENDING: 'pending',
  PAID: 'paid',
  OVERDUE: 'overdue',
}

export function employeeStatusToDb(value: EmployeeStatusApi) {
  return employeeStatusToDbMap[value]
}

export function employeeStatusFromDb(value: EmployeeStatus) {
  return employeeStatusFromDbMap[value]
}

export function attendanceStatusToDb(value: AttendanceStatusApi) {
  return attendanceStatusToDbMap[value]
}

export function attendanceStatusFromDb(value: AttendanceStatus) {
  return attendanceStatusFromDbMap[value]
}

export function employeeTransactionTypeToDb(value: EmployeeTransactionTypeApi) {
  return transactionTypeToDbMap[value]
}

export function employeeTransactionTypeFromDb(value: EmployeeTransactionType) {
  return transactionTypeFromDbMap[value]
}

export function employeePaymentMethodToDb(value: EmployeePaymentMethodApi) {
  return paymentMethodToDbMap[value]
}

export function employeePaymentMethodFromDb(value: EmployeePaymentMethod) {
  return paymentMethodFromDbMap[value]
}

export function employeeTransactionStatusToDb(value: EmployeeTransactionStatusApi) {
  return transactionStatusToDbMap[value]
}

export function employeeTransactionStatusFromDb(value: EmployeeTransactionStatus) {
  return transactionStatusFromDbMap[value]
}

export function salaryReminderStatusToDb(value: SalaryReminderStatusApi) {
  return reminderStatusToDbMap[value]
}

export function salaryReminderStatusFromDb(value: SalaryReminderStatus) {
  return reminderStatusFromDbMap[value]
}

export function normalizeDateOnly(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

function mapKeyValueData(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter((entry) => typeof entry[1] === 'string')
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries) as Record<string, string>
}

export function mapEmployee(employee: Employee) {
  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    phone: employee.phone,
    address: employee.address,
    photo: employee.photo,
    employeeId: employee.employeeId,
    designation: employee.designation,
    department: employee.department,
    dateOfJoining: employee.dateOfJoining.toISOString(),
    salary: employee.salary,
    status: employeeStatusFromDb(employee.status),
    createdAt: employee.createdAt.toISOString(),
    updatedAt: employee.updatedAt.toISOString(),
  }
}

export function mapEmployeeDocument(document: EmployeeDocument) {
  return {
    id: document.id,
    employeeId: document.employeeId,
    documentType: document.documentType,
    documentName: document.documentName,
    fileUrl: document.fileUrl,
    keyValueData: mapKeyValueData(document.keyValueData),
    uploadedAt: document.uploadedAt.toISOString(),
  }
}

export function mapAttendance(attendance: Attendance) {
  return {
    id: attendance.id,
    employeeId: attendance.employeeId,
    date: attendance.date.toISOString(),
    status: attendanceStatusFromDb(attendance.status),
    checkInTime: attendance.checkInTime?.toISOString() ?? null,
    checkOutTime: attendance.checkOutTime?.toISOString() ?? null,
    reasonOfAbsenteeism: attendance.reasonOfAbsenteeism,
    markedBy: attendance.markedBy,
    createdAt: attendance.createdAt.toISOString(),
  }
}

export function mapEmployeeTransaction(transaction: EmployeeTransaction) {
  return {
    id: transaction.id,
    employeeId: transaction.employeeId,
    type: employeeTransactionTypeFromDb(transaction.type),
    amount: transaction.amount,
    description: transaction.description,
    date: transaction.date.toISOString(),
    paymentMethod: transaction.paymentMethod ? employeePaymentMethodFromDb(transaction.paymentMethod) : null,
    status: employeeTransactionStatusFromDb(transaction.status),
    createdAt: transaction.createdAt.toISOString(),
    paidAt: transaction.paidAt?.toISOString() ?? null,
  }
}

export function mapSalaryReminder(
  reminder: SalaryReminder,
  statusOverride?: SalaryReminderStatus,
) {
  const status = statusOverride ?? reminder.status

  return {
    id: reminder.id,
    employeeId: reminder.employeeId,
    month: reminder.month,
    year: reminder.year,
    salaryAmount: reminder.salaryAmount,
    dueDate: reminder.dueDate.toISOString(),
    status: salaryReminderStatusFromDb(status),
    reminderSent: reminder.reminderSent,
    createdAt: reminder.createdAt.toISOString(),
    paidAt: reminder.paidAt?.toISOString() ?? null,
    transactionId: reminder.transactionId ?? null,
  }
}
