import { Prisma, type InvestorTransactionKind, type InvestorType } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import {
  deriveInvestorTransactionPaymentStatus,
  getInvestorLedgerSummary,
  getInvestorTransactionPaidTotal,
  getInvestorTransactionRemaining,
  syncInvestorClosedState,
} from '../../services/investor-ledger.service.js'
import { invalidateInvestorCaches, invalidateInvestorDetailCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { getInvestorForUser } from './investor-access.service.js'
import {
  getInvestorView,
  getTransactionView,
  type InvestorServiceError,
  type InvestorTransactionView,
  type InvestorView,
} from './investors.service.js'

function resolveLedgerConfig(
  investor: { siteId: string | null },
  kind: 'PRINCIPAL_IN' | 'PRINCIPAL_OUT' | 'INTEREST',
) {
  const walletType = investor.siteId ? 'SITE' as const : 'COMPANY' as const

  if (kind === 'PRINCIPAL_IN') {
    return {
      siteId: investor.siteId,
      walletType,
      direction: 'IN' as const,
      movementType: 'INVESTOR_PRINCIPAL_IN' as const,
    }
  }

  if (kind === 'PRINCIPAL_OUT') {
    return {
      siteId: investor.siteId,
      walletType,
      direction: 'OUT' as const,
      movementType: 'INVESTOR_PRINCIPAL_OUT' as const,
    }
  }

  return {
    siteId: investor.siteId,
    walletType,
    direction: 'OUT' as const,
    movementType: 'INVESTOR_INTEREST' as const,
  }
}

function getDefaultLedgerNote(
  kind: 'PRINCIPAL_IN' | 'PRINCIPAL_OUT' | 'INTEREST',
  investorType: InvestorType,
) {
  if (kind === 'PRINCIPAL_IN') return 'Investor principal received'
  if (kind === 'PRINCIPAL_OUT') return 'Investor principal payout'
  return investorType === 'EQUITY' ? 'Equity profit share payout' : 'Investor interest payout'
}

function roundCurrencyAmount(value: number) {
  return Math.round(value * 100) / 100
}

async function getEquityProfitShareStatus(
  investor: { id: string; siteId: string | null; equityPercentage: number | null },
  tx?: Prisma.TransactionClient,
) {
  if (!investor.siteId) {
    throw new Error('EQUITY_SITE_REQUIRED')
  }

  const db = tx ?? prisma
  const [revenueResult, expensesResult, summary, profitShareTransactions] = await Promise.all([
    db.customer.aggregate({
      where: {
        siteId: investor.siteId,
        isDeleted: false,
        dealStatus: 'ACTIVE',
      },
      _sum: { sellingPrice: true },
    }),
    db.expense.aggregate({
      where: { siteId: investor.siteId, isDeleted: false },
      _sum: { amount: true },
    }),
    getInvestorLedgerSummary(investor.id, db),
    db.investorTransaction.findMany({
      where: {
        investorId: investor.id,
        isDeleted: false,
        kind: 'INTEREST',
      },
      select: {
        amount: true,
        ledgerEntries: {
          select: { amount: true },
        },
      },
    }),
  ])

  const siteProfit = Math.max(Number(revenueResult._sum.sellingPrice ?? 0) - Number(expensesResult._sum.amount ?? 0), 0)
  const estimatedShare = roundCurrencyAmount(((investor.equityPercentage ?? 0) / 100) * siteProfit)
  const recordedShare = roundCurrencyAmount(
    profitShareTransactions.reduce((sum, transaction) => sum + Number(transaction.amount), 0),
  )
  const pendingShare = roundCurrencyAmount(
    profitShareTransactions.reduce((sum, transaction) => {
      const paid = transaction.ledgerEntries.reduce((paidTotal, entry) => paidTotal + Number(entry.amount), 0)
      return sum + Math.max(Number(transaction.amount) - paid, 0)
    }, 0),
  )
  const availableToRecord = Math.max(roundCurrencyAmount(estimatedShare - recordedShare), 0)

  return {
    siteProfit,
    estimatedShare,
    recordedShare,
    pendingShare,
    availableToRecord,
    profitPaid: summary.interestTotal,
    principalInvested: summary.principalInTotal,
    hasOpenProfitShare: pendingShare > 0,
  }
}

async function createInvestorTransactionDocumentWithLedger(
  tx: Prisma.TransactionClient,
  input: {
    companyId: string
    investor: { id: string; siteId: string | null; type: InvestorType }
    kind: 'PRINCIPAL_IN' | 'PRINCIPAL_OUT' | 'INTEREST'
    amount: number
    amountPaid: number
    note?: string
    paymentDate?: string
    idempotencyKey?: string
  },
) {
  const transaction = await tx.investorTransaction.create({
    data: {
      investorId: input.investor.id,
      kind: input.kind,
      amount: input.amount,
      note: input.note ?? null,
    },
  })

  if (input.amountPaid > 0) {
    const ledgerConfig = resolveLedgerConfig(input.investor, input.kind)

    await createLedgerEntry(
      {
        companyId: input.companyId,
        siteId: ledgerConfig.siteId,
        walletType: ledgerConfig.walletType,
        direction: ledgerConfig.direction,
        movementType: ledgerConfig.movementType,
        amount: new Prisma.Decimal(input.amountPaid),
        idempotencyKey:
          input.idempotencyKey ?? `investor-${input.kind.toLowerCase()}:${transaction.id}:${Date.now()}`,
        postedAt: input.paymentDate ? new Date(input.paymentDate) : undefined,
        note: input.note ?? getDefaultLedgerNote(input.kind, input.investor.type),
        investorTransactionId: transaction.id,
      },
      tx,
    )
  }

  await syncInvestorClosedState(input.investor.id, tx)

  return transaction.id
}

export async function addPrincipalForUser(
  investorId: string,
  userId: string,
  data: { amount: number; note?: string; amountPaid?: number; paymentDate?: string; idempotencyKey?: string },
): Promise<
  | { transaction: InvestorTransactionView; investor: InvestorView }
  | InvestorServiceError
  | null
> {
  const { company, investor } = await getInvestorForUser(investorId, userId)
  if (!company || !investor) return null

  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = data
  if (amountPaid > amount) return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }

  const transactionId = await prisma.$transaction(
    async (tx) => {
      return createInvestorTransactionDocumentWithLedger(tx, {
        companyId: company.id,
        investor,
        kind: 'PRINCIPAL_IN',
        amount,
        amountPaid,
        note,
        paymentDate,
        idempotencyKey,
      })
    },
    LEDGER_TX_OPTIONS,
  )

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const [view, transaction] = await Promise.all([getInvestorView(investor.id), getTransactionView(transactionId)])
  if (!view || !transaction) return null

  return {
    transaction,
    investor: view.investor,
  }
}

