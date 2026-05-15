import { prisma } from '../../db/prisma.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { cacheService } from '../../services/cache.service.js'
import {
  buildVendorStatement,
  getVendorExpenseRecords,
  mapVendorBills,
  mapVendorPayments,
  mapVendorReceipts,
  summarizeVendorRecords,
} from '../../services/vendor-accounting.service.js'
import { createVendorReceiptForPayment } from '../../services/receipt.service.js'
import { mapVendorSummary } from './vendors.mapper.js'
import {
  getVendorForUser,
  isVendorServiceError,
} from './vendors.service.js'

type PaginationInput = {
  page?: number
  size?: number
}

type VendorAccountingContext = {
  company: NonNullable<Awaited<ReturnType<typeof getVendorForUser>>['company']>
  vendor: NonNullable<Awaited<ReturnType<typeof getVendorForUser>>['vendor']>
}

function buildPagination(total: number, input: PaginationInput = {}) {
  const size = input.size ?? (total > 0 ? total : 1)
  const page = input.page ?? 1
  const totalPages = total === 0 ? 0 : Math.ceil(total / size)
  const start = (page - 1) * size

  return {
    page,
    size,
    total,
    totalPages,
    start,
  }
}

function paginateRows<T>(rows: T[], input: PaginationInput = {}) {
  const pagination = buildPagination(rows.length, input)

  return {
    rows: rows.slice(pagination.start, pagination.start + pagination.size),
    pagination: {
      page: pagination.page,
      size: pagination.size,
      total: pagination.total,
      totalPages: pagination.totalPages,
    },
  }
}

async function getVendorAccountingContext(vendorId: string, userId: string) {
  const context = await getVendorForUser(vendorId, userId)
  if (!context.company) return { error: 'No company found', status: 404 as const }
  if (!context.vendor) return { error: 'Vendor not found', status: 404 as const }
  return {
    company: context.company,
    vendor: context.vendor,
  } satisfies VendorAccountingContext
}

async function ensureVendorReceiptsForVendor(vendorId: string, companyId: string, userId: string) {
  const paymentsMissingReceipts = await prisma.payment.findMany({
    where: {
      companyId,
      movementType: 'EXPENSE_PAYMENT',
      direction: 'OUT',
      receipt: null,
      expense: {
        vendorId,
        isDeleted: false,
      },
    },
    select: {
      id: true,
    },
    orderBy: {
      postedAt: 'asc',
    },
  })

  if (paymentsMissingReceipts.length === 0) return

  await prisma.$transaction(async (tx) => {
    for (const payment of paymentsMissingReceipts) {
      await createVendorReceiptForPayment(payment.id, userId, tx)
    }
  })
}

export async function getVendorSummaryForUser(vendorId: string, userId: string) {
  const cacheKey = CacheKeys.vendorDetail(vendorId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  const [expenses, assignments, documentCount] = await Promise.all([
    getVendorExpenseRecords(context.vendor.id),
    prisma.vendorSiteAssignment.findMany({
      where: { vendorId: context.vendor.id },
      include: {
        site: {
          select: {
            name: true,
          },
        },
      },
      orderBy: [
        { isPreferred: 'desc' },
        { createdAt: 'asc' },
      ],
    }),
    prisma.vendorDocument.count({
      where: { vendorId: context.vendor.id },
    }),
  ])

  const summary = summarizeVendorRecords(expenses, context.vendor.openingBalanceAmount)

  const responseData = {
    vendor: mapVendorSummary(
      context.vendor,
      {
        siteCount: assignments.length,
        documentCount,
        billCount: summary.billCount,
        paymentCount: summary.paymentCount,
        overdueBillCount: summary.overdueBillCount,
        totalBilled: summary.totalBilled,
        totalPaid: summary.totalPaid,
        totalOutstanding: summary.totalOutstanding,
        lastBillDate: summary.lastBillDate,
        lastPaymentDate: summary.lastPaymentDate,
      },
      assignments,
    ),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}

export async function getVendorTransactionsForUser(
  vendorId: string,
  userId: string,
  page?: number,
  size?: number,
) {
  const cacheKey = `${CacheKeys.vendorTransactions(vendorId)}:${page ?? 1}:${size ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const transactions = mapVendorBills(expenses)
  const summary = summarizeVendorRecords(expenses, context.vendor.openingBalanceAmount)
  const paginated = paginateRows(transactions, { page, size })

  const responseData = {
    transactions: paginated.rows,
    totalBilled: summary.totalBilled,
    totalPaid: summary.totalPaid,
    totalOutstanding: summary.totalOutstanding,
    billCount: summary.billCount,
    overdueBillCount: summary.overdueBillCount,
    pagination: paginated.pagination,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}

export async function getVendorPaymentsForUser(
  vendorId: string,
  userId: string,
  page?: number,
  size?: number,
) {
  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  await ensureVendorReceiptsForVendor(context.vendor.id, context.company.id, userId)

  const cacheKey = `${CacheKeys.vendorPayments(vendorId)}:${page ?? 1}:${size ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const payments = mapVendorPayments(expenses)
  const summary = summarizeVendorRecords(expenses, context.vendor.openingBalanceAmount)
  const paginated = paginateRows(payments, { page, size })

  const responseData = {
    payments: paginated.rows,
    totalPaid: summary.totalPaid,
    paymentCount: summary.paymentCount,
    pagination: paginated.pagination,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}

export async function getVendorReceiptsForUser(
  vendorId: string,
  userId: string,
  page?: number,
  size?: number,
) {
  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  await ensureVendorReceiptsForVendor(context.vendor.id, context.company.id, userId)

  const cacheKey = `${CacheKeys.vendorReceipts(vendorId)}:${page ?? 1}:${size ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const receipts = mapVendorReceipts(context.vendor, expenses)
  const paginated = paginateRows(receipts, { page, size })

  const responseData = {
    receipts: paginated.rows,
    pagination: paginated.pagination,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}

export async function getVendorStatementForUser(
  vendorId: string,
  userId: string,
  page?: number,
  size?: number,
) {
  const cacheKey = `${CacheKeys.vendorStatement(vendorId)}:${page ?? 1}:${size ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const statementData = buildVendorStatement(context.vendor, expenses)
  const paginated = paginateRows(statementData.statement, { page, size })

  const responseData = {
    statement: paginated.rows,
    totalBilled: statementData.totalBilled,
    totalPaid: statementData.totalPaid,
    closingBalance: statementData.closingBalance,
    pagination: paginated.pagination,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}
