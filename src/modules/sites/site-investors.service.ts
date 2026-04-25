import { prisma } from '../../db/prisma.js'
import { calculateInvestorLedgerTotals } from '../../services/investor-ledger.service.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { getSiteForUser } from './site-access.service.js'

export async function getSiteInvestorsForUser(siteId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const cacheKey = CacheKeys.siteInvestors(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const investors = await prisma.investor.findMany({
    where: { siteId: site.id, type: 'EQUITY', isDeleted: false },
    include: {
      transactions: {
        where: { isDeleted: false },
        select: {
          kind: true,
          ledgerEntries: {
            select: { amount: true, direction: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const investorRows = investors.map((investor) => {
    const totals = calculateInvestorLedgerTotals(investor.transactions)

    return {
      id: investor.id,
      name: investor.name,
      phone: investor.phone,
      equityPercentage: investor.equityPercentage,
      totalInvested: totals.principalInTotal,
      totalReturned: totals.totalReturned,
      isClosed: investor.isClosed,
      createdAt: investor.createdAt,
    }
  })

  const totalInvested = investorRows.reduce((sum, investor) => sum + investor.totalInvested, 0)

  const responseData = {
    investors: investorRows,
    totalInvested,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}
