import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import {
  buildVendorStatement,
  getVendorExpenseRecords,
  mapVendorBills,
  mapVendorPayments,
  summarizeVendorRecords,
} from '../../services/vendor-accounting.service.js'
import { mapVendorSummary } from './vendors.mapper.js'
import { getVendorForUser, isVendorServiceError, type VendorServiceError } from './vendors.service.js'

type VendorAccountingContext = {
  company: NonNullable<Awaited<ReturnType<typeof getVendorForUser>>['company']>
  vendor: NonNullable<Awaited<ReturnType<typeof getVendorForUser>>['vendor']>
}

async function getVendorAccountingContext(
  vendorId: string,
  userId: string,
): Promise<VendorAccountingContext | VendorServiceError> {
  const context = await getVendorForUser(vendorId, userId)
  if (!context.company) return { error: 'No company found', status: 404 as const }
  if (!context.vendor) return { error: 'Vendor not found', status: 404 as const }

  return { company: context.company, vendor: context.vendor }
}

export async function getVendorSummaryForUser(vendorId: string, userId: string) {
  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  const cacheKey = CacheKeys.vendorDetail(vendorId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const summary = summarizeVendorRecords(expenses)

  const responseData = {
    vendor: mapVendorSummary(context.vendor, summary),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}

export async function getVendorTransactionsForUser(vendorId: string, userId: string) {
  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  const cacheKey = CacheKeys.vendorTransactions(vendorId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const summary = summarizeVendorRecords(expenses)

  const responseData = {
    transactions: mapVendorBills(expenses),
    totalBilled: summary.totalBilled,
    totalPaid: summary.totalPaid,
    totalOutstanding: summary.totalOutstanding,
    billCount: summary.billCount,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function getVendorPaymentsForUser(vendorId: string, userId: string) {
  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  const cacheKey = CacheKeys.vendorPayments(vendorId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const payments = mapVendorPayments(expenses)

  const responseData = {
    payments,
    totalPaid: payments.reduce((sum, payment) => sum + payment.amount, 0),
    paymentCount: payments.length,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function getVendorStatementForUser(vendorId: string, userId: string) {
  const context = await getVendorAccountingContext(vendorId, userId)
  if (isVendorServiceError(context)) return context

  const cacheKey = CacheKeys.vendorStatement(vendorId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const expenses = await getVendorExpenseRecords(context.vendor.id)
  const responseData = buildVendorStatement(expenses)

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}
