import { Prisma } from '@prisma/client'
import { z } from '@hono/zod-openapi'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { getCompanyAvailableFund } from '../../utils/ledger-fund.js'
import { getEmployeeForUser } from './employee-access.service.js'
import { employeePaymentMethodToDb, mapEmployeeTransaction } from './employees.mapper.js'
import type { paySalarySchema } from './employees.schema.js'

type PaySalaryInput = z.infer<typeof paySalarySchema>

async function invalidateSalaryPaymentCaches(companyId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.companyAvailableFund(companyId)),
    cacheService.del(CacheKeys.companyDetails(companyId)),
  ])
}

export async function paySalaryForEmployee(
  employeeId: string,
  userId: string,
  data: PaySalaryInput,
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return { error: 'Employee not found', status: 404 }

  const availableFund = await getCompanyAvailableFund(company.id)
  if (data.amount > availableFund) return { error: 'INSUFFICIENT_FUNDS', status: 400 }

  const paidAt = data.paidAt ?? new Date()
  const idempotencyKey = `salary-payment:${employee.id}:${paidAt.getTime()}`
  const periodSuffix = data.month && data.year
    ? ` (${String(data.month).padStart(2, '0')}/${data.year})`
    : ''
  const description = data.note?.trim() || `Salary - ${employee.name}${periodSuffix}`

  const transaction = await prisma.$transaction(async (tx) => {
    await createLedgerEntry(
      {
        companyId: company.id,
        walletType: 'COMPANY',
        direction: 'OUT',
        movementType: 'SALARY_PAYMENT',
        amount: new Prisma.Decimal(data.amount),
        idempotencyKey,
        postedAt: paidAt,
        note: description,
      },
      tx,
    )

    const employeeTx = await tx.employeeTransaction.create({
      data: {
        employeeId: employee.id,
        type: 'SALARY',
        amount: data.amount,
        description,
        date: paidAt,
        paymentMethod: data.paymentMethod ? employeePaymentMethodToDb(data.paymentMethod) : null,
        status: 'PAID',
        paidAt,
      },
    })

    if (data.month && data.year) {
      await tx.salaryReminder.updateMany({
        where: {
          employeeId: employee.id,
          month: data.month,
          year: data.year,
          status: { in: ['PENDING', 'OVERDUE'] },
        },
        data: {
          status: 'PAID',
          paidAt,
          transactionId: employeeTx.id,
        },
      })
    }

    return employeeTx
  }, LEDGER_TX_OPTIONS)

  await invalidateSalaryPaymentCaches(company.id)
  const updatedAvailableFund = await getCompanyAvailableFund(company.id)

  return {
    transaction: mapEmployeeTransaction(transaction),
    availableFund: updatedAvailableFund,
  }
}
