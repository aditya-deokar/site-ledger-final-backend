import { Prisma, type InvestorTransactionKind } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import {
  derivePaymentStatus,
  getInvestorTransactionPaidTotal,
  sumLedgerAmounts,
  type LedgerReadDb,
} from './ledger-read.service.js'

export { getInvestorTransactionPaidTotal } from './ledger-read.service.js'

type LedgerAmountEntry = {
  amount: Prisma.Decimal | number | string
}

type LedgerAmountWithPostedAt = LedgerAmountEntry & {
  postedAt: Date
}

type InvestorTransactionWithLedger = {
  id: string
  kind: InvestorTransactionKind
  amount: number
  note: string | null
  createdAt: Date
  ledgerEntries: LedgerAmountWithPostedAt[]
}

export function deriveInvestorTransactionPaymentStatus(
  transactionAmount: number,
  paidTotal: number,
): 'PENDING' | 'PARTIAL' | 'COMPLETED' {
  return derivePaymentStatus(transactionAmount, paidTotal)
}

export async function getInvestorTransactionRemaining(
  transactionId: string,
  tx?: LedgerReadDb,
): Promise<number> {
  const db = tx ?? prisma
  const transaction = await db.investorTransaction.findUnique({
    where: { id: transactionId },
    select: { amount: true },
  })

  if (!transaction) {
    throw new Error('INVESTOR_TRANSACTION_NOT_FOUND')
  }

  const paidTotal = await getInvestorTransactionPaidTotal(transactionId, db)
  return transaction.amount - paidTotal
}

export function mapInvestorTransactionLedgerFields(
  amount: number,
  ledgerEntries: LedgerAmountWithPostedAt[],
) {
  const amountPaid = sumLedgerAmounts(ledgerEntries)
  const remaining = amount - amountPaid
  const paymentStatus = deriveInvestorTransactionPaymentStatus(amount, amountPaid)
  const paymentDate = ledgerEntries.length > 0 ? ledgerEntries[0].postedAt.toISOString() : null

  return {
    amountPaid,
    remaining,
    paymentStatus,
    paymentDate,
  }
}

export function calculateInvestorLedgerTotals(
  transactions: Array<{ kind: InvestorTransactionKind; ledgerEntries: LedgerAmountEntry[] }>,
) {
  let principalInTotal = 0
  let principalOutTotal = 0
  let interestTotal = 0

  for (const transaction of transactions) {
    const paidTotal = sumLedgerAmounts(transaction.ledgerEntries)

    if (transaction.kind === 'PRINCIPAL_IN') {
      principalInTotal += paidTotal
    } else if (transaction.kind === 'PRINCIPAL_OUT') {
      principalOutTotal += paidTotal
    } else if (transaction.kind === 'INTEREST') {
      interestTotal += paidTotal
    }
  }

  const totalReturned = principalOutTotal + interestTotal
  const outstandingPrincipal = principalInTotal - principalOutTotal

  return {
    principalInTotal,
    principalOutTotal,
    interestTotal,
    totalReturned,
    outstandingPrincipal,
  }
}

export async function getInvestorLedgerSummary(
  investorId: string,
  tx?: LedgerReadDb,
): Promise<{
  principalInTotal: number
  principalOutTotal: number
  interestTotal: number
  totalReturned: number
  outstandingPrincipal: number
}> {
  const db = tx ?? prisma

  const [principalInResult, principalOutResult, interestResult] = await Promise.all([
    db.payment.aggregate({
      where: {
        investorTransaction: {
          investorId,
          isDeleted: false,
          kind: 'PRINCIPAL_IN',
        },
      },
      _sum: { amount: true },
    }),
    db.payment.aggregate({
      where: {
        investorTransaction: {
          investorId,
          isDeleted: false,
          kind: 'PRINCIPAL_OUT',
        },
      },
      _sum: { amount: true },
    }),
    db.payment.aggregate({
      where: {
        investorTransaction: {
          investorId,
          isDeleted: false,
          kind: 'INTEREST',
        },
      },
      _sum: { amount: true },
    }),
  ])

  const principalInTotal = Number(principalInResult._sum.amount ?? 0)
  const principalOutTotal = Number(principalOutResult._sum.amount ?? 0)
  const interestTotal = Number(interestResult._sum.amount ?? 0)

  return {
    principalInTotal,
    principalOutTotal,
    interestTotal,
    totalReturned: principalOutTotal + interestTotal,
    outstandingPrincipal: principalInTotal - principalOutTotal,
  }
}

export async function syncInvestorClosedState(
  investorId: string,
  tx?: LedgerReadDb,
): Promise<boolean> {
  const db = tx ?? prisma
  const summary = await getInvestorLedgerSummary(investorId, db)
  const isClosed = summary.principalInTotal > 0 && summary.outstandingPrincipal <= 0

  await db.investor.update({
    where: { id: investorId },
    data: { isClosed },
  })

  return isClosed
}

export function mapInvestorTransactionResponse(
  transaction: InvestorTransactionWithLedger,
) {
  const { amountPaid, remaining, paymentStatus, paymentDate } = mapInvestorTransactionLedgerFields(
    transaction.amount,
    transaction.ledgerEntries,
  )

  return {
    id: transaction.id,
    kind: transaction.kind,
    amount: transaction.amount,
    note: transaction.note,
    amountPaid,
    remaining,
    paymentDate,
    paymentStatus,
    createdAt: transaction.createdAt.toISOString(),
  }
}
