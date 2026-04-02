import { prisma } from '../db/prisma.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

// ── Company Fund Helpers ──────────────────────────────

export async function getCompanyPartnerFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyPartnerFund(companyId))
  if (cached !== null) return cached

  const result = await prisma.partner.aggregate({
    where: { companyId },
    _sum: { investmentAmount: true },
  })
  const value = result._sum?.investmentAmount ?? 0
  await cacheService.set(CacheKeys.companyPartnerFund(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Fixed-rate investor principal (what they invested, not reduced by interest)
export async function getCompanyFixedRateInvestorFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyInvestorFund(companyId))
  if (cached !== null) return cached

  const result = await prisma.investor.aggregate({
    where: { companyId, type: 'FIXED_RATE', isDeleted: false },
    _sum: { totalInvested: true },
  })
  const value = result._sum.totalInvested ?? 0
  await cacheService.set(CacheKeys.companyInvestorFund(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Total money returned to fixed-rate investors (interest + principal returns)
export async function getCompanyFixedRateReturned(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyFixedRateReturned(companyId))
  if (cached !== null) return cached

  const result = await prisma.investor.aggregate({
    where: { companyId, type: 'FIXED_RATE', isDeleted: false },
    _sum: { totalReturned: true },
  })
  const value = result._sum.totalReturned ?? 0
  await cacheService.set(CacheKeys.companyFixedRateReturned(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Total fund = partner investments + fixed-rate investor principal
export async function getCompanyTotalFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyTotalFund(companyId))
  if (cached !== null) return cached

  const [partnerFund, investorFund] = await Promise.all([
    getCompanyPartnerFund(companyId),
    getCompanyFixedRateInvestorFund(companyId),
  ])
  const value = partnerFund + investorFund
  await cacheService.set(CacheKeys.companyTotalFund(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Partner allocations to sites (site_funds table)
export async function getTotalAllocatedFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyAllocated(companyId))
  if (cached !== null) return cached

  const result = await prisma.siteFund.aggregate({
    where: { site: { companyId } },
    _sum: { amount: true },
  })
  const value = result._sum?.amount ?? 0
  await cacheService.set(CacheKeys.companyAllocated(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Total company withdrawals (owner payouts, operational expenses)
export async function getCompanyTotalWithdrawals(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyWithdrawals(companyId))
  if (cached !== null) return cached

  const result = await prisma.companyWithdrawal.aggregate({
    where: { companyId, isDeleted: false },
    _sum: { amount: true },
  })
  const value = result._sum.amount ?? 0
  await cacheService.set(CacheKeys.companyWithdrawals(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// available = (partner fund + fixed-rate invested - fixed-rate returned) - site allocations - withdrawals
export async function getCompanyAvailableFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyAvailableFund(companyId))
  if (cached !== null) return cached

  const [partnerFund, investorFund, investorReturned, allocated, withdrawn] = await Promise.all([
    getCompanyPartnerFund(companyId),
    getCompanyFixedRateInvestorFund(companyId),
    getCompanyFixedRateReturned(companyId),
    getTotalAllocatedFund(companyId),
    getCompanyTotalWithdrawals(companyId),
  ])
  const value = partnerFund + investorFund - investorReturned - allocated - withdrawn
  await cacheService.set(CacheKeys.companyAvailableFund(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// ── Site Fund Helpers ─────────────────────────────────

// Partner allocations to this specific site (only positive entries = money in)
export async function getSitePartnerAllocatedFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.sitePartnerAllocated(siteId))
  if (cached !== null) return cached

  const result = await prisma.siteFund.aggregate({
    where: { siteId, amount: { gt: 0 } },
    _sum: { amount: true },
  })
  const value = result._sum.amount ?? 0
  await cacheService.set(CacheKeys.sitePartnerAllocated(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Fund pulled back from site to company (negative SiteFund entries)
export async function getSiteWithdrawnFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteWithdrawn(siteId))
  if (cached !== null) return cached

  const result = await prisma.siteFund.aggregate({
    where: { siteId, amount: { lt: 0 } },
    _sum: { amount: true },
  })
  const value = Math.abs(result._sum.amount ?? 0)
  await cacheService.set(CacheKeys.siteWithdrawn(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Equity investor principal invested in this site (not reduced by profit returns)
export async function getSiteEquityInvestorFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteEquityInvestorFund(siteId))
  if (cached !== null) return cached

  const result = await prisma.investor.aggregate({
    where: { siteId, type: 'EQUITY', isDeleted: false },
    _sum: { totalInvested: true },
  })
  const value = result._sum.totalInvested ?? 0
  await cacheService.set(CacheKeys.siteEquityInvestorFund(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Total allocated = partner allocations + equity investor money
export async function getSiteAllocatedFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteAllocated(siteId))
  if (cached !== null) return cached

  const [partnerFund, investorFund] = await Promise.all([
    getSitePartnerAllocatedFund(siteId),
    getSiteEquityInvestorFund(siteId),
  ])
  const value = partnerFund + investorFund
  await cacheService.set(CacheKeys.siteAllocated(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Actual cash spent on expenses (for remaining fund calculation)
export async function getSiteTotalExpenses(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteExpenses(siteId))
  if (cached !== null) return cached

  const result = await prisma.expense.aggregate({
    where: { siteId, isDeleted: false },
    _sum: { amountPaid: true },
  })
  const value = result._sum.amountPaid ?? 0
  await cacheService.set(CacheKeys.siteExpenses(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Total billed amount (for display — what's been invoiced)
export async function getSiteTotalExpensesBilled(siteId: string): Promise<number> {
  const result = await prisma.expense.aggregate({
    where: { siteId, isDeleted: false },
    _sum: { amount: true },
  })
  return result._sum.amount ?? 0
}

export async function getSiteCustomerPayments(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteCustomerPayments(siteId))
  if (cached !== null) return cached

  const result = await prisma.customer.aggregate({
    where: { siteId, isDeleted: false },
    _sum: { amountPaid: true },
  })
  const value = result._sum.amountPaid ?? 0
  await cacheService.set(CacheKeys.siteCustomerPayments(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

// Total money returned to equity investors for this site (profit payouts)
export async function getSiteEquityReturned(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteEquityReturned(siteId))
  if (cached !== null) return cached

  const result = await prisma.investor.aggregate({
    where: { siteId, type: 'EQUITY', isDeleted: false },
    _sum: { totalReturned: true },
  })
  const value = result._sum.totalReturned ?? 0
  await cacheService.set(CacheKeys.siteEquityReturned(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getSiteRemainingFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteRemaining(siteId))
  if (cached !== null) return cached

  const [allocated, withdrawn, expenses, customerPayments, equityReturned] = await Promise.all([
    getSiteAllocatedFund(siteId),
    getSiteWithdrawnFund(siteId),
    getSiteTotalExpenses(siteId),
    getSiteCustomerPayments(siteId),
    getSiteEquityReturned(siteId),
  ])
  const value = allocated - withdrawn - expenses + customerPayments - equityReturned
  await cacheService.set(CacheKeys.siteRemaining(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}
