import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getSiteTotalExpenses } from '../../utils/ledger-fund.js'
import {
  deriveExpensePaymentStatus,
  getExpensePaidTotal,
  getExpenseRemaining,
  getSiteLedgerNetCash,
} from '../../services/expense-ledger.service.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import { invalidateExpenseCaches, invalidateVendorCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { getSiteForUser } from './site-access.service.js'
import { mapExpensePayment, mapSiteExpense } from './site-expenses.mapper.js'

export async function getExpensesForUser(siteId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const cacheKey = CacheKeys.siteExpenseList(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const expenses = await prisma.expense.findMany({
    where: { siteId: site.id, isDeleted: false },
    include: {
      vendor: { select: { id: true, name: true, type: true } },
      ledgerEntries: {
        select: { amount: true, direction: true, postedAt: true },
        orderBy: { postedAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    expenses: expenses.map(mapSiteExpense),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function getExpensesSummaryForUser(siteId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const cacheKey = CacheKeys.siteExpenseSummary(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const [totalExpenses, breakdown] = await Promise.all([
    getSiteTotalExpenses(site.id),
    prisma.expense.groupBy({
      by: ['type'],
      where: { siteId: site.id, isDeleted: false },
      _sum: { amount: true },
    }),
  ])

  const responseData = {
    totalExpenses,
    breakdown: breakdown.map((item) => ({
      type: item.type,
      total: item._sum.amount ?? 0,
    })),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_DETAIL)
  return responseData
}

export async function createExpenseForUser(
  siteId: string,
  userId: string,
  data: {
    type: 'GENERAL' | 'VENDOR'
    reason?: string
    vendorId?: string
    description?: string
    amount: number
    amountPaid?: number
    paymentDate?: string
    idempotencyKey?: string
  },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const { type, reason, vendorId, description, amount, amountPaid = 0, paymentDate, idempotencyKey } = data

  if (type === 'VENDOR') {
    if (!vendorId) return { error: 'vendorId is required for vendor expenses', status: 400 as const }
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, companyId: company.id },
    })
    if (!vendor) return { error: 'Vendor not found', status: 404 as const }
  }

  if (amountPaid > amount) {
    return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 as const }
  }

  const result = await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        siteId: site.id,
        type,
        reason: type === 'GENERAL' ? reason : null,
        vendorId: type === 'VENDOR' ? vendorId : null,
        description: type === 'VENDOR' ? description : null,
        amount,
      },
    })

    let initialPaymentDate: string | null = null
    if (amountPaid > 0) {
      const payment = await createLedgerEntry({
        companyId: company.id,
        siteId: site.id,
        walletType: 'SITE',
        direction: 'OUT',
        movementType: 'EXPENSE_PAYMENT',
        amount: new Prisma.Decimal(amountPaid),
        idempotencyKey: idempotencyKey ?? `expense-create:${expense.id}:${Date.now()}`,
        postedAt: paymentDate ? new Date(paymentDate) : undefined,
        note: 'Initial payment upon recording expense',
        expenseId: expense.id,
      }, tx)
      initialPaymentDate = payment.postedAt.toISOString()
    }

    const paidTotal = await getExpensePaidTotal(expense.id, tx)
    const remaining = await getExpenseRemaining(expense.id, tx)
    const paymentStatus = deriveExpensePaymentStatus(paidTotal, expense.amount)
    const siteRemainingFund = await getSiteLedgerNetCash(site.id, tx)

    return { expense, paidTotal, remaining, paymentStatus, paymentDate: initialPaymentDate, siteRemainingFund }
  }, LEDGER_TX_OPTIONS)

  const expense = result.expense
  await invalidateExpenseCaches(company.id, site.id)
  if (expense.vendorId) {
    await invalidateVendorCaches(company.id, expense.vendorId)
  }

  return {
    expense: {
      id: expense.id,
      type: expense.type,
      reason: expense.reason,
      vendorId: expense.vendorId,
      description: expense.description,
      amount: expense.amount,
      amountPaid: result.paidTotal,
      remaining: result.remaining,
      paymentDate: result.paymentDate,
      paymentStatus: result.paymentStatus,
      createdAt: expense.createdAt.toISOString(),
    },
    siteRemainingFund: result.siteRemainingFund,
  }
}

export async function updateExpensePaymentForUser(
  siteId: string,
  expenseId: string,
  userId: string,
  data: { amount: number; note?: string; idempotencyKey?: string },
) {
  const { site, company } = await getSiteForUser(siteId, userId)
  if (!site || !company) return null

  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, siteId: site.id, isDeleted: false },
  })
  if (!expense) return { error: 'Expense not found', status: 404 as const }

  const currentPaid = await getExpensePaidTotal(expenseId)
  const newTotal = currentPaid + data.amount
  if (newTotal > expense.amount) {
    return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 as const }
  }

  const result = await prisma.$transaction(async (tx: any) => {
    const payment = await createLedgerEntry({
      companyId: company.id,
      siteId: site.id,
      walletType: 'SITE',
      direction: 'OUT',
      movementType: 'EXPENSE_PAYMENT',
      amount: new Prisma.Decimal(data.amount),
      idempotencyKey: data.idempotencyKey ?? `expense-payment:${expenseId}:${Date.now()}`,
      note: data.note || 'Payment for expense',
      expenseId,
    }, tx)

    const amountPaid = await getExpensePaidTotal(expenseId, tx)
    const remaining = await getExpenseRemaining(expenseId, tx)
    const paymentStatus = deriveExpensePaymentStatus(amountPaid, expense.amount)

    return { payment, amountPaid, remaining, paymentStatus }
  }, LEDGER_TX_OPTIONS)

  await invalidateExpenseCaches(company.id, site.id)
  if (expense.vendorId) {
    await invalidateVendorCaches(company.id, expense.vendorId)
  }

  return {
    expense: {
      id: expense.id,
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

export async function getExpensePaymentsForUser(siteId: string, expenseId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const payments = await prisma.payment.findMany({
    where: { expenseId, siteId: site.id, companyId: site.companyId },
    orderBy: { postedAt: 'desc' },
    select: {
      id: true,
      amount: true,
      direction: true,
      movementType: true,
      note: true,
      postedAt: true,
      reversalOfPaymentId: true,
    },
  })

  return {
    payments: payments.map(mapExpensePayment),
  }
}

export async function deleteExpenseForUser(siteId: string, expenseId: string, userId: string) {
  const { site, company } = await getSiteForUser(siteId, userId)
  if (!site || !company) return null

  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, siteId: site.id, isDeleted: false },
  })
  if (!expense) return { error: 'Expense not found', status: 404 as const }

  const paidTotal = await getExpensePaidTotal(expenseId)
  if (paidTotal > 0) {
    return {
      error: 'Cannot delete an expense with recorded payments. Record a reversal instead.',
      status: 400 as const,
    }
  }

  await prisma.expense.update({ where: { id: expenseId }, data: { isDeleted: true } })
  await invalidateExpenseCaches(company.id, site.id)
  if (expense.vendorId) {
    await invalidateVendorCaches(company.id, expense.vendorId)
  }

  return { message: 'Expense removed' }
}
