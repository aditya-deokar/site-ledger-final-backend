import { z } from '@hono/zod-openapi'
import { Prisma, type SalaryReminder, type SalaryReminderStatus } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import { getCompanyAvailableFund } from '../../utils/ledger-fund.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import {
  mapEmployeeTransaction,
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

async function invalidateSalaryPaymentCaches(companyId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.companyAvailableFund(companyId)),
    cacheService.del(CacheKeys.companyDetails(companyId)),
  ])
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
    include: {
      employee: {
        select: {
          name: true,
        },
      },
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

  const { count } = await prisma.salaryReminder.createMany({
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
    include: {
      employee: {
        select: {
          name: true,
        },
      },
    },
    orderBy: { dueDate: 'asc' },
  })

  return {
    reminders: reminders.map((reminder) => mapSalaryReminder(reminder)),
    created: count,
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
    include: {
      employee: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  })

  if (!reminder) return null
  if (reminder.status === 'PAID') {
    return { error: 'Reminder already marked as paid', status: 400 }
  }

  const availableFund = await getCompanyAvailableFund(company.id)
  if (reminder.salaryAmount > availableFund) {
    return { error: 'INSUFFICIENT_FUNDS', status: 400 }
  }

  const paidAt = data.paidAt ? new Date(data.paidAt) : new Date()
  const idempotencyKey = `salary-reminder-payment:${reminder.id}:${paidAt.getTime()}`
  const periodLabel = `${String(reminder.month).padStart(2, '0')}/${reminder.year}`
  const description = `Salary - ${reminder.employee.name} (${periodLabel})`

  const result = await prisma.$transaction(async (tx) => {
    await createLedgerEntry(
      {
        companyId: company.id,
        walletType: 'COMPANY',
        direction: 'OUT',
        movementType: 'SALARY_PAYMENT',
        amount: new Prisma.Decimal(reminder.salaryAmount),
        idempotencyKey,
        postedAt: paidAt,
        note: description,
      },
      tx,
    )

    const employeeTx = await tx.employeeTransaction.create({
      data: {
        employeeId: reminder.employee.id,
        type: 'SALARY',
        amount: reminder.salaryAmount,
        description,
        date: paidAt,
        paymentMethod: null,
        status: 'PAID',
        paidAt,
      },
    })

    const updated = await tx.salaryReminder.update({
      where: { id: reminder.id },
      data: {
        status: 'PAID',
        paidAt,
        transactionId: employeeTx.id,
      },
      include: {
        employee: {
          select: {
            name: true,
          },
        },
      },
    })

    return { updated, employeeTx }
  }, LEDGER_TX_OPTIONS)

  await invalidateSalaryPaymentCaches(company.id)
  const updatedAvailableFund = await getCompanyAvailableFund(company.id)

  return {
    reminder: mapSalaryReminder(result.updated),
    transaction: mapEmployeeTransaction(result.employeeTx),
    availableFund: updatedAvailableFund,
  }
}
