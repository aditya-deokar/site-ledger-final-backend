import { cacheService } from './cache.service.js'
import { CacheKeys } from '../config/cache-keys.js'

// ── Partner mutations (add/update/delete partner) ──────

export async function invalidatePartnerCaches(companyId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.partnerList(companyId)),
    cacheService.del(CacheKeys.companyPartnerFund(companyId)),
    cacheService.del(CacheKeys.companyTotalFund(companyId)),
    cacheService.del(CacheKeys.companyAvailableFund(companyId)),
    cacheService.del(CacheKeys.companyDetails(companyId)),
  ])
}

// ── Site fund mutations (allocate/withdraw fund to site) ──

export async function invalidateSiteFundCaches(companyId: string, siteId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.sitePartnerAllocated(siteId)),
    cacheService.del(CacheKeys.siteWithdrawn(siteId)),
    cacheService.del(CacheKeys.siteAllocated(siteId)),
    cacheService.del(CacheKeys.siteRemaining(siteId)),
    cacheService.del(CacheKeys.siteDetail(siteId)),
    cacheService.del(CacheKeys.siteFundHistory(siteId)),
    cacheService.del(CacheKeys.companyAllocated(companyId)),
    cacheService.del(CacheKeys.companyAvailableFund(companyId)),
    cacheService.del(CacheKeys.companyDetails(companyId)),
    cacheService.delByPattern(`${CacheKeys.siteList(companyId)}:*`),
    cacheService.delByPattern(`${CacheKeys.activityFeed(companyId)}:*`),
  ])
}

// ── Expense mutations (record expense) ────────────────

export async function invalidateExpenseCaches(companyId: string, siteId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.siteExpenses(siteId)),
    cacheService.del(CacheKeys.siteRemaining(siteId)),
    cacheService.del(CacheKeys.siteDetail(siteId)),
    cacheService.del(CacheKeys.siteExpenseSummary(siteId)),
    cacheService.del(CacheKeys.siteExpenseList(siteId)),
    cacheService.delByPattern(`${CacheKeys.companyExpenses(companyId)}:*`),
    cacheService.delByPattern(`${CacheKeys.siteList(companyId)}:*`),
    cacheService.delByPattern(`${CacheKeys.activityFeed(companyId)}:*`),
  ])
}

// ── Customer mutations (book/update/cancel) ───────────

export async function invalidateCustomerCaches(companyId: string, siteId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.siteCustomerPayments(siteId)),
    cacheService.del(CacheKeys.siteRemaining(siteId)),
    cacheService.del(CacheKeys.siteDetail(siteId)),
    cacheService.del(CacheKeys.siteFloors(siteId)),
    cacheService.del(CacheKeys.siteCustomers(siteId)),
    cacheService.delByPattern(`${CacheKeys.customerList(companyId)}:*`),
    cacheService.delByPattern(`${CacheKeys.siteList(companyId)}:*`),
  ])
}

// ── Investor mutations (create/delete/transaction/return/interest) ──

export async function invalidateInvestorCaches(companyId: string, siteId?: string | null) {
  const keys: Promise<void>[] = [
    cacheService.delByPattern(`${CacheKeys.investorList(companyId)}:*`),
    cacheService.del(CacheKeys.companyInvestorFund(companyId)),
    cacheService.del(CacheKeys.companyFixedRateReturned(companyId)),
    cacheService.del(CacheKeys.companyTotalFund(companyId)),
    cacheService.del(CacheKeys.companyAvailableFund(companyId)),
    cacheService.del(CacheKeys.companyDetails(companyId)),
    cacheService.delByPattern(`${CacheKeys.activityFeed(companyId)}:*`),
  ]

  if (siteId) {
    keys.push(
      cacheService.del(CacheKeys.siteEquityInvestorFund(siteId)),
      cacheService.del(CacheKeys.siteEquityReturned(siteId)),
      cacheService.del(CacheKeys.siteAllocated(siteId)),
      cacheService.del(CacheKeys.siteRemaining(siteId)),
      cacheService.del(CacheKeys.siteDetail(siteId)),
      cacheService.del(CacheKeys.siteInvestors(siteId)),
      cacheService.delByPattern(`${CacheKeys.siteList(companyId)}:*`),
    )
  }

  await Promise.all(keys)
}

// Invalidate specific investor detail/transactions (for update endpoint)
export async function invalidateInvestorDetailCaches(investorId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.investorDetail(investorId)),
    cacheService.del(CacheKeys.investorTransactions(investorId)),
  ])
}

// ── Company withdrawal mutations ──────────────────────

export async function invalidateWithdrawalCaches(companyId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.companyWithdrawals(companyId)),
    cacheService.del(CacheKeys.companyAvailableFund(companyId)),
    cacheService.del(CacheKeys.companyDetails(companyId)),
    cacheService.delByPattern(`${CacheKeys.activityFeed(companyId)}:*`),
  ])
}

// ── Vendor mutations (create/update/delete) ───────────

export async function invalidateVendorCaches(companyId: string, vendorId?: string) {
  const keys: Promise<void>[] = [
    cacheService.delByPattern(`${CacheKeys.vendorList(companyId)}:*`),
  ]
  if (vendorId) {
    keys.push(
      cacheService.del(CacheKeys.vendorDetail(vendorId)),
      cacheService.del(CacheKeys.vendorTransactions(vendorId)),
    )
  }
  await Promise.all(keys)
}

// ── Site mutations (create/update/delete/archive) ─────

export async function invalidateSiteListCaches(companyId: string) {
  await cacheService.delByPattern(`${CacheKeys.siteList(companyId)}:*`)
}

// ── Company mutations (update/delete) ─────────────────

export async function invalidateCompanyCaches(companyId: string, userId: string) {
  await Promise.all([
    cacheService.del(CacheKeys.companyByUser(userId)),
    cacheService.del(CacheKeys.companyDetails(companyId)),
  ])
}