export async function returnInvestmentForUser(
  investorId: string,
  userId: string,
  data: { amount: number; note?: string; amountPaid?: number; paymentDate?: string; idempotencyKey?: string },
): Promise<
  | { transaction: InvestorTransactionView; investor: InvestorView }
  | InvestorServiceError
  | null
> {
  const { company, investor } = await getInvestorForUser(investorId, userId)
  if (!company || !investor) return null

  if (investor.type !== 'FIXED_RATE') {
    return {
      error: 'Principal return is only available for fixed-rate investors. Use profit payout for equity investors.',
      status: 400,
    }
  }

  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = data
  if (amountPaid > amount) return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }

  const summary = await getInvestorLedgerSummary(investor.id)
  if (amount > summary.outstandingPrincipal) {
    return {
      error: `Return amount (${amount}) exceeds outstanding principal (${summary.outstandingPrincipal})`,
      status: 400,
    }
  }

  const transactionId = await prisma.$transaction(
    async (tx) => {
      return createInvestorTransactionDocumentWithLedger(tx, {
        companyId: company.id,
        investor,
        kind: 'PRINCIPAL_OUT',
        amount,
        amountPaid,
        note: note ?? 'Principal return',
        paymentDate,
        idempotencyKey,
      })
    },
    LEDGER_TX_OPTIONS,
  )

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const [view, transaction] = await Promise.all([getInvestorView(investor.id), getTransactionView(transactionId)])
  if (!view || !transaction) return null

  return {
    transaction,
    investor: view.investor,
  }
}

export async function payInterestForUser(
  investorId: string,
  userId: string,
  data: { amount: number; note?: string; amountPaid?: number; paymentDate?: string; idempotencyKey?: string },
): Promise<
  | { transaction: InvestorTransactionView; investor: InvestorView }
  | InvestorServiceError
  | null
