import { prisma } from '../db/prisma.js'
import {
  derivePaymentStatus,
  getCompanyWithdrawalPaidTotal,
  sumLedgerAmountsForDirection,
  type LedgerReadDb,
} from './ledger-read.service.js'

export { getCompanyWithdrawalPaidTotal } from './ledger-read.service.js'

export function deriveCompanyWithdrawalPaymentStatus(
  amount: number,
  paidTotal: number,
): 'PENDING' | 'PARTIAL' | 'COMPLETED' {
  return derivePaymentStatus(amount, paidTotal)
}

export async function getCompanyWithdrawalRemaining(
  withdrawalId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  const withdrawal = await db.companyWithdrawal.findUnique({
    where: { id: withdrawalId },
    select: { amount: true },
  })

  if (!withdrawal) {
    throw new Error('COMPANY_WITHDRAWAL_NOT_FOUND')
  }

  const paidTotal = await getCompanyWithdrawalPaidTotal(withdrawalId, db)
  return withdrawal.amount - paidTotal
}

export function mapCompanyWithdrawalLedgerFields(
  amount: number,
  ledgerEntries: Array<{ amount: number | string | { toString(): string }; postedAt: Date; direction: 'IN' | 'OUT' }>,
) {
  const amountPaid = sumLedgerAmountsForDirection(ledgerEntries, 'OUT')
  const remaining = amount - amountPaid
  const paymentStatus = deriveCompanyWithdrawalPaymentStatus(amount, amountPaid)
  const paymentDate = ledgerEntries.length > 0 ? ledgerEntries[0].postedAt.toISOString() : null

  return {
    amountPaid,
    remaining,
    paymentStatus,
    paymentDate,
  }
}
