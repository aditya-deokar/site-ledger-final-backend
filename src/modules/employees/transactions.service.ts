import { z } from '@hono/zod-openapi'
import { prisma } from '../../db/prisma.js'
import { getEmployeeForUser } from './employee-access.service.js'
import {
  employeePaymentMethodToDb,
  employeeTransactionStatusToDb,
  employeeTransactionStatusFromDb,
  employeeTransactionTypeToDb,
  employeeTransactionTypeFromDb,
  mapEmployeeTransaction,
} from './employees.mapper.js'
import type {
  createEmployeeTransactionSchema,
  employeeTransactionQuerySchema,
  updateEmployeeTransactionStatusSchema,
} from './employees.schema.js'

type CreateTransactionInput = z.infer<typeof createEmployeeTransactionSchema>
type TransactionQuery = z.infer<typeof employeeTransactionQuerySchema>
type UpdateTransactionStatusInput = z.infer<typeof updateEmployeeTransactionStatusSchema>

export async function createEmployeeTransactionForUser(
  userId: string,
  data: CreateTransactionInput,
) {
  const { employee } = await getEmployeeForUser(data.employeeId, userId)
  if (!employee) return { error: 'Employee not found', status: 404 }

  const transaction = await prisma.employeeTransaction.create({
    data: {
      employeeId: employee.id,
      type: employeeTransactionTypeToDb(data.type),
      amount: data.amount,
      description: data.description,
      date: data.date,
      paymentMethod: data.paymentMethod ? employeePaymentMethodToDb(data.paymentMethod) : undefined,
      status: 'PENDING',
    },
  })

  return {
    transaction: mapEmployeeTransaction(transaction),
  }
}

export async function getEmployeeTransactionsForUser(
  employeeId: string,
  userId: string,
  filters: TransactionQuery,
) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return null

  const transactions = await prisma.employeeTransaction.findMany({
    where: {
      employeeId: employee.id,
      ...(filters.type ? { type: employeeTransactionTypeToDb(filters.type) } : {}),
      ...(filters.startDate || filters.endDate
        ? {
            date: {
              ...(filters.startDate ? { gte: filters.startDate } : {}),
              ...(filters.endDate ? { lte: filters.endDate } : {}),
            },
          }
        : {}),
    },
    orderBy: { date: 'desc' },
  })

  const totalPaid = transactions
    .filter((transaction) => transaction.status === 'PAID')
    .reduce((sum, transaction) => sum + transaction.amount, 0)
  const totalDeducted = transactions
    .filter((transaction) => transaction.type === 'DEDUCTION')
    .reduce((sum, transaction) => sum + transaction.amount, 0)
  const pendingAmount = transactions
    .filter((transaction) => transaction.status === 'PENDING')
    .reduce((sum, transaction) => sum + transaction.amount, 0)

  const startDate = filters.startDate ?? transactions.at(-1)?.date ?? null
  const endDate = filters.endDate ?? transactions[0]?.date ?? null

  return {
    transactions: transactions.map(mapEmployeeTransaction),
    summary: {
      totalPaid,
      totalDeducted,
      netAmount: totalPaid - totalDeducted,
      pendingAmount,
    },
    period: {
      startDate: startDate ? startDate.toISOString() : null,
      endDate: endDate ? endDate.toISOString() : null,
    },
  }
}

export async function updateEmployeeTransactionStatusForUser(
  transactionId: string,
  userId: string,
  data: UpdateTransactionStatusInput,
) {
  const transaction = await prisma.employeeTransaction.findFirst({
    where: {
      id: transactionId,
      employee: {
        company: {
          createdBy: userId,
        },
        isDeleted: false,
      },
    },
  })

  if (!transaction) return null

  const nextStatus = employeeTransactionStatusToDb(data.status)
  const updated = await prisma.employeeTransaction.update({
    where: { id: transaction.id },
    data: {
      status: nextStatus,
      paidAt: nextStatus === 'PAID' ? (data.paidAt ?? new Date()) : null,
    },
  })

  return {
    transaction: mapEmployeeTransaction(updated),
    statusTransition: {
      previous: employeeTransactionStatusFromDb(transaction.status),
      current: employeeTransactionStatusFromDb(updated.status),
    },
  }
}
