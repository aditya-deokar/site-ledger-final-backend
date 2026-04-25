import { prisma } from '../db/prisma.js'
import { cacheService } from '../services/cache.service.js'
import { getCompanyBalance, getSiteBalance } from '../services/ledger-read.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

async function getLedgerWalletBalance(
  where: Parameters<typeof prisma.payment.aggregate>[0]['where'],
): Promise<number> {
  const [incoming, outgoing] = await Promise.all([
    prisma.payment.aggregate({
      where: { ...where, direction: 'IN' },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { ...where, direction: 'OUT' },
      _sum: { amount: true },
    }),
  ])

  return Number(incoming._sum.amount ?? 0) - Number(outgoing._sum.amount ?? 0)
}

async function getNetDocumentTotal(
  where: Parameters<typeof prisma.payment.aggregate>[0]['where'],
  primaryDirection: 'IN' | 'OUT',
): Promise<number> {
  const directionalBalance = await getLedgerWalletBalance(where)
  return primaryDirection === 'IN' ? directionalBalance : -directionalBalance
}

export async function getCompanyPartnerFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyPartnerFund(companyId))
  if (cached !== null) return cached

  const value = await getLedgerWalletBalance({
    companyId,
    walletType: 'COMPANY',
    partnerId: { not: null },
  })
  await cacheService.set(CacheKeys.companyPartnerFund(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getCompanyFixedRateInvestorFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyInvestorFund(companyId))
  if (cached !== null) return cached

  const value = await getNetDocumentTotal({
    companyId,
    walletType: 'COMPANY',
    investorTransaction: {
      investor: { companyId, type: 'FIXED_RATE', isDeleted: false },
      isDeleted: false,
      kind: 'PRINCIPAL_IN',
    },
  }, 'IN')
  await cacheService.set(CacheKeys.companyInvestorFund(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getCompanyFixedRateReturned(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyFixedRateReturned(companyId))
  if (cached !== null) return cached

  const value = await getNetDocumentTotal({
    companyId,
    walletType: 'COMPANY',
    investorTransaction: {
      investor: { companyId, type: 'FIXED_RATE', isDeleted: false },
      isDeleted: false,
      kind: { in: ['PRINCIPAL_OUT', 'INTEREST'] },
    },
  }, 'OUT')
  await cacheService.set(CacheKeys.companyFixedRateReturned(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

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

export async function getTotalAllocatedFund(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyAllocated(companyId))
  if (cached !== null) return cached

  const allocatedOut = await prisma.payment.aggregate({
    where: {
      companyId,
      walletType: 'COMPANY',
      direction: 'OUT',
      movementType: 'COMPANY_TO_SITE_TRANSFER',
    },
    _sum: { amount: true },
  })

  const value = Number(allocatedOut._sum.amount ?? 0)
  await cacheService.set(CacheKeys.companyAllocated(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getCompanyTotalWithdrawals(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyWithdrawals(companyId))
  if (cached !== null) return cached

  const value = await getNetDocumentTotal({
    companyId,
    walletType: 'COMPANY',
    companyWithdrawal: {
      companyId,
      isDeleted: false,
    },
  }, 'OUT')
  await cacheService.set(CacheKeys.companyWithdrawals(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getCompanyLedgerBalance(companyId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.companyAvailableFund(companyId))
  if (cached !== null) return cached

  const value = await getCompanyBalance(companyId)

  await cacheService.set(CacheKeys.companyAvailableFund(companyId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getCompanyAvailableFund(companyId: string): Promise<number> {
  return getCompanyLedgerBalance(companyId)
}

export async function getSitePartnerAllocatedFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.sitePartnerAllocated(siteId))
  if (cached !== null) return cached

  const incoming = await prisma.payment.aggregate({
    where: {
      siteId,
      walletType: 'SITE',
      direction: 'IN',
      movementType: 'COMPANY_TO_SITE_TRANSFER',
    },
    _sum: { amount: true },
  })

  const value = Number(incoming._sum.amount ?? 0)
  await cacheService.set(CacheKeys.sitePartnerAllocated(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getSiteWithdrawnFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteWithdrawn(siteId))
  if (cached !== null) return cached

  const result = await prisma.payment.aggregate({
    where: {
      siteId,
      walletType: 'SITE',
      direction: 'OUT',
      movementType: 'SITE_TO_COMPANY_TRANSFER',
    },
    _sum: { amount: true },
  })

  const value = Number(result._sum.amount ?? 0)
  await cacheService.set(CacheKeys.siteWithdrawn(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getSiteEquityInvestorFund(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteEquityInvestorFund(siteId))
  if (cached !== null) return cached

  const value = await getNetDocumentTotal({
    siteId,
    walletType: 'SITE',
    investorTransaction: {
      investor: { siteId, type: 'EQUITY', isDeleted: false },
      isDeleted: false,
      kind: 'PRINCIPAL_IN',
    },
  }, 'IN')
  await cacheService.set(CacheKeys.siteEquityInvestorFund(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

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

export async function getSiteTotalExpenses(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteExpenses(siteId))
  if (cached !== null) return cached

  const value = await getNetDocumentTotal({
    siteId,
    walletType: 'SITE',
    expense: { siteId, isDeleted: false },
  }, 'OUT')
  await cacheService.set(CacheKeys.siteExpenses(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

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

  const value = await getLedgerWalletBalance({
    siteId,
    walletType: 'SITE',
    customer: { siteId },
  })

  await cacheService.set(CacheKeys.siteCustomerPayments(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getSiteEquityReturned(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteEquityReturned(siteId))
  if (cached !== null) return cached

  const value = await getNetDocumentTotal({
    siteId,
    walletType: 'SITE',
    investorTransaction: {
      investor: { siteId, type: 'EQUITY', isDeleted: false },
      isDeleted: false,
      kind: { in: ['PRINCIPAL_OUT', 'INTEREST'] },
    },
  }, 'OUT')
  await cacheService.set(CacheKeys.siteEquityReturned(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getSiteLedgerBalance(siteId: string): Promise<number> {
  const cached = await cacheService.get<number>(CacheKeys.siteRemaining(siteId))
  if (cached !== null) return cached

  const value = await getSiteBalance(siteId)

  await cacheService.set(CacheKeys.siteRemaining(siteId), value, CacheTTL.FUND_CALCULATIONS)
  return value
}

export async function getSiteRemainingFund(siteId: string): Promise<number> {
  return getSiteLedgerBalance(siteId)
}
