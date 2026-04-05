import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import {
  getSiteAllocatedFund,
  getSiteTotalExpenses,
  getSiteCustomerPayments,
  getSiteRemainingFund,
  getCompanyAvailableFund,
  getSiteLedgerBalance,
} from '../../utils/ledger-fund.js'
import { LedgerError, createTransferEntries } from '../../services/ledger.service.js'
import { invalidateSiteFundCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { getSiteForUser } from './site-access.service.js'

export async function performSiteTransfer(
  companyId: string,
  siteId: string,
  amount: number,
  direction: 'COMPANY_TO_SITE' | 'SITE_TO_COMPANY',
  note?: string,
  idempotencyKey?: string,
) {
  if (direction === 'COMPANY_TO_SITE') {
    const availableFund = await getCompanyAvailableFund(companyId)
    if (amount > availableFund) {
      throw new LedgerError('INSUFFICIENT_FUNDS')
    }
  } else {
    const siteBalance = await getSiteLedgerBalance(siteId)
    if (amount > siteBalance) {
      throw new LedgerError('INSUFFICIENT_FUNDS')
    }
  }

  const transfer = await prisma.$transaction(async (tx) => {
    return createTransferEntries({
      companyId,
      siteId,
      amount: new Prisma.Decimal(amount),
      direction,
      idempotencyKey,
      note,
    }, tx)
  }, LEDGER_TX_OPTIONS)

  await invalidateSiteFundCaches(companyId, siteId)

  const [companyAvailableFund, siteBalance, siteAllocatedFund] = await Promise.all([
    getCompanyAvailableFund(companyId),
    getSiteRemainingFund(siteId),
    getSiteAllocatedFund(siteId),
  ])

  return {
    transfer,
    companyAvailableFund,
    siteBalance,
    siteAllocatedFund,
  }
}

export async function allocateFundForUser(
  siteId: string,
  userId: string,
  data: { amount: number; note?: string; idempotencyKey?: string },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  return performSiteTransfer(
    company.id,
    site.id,
    data.amount,
    'COMPANY_TO_SITE',
    data.note || 'Fund allocation',
    data.idempotencyKey,
  )
}

export async function withdrawFundForUser(
  siteId: string,
  userId: string,
  data: { amount: number; note?: string; idempotencyKey?: string },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  return performSiteTransfer(
    company.id,
    site.id,
    data.amount,
    'SITE_TO_COMPANY',
    data.note || 'Fund withdrawal',
    data.idempotencyKey,
  )
}

export async function transferFundsForUser(
  siteId: string,
  userId: string,
  data: { amount: number; direction: 'COMPANY_TO_SITE' | 'SITE_TO_COMPANY'; note?: string; idempotencyKey?: string },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  return performSiteTransfer(
    company.id,
    site.id,
    data.amount,
    data.direction,
    data.note,
    data.idempotencyKey,
  )
}

export async function getSiteFundForUser(siteId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const cacheKey = CacheKeys.siteFundHistory(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const [allocatedFund, totalExpenses, customerPayments, allocations, remainingFund] = await Promise.all([
    getSiteAllocatedFund(site.id),
    getSiteTotalExpenses(site.id),
    getSiteCustomerPayments(site.id),
    prisma.payment.findMany({
      where: {
        companyId: site.companyId,
        siteId: site.id,
        walletType: 'SITE',
        movementType: { in: ['COMPANY_TO_SITE_TRANSFER', 'SITE_TO_COMPANY_TRANSFER'] },
      },
      orderBy: { postedAt: 'desc' },
    }),
    getSiteRemainingFund(site.id),
  ])

  const responseData = {
    allocatedFund,
    totalExpenses,
    customerPayments,
    remainingFund,
    allocations: allocations.map((allocation) => ({
      id: allocation.id,
      amount: allocation.direction === 'IN' ? Number(allocation.amount) : -Number(allocation.amount),
      note: allocation.note,
      createdAt: allocation.postedAt,
    })),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_DETAIL)
  return responseData
}

export async function getSiteFundHistoryForUser(siteId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const entries = await prisma.payment.findMany({
    where: {
      companyId: site.companyId,
      siteId: site.id,
      walletType: 'SITE',
      movementType: { in: ['COMPANY_TO_SITE_TRANSFER', 'SITE_TO_COMPANY_TRANSFER'] },
    },
    orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
  })

  let runningBalance = 0
  const historyAsc = entries.map((entry) => {
    const signedAmount = entry.direction === 'IN' ? Number(entry.amount) : -Number(entry.amount)
    runningBalance += signedAmount
    return {
      id: entry.id,
      type: entry.direction === 'IN' ? 'ALLOCATION' as const : 'WITHDRAWAL' as const,
      amount: Number(entry.amount),
      note: entry.note,
      runningBalance,
      createdAt: entry.postedAt,
    }
  })

  return { history: historyAsc.reverse() }
}
