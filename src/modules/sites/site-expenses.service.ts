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
import { createVendorReceiptForPayment } from '../../services/receipt.service.js'
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
    billNumber?: string
    billDate?: string
    dueDate?: string
    amount: number
    amountPaid?: number
    paymentDate?: string
    paymentMode?: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI'
    referenceNumber?: string
    note?: string
    idempotencyKey?: string
  },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const {
    type,
    reason,
    vendorId,
    description,
    billNumber,
    billDate,
    dueDate,
    amount,
    amountPaid = 0,
    paymentDate,
    paymentMode,
    referenceNumber,
    note,
    idempotencyKey,
  } = data

  let vendor:
    | {
        id: string
        status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'ARCHIVED'
        paymentTermsDays: number | null
      }
    | null = null
  let assignment:
    | {
        status: 'ACTIVE' | 'INACTIVE'
        paymentTermsDaysOverride: number | null
      }
    | null = null

  if (type === 'VENDOR') {
    if (!vendorId) return { error: 'vendorId is required for vendor expenses', status: 400 as const }
    vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, companyId: company.id },
      select: {
        id: true,
        status: true,
        paymentTermsDays: true,
      },
    })
    if (!vendor) return { error: 'Vendor not found', status: 404 as const }
    if (vendor.status !== 'ACTIVE') {
      return { error: 'This vendor is not active for new bills', status: 400 as const }
    }

    assignment = await prisma.vendorSiteAssignment.findUnique({
      where: {
        vendorId_siteId: {
          vendorId: vendor.id,
          siteId: site.id,
        },
      },
      select: {
        status: true,
        paymentTermsDaysOverride: true,
      },
    })

    if (assignment && assignment.status !== 'ACTIVE') {
      return { error: 'This vendor is not active for the selected site', status: 400 as const }
    }
  }

  if (amountPaid > amount) {
    return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 as const }
  }

  const resolvedBillDate = type === 'VENDOR'
    ? (billDate ? new Date(billDate) : new Date())
    : null
  const resolvedDueDate = type === 'VENDOR'
    ? (
        dueDate
          ? new Date(dueDate)
          : new Date(
              (resolvedBillDate ?? new Date()).getTime()
              + (((assignment?.paymentTermsDaysOverride ?? vendor?.paymentTermsDays ?? 0) || 0) * 86400000),
            )
      )
    : null

  const result = await prisma.$transaction(async (tx) => {
    if (type === 'VENDOR' && vendorId && !assignment) {
      await tx.vendorSiteAssignment.upsert({
        where: {
          vendorId_siteId: {
            vendorId,
            siteId: site.id,
          },
        },
        update: {
          status: 'ACTIVE',
        },
        create: {
          vendorId,
          siteId: site.id,
          status: 'ACTIVE',
          isPreferred: false,
        },
      })
    }

    const expense = await tx.expense.create({
      data: {
        siteId: site.id,
        type,
        reason: type === 'GENERAL' ? reason : null,
        vendorId: type === 'VENDOR' ? vendorId : null,
        description: type === 'VENDOR' ? description : null,
        billNumber: type === 'VENDOR' ? billNumber?.trim() || null : null,
        billDate: type === 'VENDOR' ? resolvedBillDate : null,
        dueDate: type === 'VENDOR' ? resolvedDueDate : null,
        amount,
      },
    })

    let initialPaymentDate: string | null = null
    let initialPayment: Awaited<ReturnType<typeof createLedgerEntry>> | null = null
    let receipt:
      | {
          id: string
          receiptNumber: string
          status: 'ACTIVE' | 'VOIDED'
          createdAt: string
        }
      | null = null
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
        note: note || 'Initial payment upon recording expense',
        paymentMode,
        referenceNumber: referenceNumber?.trim() || undefined,
        expenseId: expense.id,
      }, tx)
      initialPayment = payment
      initialPaymentDate = payment.postedAt.toISOString()

      if (expense.vendorId) {
        const createdReceipt = await createVendorReceiptForPayment(payment.id, userId, tx)
        receipt = {
          id: createdReceipt.id,
          receiptNumber: createdReceipt.receiptNumber,
          status: createdReceipt.status,
          createdAt: createdReceipt.createdAt.toISOString(),
        }
      }
    }

    const paidTotal = await getExpensePaidTotal(expense.id, tx)
    const remaining = await getExpenseRemaining(expense.id, tx)
    const paymentStatus = deriveExpensePaymentStatus(paidTotal, expense.amount)
    const siteRemainingFund = await getSiteLedgerNetCash(site.id, tx)

    return {
      expense,
      initialPayment,
      receipt,
      paidTotal,
      remaining,
      paymentStatus,
      paymentDate: initialPaymentDate,
      siteRemainingFund,
    }
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
      billNumber: expense.billNumber,
      billDate: (expense.billDate ?? expense.createdAt).toISOString(),
      dueDate: (expense.dueDate ?? expense.billDate ?? expense.createdAt).toISOString(),
      amount: expense.amount,
      amountPaid: result.paidTotal,
      remaining: result.remaining,
      paymentDate: result.paymentDate,
      paymentStatus: result.paymentStatus,
      createdAt: expense.createdAt.toISOString(),
    },
    payment: result.initialPayment
      ? {
          id: result.initialPayment.id,
          amount: Number(result.initialPayment.amount),
          paymentMode: result.initialPayment.paymentMode,
          referenceNumber: result.initialPayment.referenceNumber,
          createdAt: result.initialPayment.postedAt.toISOString(),
        }
      : null,
    receipt: result.receipt,
    siteRemainingFund: result.siteRemainingFund,
  }
}

export async function updateExpensePaymentForUser(
  siteId: string,
  expenseId: string,
  userId: string,
  data: {
    amount: number
    note?: string
    paymentMode?: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI'
    referenceNumber?: string
    paymentDate?: string
    idempotencyKey?: string
  },
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
      paymentMode: data.paymentMode,
      referenceNumber: data.referenceNumber?.trim() || undefined,
      postedAt: data.paymentDate ? new Date(data.paymentDate) : undefined,
      expenseId,
    }, tx)

    const receipt = expense.vendorId
      ? await createVendorReceiptForPayment(payment.id, userId, tx)
      : null

    const amountPaid = await getExpensePaidTotal(expenseId, tx)
    const remaining = await getExpenseRemaining(expenseId, tx)
    const paymentStatus = deriveExpensePaymentStatus(amountPaid, expense.amount)

    return { payment, receipt, amountPaid, remaining, paymentStatus }
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
      paymentMode: result.payment.paymentMode,
      referenceNumber: result.payment.referenceNumber,
      createdAt: result.payment.postedAt.toISOString(),
    },
    receipt: result.receipt
      ? {
          id: result.receipt.id,
          receiptNumber: result.receipt.receiptNumber,
          status: result.receipt.status,
          createdAt: result.receipt.createdAt.toISOString(),
        }
      : null,
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
      paymentMode: true,
      referenceNumber: true,
      postedAt: true,
      receipt: {
        select: {
          id: true,
          receiptNumber: true,
          status: true,
          createdAt: true,
        },
      },
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
