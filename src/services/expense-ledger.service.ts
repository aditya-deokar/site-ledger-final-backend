import { prisma } from '../db/prisma.js'
import {
  derivePaymentStatus,
  getExpensePaidTotal,
  getSiteBalance,
  sumLedgerAmounts,
  type LedgerReadDb,
} from './ledger-read.service.js'

export { getExpensePaidTotal } from './ledger-read.service.js'

export function deriveExpensePaymentStatus(
  paidTotal: number,
  expenseAmount: number,
): 'PENDING' | 'PARTIAL' | 'COMPLETED' {
  return derivePaymentStatus(expenseAmount, paidTotal)
}

export async function getExpenseRemaining(
  expenseId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  const expense = await db.expense.findUnique({
    where: { id: expenseId },
    select: { amount: true },
  })

  if (!expense) {
    throw new Error('EXPENSE_NOT_FOUND')
  }

  const paidTotal = await getExpensePaidTotal(expenseId, db)
  return expense.amount - paidTotal
}

export function mapExpenseLedgerFields(
  amount: number,
  ledgerEntries: Array<{ amount: number | string | { toString(): string }; postedAt: Date }>,
) {
  const amountPaid = sumLedgerAmounts(ledgerEntries)
  const remaining = amount - amountPaid
  const paymentStatus = deriveExpensePaymentStatus(amountPaid, amount)
  const paymentDate = ledgerEntries.length > 0 ? ledgerEntries[0].postedAt.toISOString() : null

  return {
    amountPaid,
    remaining,
    paymentStatus,
    paymentDate,
  }
}

export async function getSiteLedgerNetCash(siteId: string, tx?: LedgerReadDb): Promise<number> {
  return getSiteBalance(siteId, tx)
}
