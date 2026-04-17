import { Prisma, type Direction } from '@prisma/client'
import { prisma } from '../db/prisma.js'

export type LedgerReadDb = Prisma.TransactionClient | typeof prisma

type LedgerAmountEntry = {
  amount: Prisma.Decimal | number | string | { toString(): string }
}

type DirectionalLedgerAmountEntry = LedgerAmountEntry & {
  direction: Direction
}

export function sumLedgerAmounts(entries: LedgerAmountEntry[]): number {
  return entries.reduce((sum, entry) => sum + Number(entry.amount), 0)
}

export function sumDirectionalLedgerAmounts(entries: DirectionalLedgerAmountEntry[]): number {
  return entries.reduce((sum, entry) => {
    const amount = Number(entry.amount)
    return sum + (entry.direction === 'IN' ? amount : -amount)
  }, 0)
}

export function derivePaymentStatus(
  amount: number,
  paidTotal: number,
): 'PENDING' | 'PARTIAL' | 'COMPLETED' {
  const normalizedAmount = Math.abs(amount)

  if (paidTotal <= 0) return 'PENDING'
  if (paidTotal >= normalizedAmount) return 'COMPLETED'
  return 'PARTIAL'
}

async function getPaymentTotal(
  where: Prisma.PaymentWhereInput,
  db: LedgerReadDb,
): Promise<number> {
  const result = await db.payment.aggregate({
    where,
    _sum: { amount: true },
  })

  return Number(result._sum.amount ?? 0)
}

async function getDirectionalPaymentTotal(
  where: Prisma.PaymentWhereInput,
  db: LedgerReadDb,
): Promise<number> {
  const [incoming, outgoing] = await Promise.all([
    getPaymentTotal({ ...where, direction: 'IN' }, db),
    getPaymentTotal({ ...where, direction: 'OUT' }, db),
  ])

  return incoming - outgoing
}

async function getWalletBalance(
  where: Prisma.PaymentWhereInput,
  db: LedgerReadDb,
): Promise<number> {
  const incoming = await getPaymentTotal({ ...where, direction: 'IN' }, db)
  const outgoing = await getPaymentTotal({ ...where, direction: 'OUT' }, db)

  return incoming - outgoing
}

export async function getCompanyBalance(
  companyId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  return getWalletBalance({ companyId, walletType: 'COMPANY' }, db)
}

export async function getSiteBalance(
  siteId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  return getWalletBalance({ siteId, walletType: 'SITE' }, db)
}

export async function getCustomerPaidTotal(
  customerId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  return getDirectionalPaymentTotal({ customerId }, db)
}

export async function getExpensePaidTotal(
  expenseId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  return getPaymentTotal({ expenseId }, db)
}

export async function getInvestorTransactionPaidTotal(
  transactionId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  return getPaymentTotal({ investorTransactionId: transactionId }, db)
}

export async function getCompanyWithdrawalPaidTotal(
  withdrawalId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  return getPaymentTotal({ companyWithdrawalId: withdrawalId }, db)
}

export async function getPartnerPaidTotal(
  partnerId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  return getWalletBalance({ partnerId, walletType: 'COMPANY' }, db)
}
