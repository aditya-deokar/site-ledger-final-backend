import { z } from '@hono/zod-openapi'
import type { SalaryReminder, SalaryReminderStatus } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import {
  mapSalaryReminder,
  salaryReminderStatusToDb,
} from './employees.mapper.js'
import type {
  generateSalaryRemindersSchema,
  markReminderPaidSchema,
  salaryReminderQuerySchema,
} from './employees.schema.js'

type SalaryReminderQuery = z.infer<typeof salaryReminderQuerySchema>
type GenerateSalaryRemindersInput = z.infer<typeof generateSalaryRemindersSchema>
type MarkReminderPaidInput = z.infer<typeof markReminderPaidSchema>

function getDueDate(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
}

function resolveReminderStatus(reminder: SalaryReminder, now: Date): SalaryReminderStatus {
  if (reminder.status === 'PENDING' && reminder.dueDate.getTime() < now.getTime()) {
    return 'OVERDUE'
  }
  return reminder.status
}

function getReminderSummary(reminders: SalaryReminder[], now: Date) {
  const totalPending = reminders.filter((item) => resolveReminderStatus(item, now) !== 'PAID').length
  const overdueCount = reminders.filter((item) => resolveReminderStatus(item, now) === 'OVERDUE').length
  const totalAmount = reminders
    .filter((item) => resolveReminderStatus(item, now) !== 'PAID')
    .reduce((sum, item) => sum + item.salaryAmount, 0)

  return { totalPending, totalAmount, overdueCount }
}

export async function getSalaryRemindersForUser(userId: string, filters: SalaryReminderQuery) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const now = new Date()
  const reminders = await prisma.salaryReminder.findMany({
    where: {
      employee: {
        companyId: company.id,
        isDeleted: false,
      },
      ...(filters.month ? { month: filters.month } : {}),
      ...(filters.year ? { year: filters.year } : {}),
      ...(filters.status
        ? filters.status === 'overdue'
          ? {
              OR: [
                { status: 'OVERDUE' },
                {
                  status: 'PENDING',
                  dueDate: { lt: now },
                },
              ],
            }
          : { status: salaryReminderStatusToDb(filters.status) }
        : {}),
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { dueDate: 'asc' }],
  })

  return {
    reminders: reminders.map((reminder) => mapSalaryReminder(reminder, resolveReminderStatus(reminder, now))),
    summary: getReminderSummary(reminders, now),
  }
}

export async function generateSalaryRemindersForUser(
  userId: string,
  data: GenerateSalaryRemindersInput,
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const employees = await prisma.employee.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      status: { in: ['ACTIVE', 'INACTIVE'] },
      ...(data.employeeIds?.length ? { id: { in: data.employeeIds } } : {}),
    },
    select: { id: true, salary: true },
  })

  if (employees.length === 0) return { reminders: [], created: 0 }

  const dueDate = getDueDate(data.year, data.month)

  await prisma.salaryReminder.createMany({
    data: employees.map((employee) => ({
      employeeId: employee.id,
      month: data.month,
      year: data.year,
      salaryAmount: employee.salary,
      dueDate,
      status: 'PENDING',
      reminderSent: false,
    })),
    skipDuplicates: true,
  })

  const reminders = await prisma.salaryReminder.findMany({
    where: {
      month: data.month,
      year: data.year,
      employee: {
        companyId: company.id,
        isDeleted: false,
      },
      ...(data.employeeIds?.length ? { employeeId: { in: data.employeeIds } } : {}),
    },
    orderBy: { dueDate: 'asc' },
  })

  return {
    reminders: reminders.map((reminder) => mapSalaryReminder(reminder)),
    created: reminders.length,
  }
}

export async function markSalaryReminderPaidForUser(
  reminderId: string,
  userId: string,
  data: MarkReminderPaidInput,
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const reminder = await prisma.salaryReminder.findFirst({
    where: {
      id: reminderId,
      employee: {
        companyId: company.id,
        isDeleted: false,
      },
    },
  })

  if (!reminder) return null

  const updated = await prisma.salaryReminder.update({
    where: { id: reminder.id },
    data: {
      status: 'PAID',
      paidAt: data.paidAt ?? new Date(),
      transactionId: data.transactionId ?? reminder.transactionId,
    },
  })

  return {
    reminder: mapSalaryReminder(updated),
  }
}