> {
  const { company, investor } = await getInvestorForUser(investorId, userId)
  if (!company || !investor) return null

  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = data
  if (amountPaid > amount) return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }

  if (investor.type === 'EQUITY') {
    if (!investor.siteId) {
      return { error: 'Equity investor must be linked to a site before recording profit share', status: 400 }
    }

    const profitShareStatus = await getEquityProfitShareStatus(investor)
    if (profitShareStatus.principalInvested <= 0) {
      return {
        error: 'Profit share can only be recorded after investor capital has actually been paid into the site.',
        status: 400,
      }
    }

    if (profitShareStatus.hasOpenProfitShare) {
      return {
        error: 'A profit share payout is already pending for this investor. Use the existing partial row to record the remaining payment.',
        status: 400,
      }
    }

    if (amount > profitShareStatus.availableToRecord) {
      return {
        error: `Profit payout (${amount}) exceeds available profit share to record (${profitShareStatus.availableToRecord})`,
        status: 400,
      }
    }
  }

  const transactionId = await prisma.$transaction(
    async (tx) => {
      return createInvestorTransactionDocumentWithLedger(tx, {
        companyId: company.id,
        investor,
        kind: 'INTEREST',
        amount,
        amountPaid,
        note: note ?? (investor.type === 'EQUITY' ? 'Profit share payout' : 'Interest payment'),
        paymentDate,
        idempotencyKey,
      })
    },
    LEDGER_TX_OPTIONS,
  )

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const [view, transaction] = await Promise.all([getInvestorView(investor.id), getTransactionView(transactionId)])
  if (!view || !transaction) return null

  return {
    transaction,
    investor: view.investor,
  }
}

export async function getTransactionsForUser(investorId: string, userId: string) {
  const { investor } = await getInvestorForUser(investorId, userId)
  if (!investor) return null

  const cacheKey = CacheKeys.investorTransactions(investorId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const view = await getInvestorView(investorId)
  if (!view) return null

  const responseData = {
    transactions: view.transactions,
    totalInvested: view.investor.totalInvested,
    totalReturned: view.investor.totalReturned,
    interestPaid: view.investor.interestPaid,
    outstandingPrincipal: view.investor.outstandingPrincipal,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function updateTransactionPaymentForUser(
  investorId: string,
  transactionId: string,
  userId: string,
  data: { amount: number; note?: string; idempotencyKey?: string },
): Promise<
  | {
      transaction: {
        id: string
        kind: InvestorTransactionKind
        amountPaid: number
        remaining: number
        paymentStatus: 'PENDING' | 'PARTIAL' | 'COMPLETED'
      }
      payment: { id: string; amount: number; createdAt: Date }
    }
  | InvestorServiceError
  | null
> {
  const { investor, company } = await getInvestorForUser(investorId, userId)
  if (!investor || !company) return null

  const transaction = await prisma.investorTransaction.findFirst({
    where: { id: transactionId, investorId: investor.id, isDeleted: false },
  })
  if (!transaction) return { error: 'Transaction not found', status: 404 }

  const currentPaid = await getInvestorTransactionPaidTotal(transactionId)
  const newTotal = currentPaid + data.amount
  if (newTotal > transaction.amount) return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }

  const ledgerConfig = resolveLedgerConfig(investor, transaction.kind)

  const result = await prisma.$transaction(
    async (tx) => {
      const payment = await createLedgerEntry(
        {
          companyId: company.id,
          siteId: ledgerConfig.siteId,
          walletType: ledgerConfig.walletType,
          direction: ledgerConfig.direction,
          movementType: ledgerConfig.movementType,
          amount: new Prisma.Decimal(data.amount),
          idempotencyKey: data.idempotencyKey ?? `investor-payment:${transactionId}:${Date.now()}`,
          note: data.note ?? getDefaultLedgerNote(transaction.kind, investor.type),
          investorTransactionId: transactionId,
        },
        tx,
      )

      await syncInvestorClosedState(investor.id, tx)

      const amountPaid = await getInvestorTransactionPaidTotal(transactionId, tx)
      const remaining = await getInvestorTransactionRemaining(transactionId, tx)
      const paymentStatus = deriveInvestorTransactionPaymentStatus(transaction.amount, amountPaid)

      return { payment, amountPaid, remaining, paymentStatus }
    },
    LEDGER_TX_OPTIONS,
  )

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return {
    transaction: {
      id: transaction.id,
      kind: transaction.kind,
      amountPaid: result.amountPaid,
      remaining: result.remaining,
      paymentStatus: result.paymentStatus,
    },
    payment: {
      id: result.payment.id,
      amount: Number(result.payment.amount),
      createdAt: result.payment.postedAt,
    },
  }
}

export async function getTransactionPaymentsForUser(
  investorId: string,
  transactionId: string,
  userId: string,
): Promise<{ payments: Array<{ id: string; amount: number; note: string | null; createdAt: Date }> } | InvestorServiceError | null> {
  const { investor, company } = await getInvestorForUser(investorId, userId)
  if (!investor || !company) return null

  const transaction = await prisma.investorTransaction.findFirst({
    where: { id: transactionId, investorId: investor.id, isDeleted: false },
  })
  if (!transaction) return { error: 'Transaction not found', status: 404 }

  const payments = await prisma.payment.findMany({
    where: {
      companyId: company.id,
      investorTransactionId: transactionId,
    },
    orderBy: { postedAt: 'desc' },
  })

  return {
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      note: payment.note,
      createdAt: payment.postedAt,
    })),
  }
}
