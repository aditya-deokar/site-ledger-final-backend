import { prisma } from '../../db/prisma.js'
import { generateUniqueSlug } from '../../utils/slug.js'
import {
  getSitePartnerAllocatedFund,
  getSiteEquityInvestorFund,
  getSiteTotalExpenses,
  getSiteTotalExpensesBilled,
  getSiteCustomerPayments,
  getSiteRemainingFund,
} from '../../utils/ledger-fund.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { invalidateSiteListCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'

export async function createSiteForUser(
  userId: string,
  data: { name: string; address: string; projectType: 'NEW_CONSTRUCTION' | 'REDEVELOPMENT' },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const slug = await generateUniqueSlug(data.name)

  const site = await prisma.site.create({
    data: {
      companyId: company.id,
      name: data.name,
      address: data.address,
      projectType: data.projectType,
      slug,
      totalFloors: 0,
      totalFlats: 0,
    },
  })

  await invalidateSiteListCaches(company.id)
  return site
}

export async function getSitesForUser(userId: string, showArchived?: 'true' | 'false' | 'only') {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const cacheKey = `${CacheKeys.siteList(company.id)}:${showArchived ?? 'default'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  let isActiveFilter: boolean | undefined
  if (showArchived === 'only') isActiveFilter = false
  else if (showArchived === 'true') isActiveFilter = undefined
  else isActiveFilter = true

  const sites = await prisma.site.findMany({
    where: {
      companyId: company.id,
      ...(isActiveFilter !== undefined ? { isActive: isActiveFilter } : {}),
    },
    include: {
      floors: { select: { flats: { select: { status: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const siteSummaries = await Promise.all(
    sites.map(async (site) => {
      const [
        partnerAllocatedFund,
        investorAllocatedFund,
        totalExpenses,
        totalExpensesBilled,
        customerPayments,
        remainingFund,
        totalRevenueResult,
      ] = await Promise.all([
        getSitePartnerAllocatedFund(site.id),
        getSiteEquityInvestorFund(site.id),
        getSiteTotalExpenses(site.id),
        getSiteTotalExpensesBilled(site.id),
        getSiteCustomerPayments(site.id),
        getSiteRemainingFund(site.id),
        prisma.customer.aggregate({
          where: { siteId: site.id, isDeleted: false },
          _sum: { sellingPrice: true },
        }),
      ])

      const allocatedFund = partnerAllocatedFund + investorAllocatedFund
      const totalRevenue = totalRevenueResult._sum.sellingPrice ?? 0
      const totalProfit = totalRevenue - totalExpensesBilled
      const flatsSummary = { available: 0, booked: 0, sold: 0 }
      for (const floor of site.floors) {
        for (const flat of floor.flats) {
          if (flat.status === 'AVAILABLE') flatsSummary.available++
          else if (flat.status === 'BOOKED') flatsSummary.booked++
          else if (flat.status === 'SOLD') flatsSummary.sold++
        }
      }

      return {
        id: site.id,
        name: site.name,
        address: site.address,
        projectType: site.projectType,
        totalFloors: site.totalFloors,
        totalFlats: site.totalFlats,
        slug: site.slug,
        isActive: site.isActive,
        partnerAllocatedFund,
        investorAllocatedFund,
        allocatedFund,
        totalExpenses,
        customerPayments,
        remainingFund,
        totalProfit,
        flatsSummary,
        createdAt: site.createdAt,
      }
    }),
  )

  const responseData = { sites: siteSummaries }
  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_LIST)
  return responseData
}

export async function getSiteDetailForUser(siteId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId: company.id },
  })
  if (!site) return null

  const cacheKey = CacheKeys.siteDetail(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const [
    partnerAllocatedFund,
    investorAllocatedFund,
    totalExpenses,
    totalExpensesBilled,
    customerPayments,
    remainingFund,
    flatCounts,
    customerFlatsCount,
    ownerFlatsCount,
    totalRevenueResult,
  ] = await Promise.all([
    getSitePartnerAllocatedFund(site.id),
    getSiteEquityInvestorFund(site.id),
    getSiteTotalExpenses(site.id),
    getSiteTotalExpensesBilled(site.id),
    getSiteCustomerPayments(site.id),
    getSiteRemainingFund(site.id),
    prisma.flat.groupBy({
      by: ['status'],
      where: { siteId: site.id },
      _count: true,
    }),
    prisma.flat.count({ where: { siteId: site.id, flatType: 'CUSTOMER' } }),
    prisma.flat.count({ where: { siteId: site.id, flatType: 'EXISTING_OWNER' } }),
    prisma.customer.aggregate({
      where: { siteId: site.id, isDeleted: false },
      _sum: { sellingPrice: true },
    }),
  ])

  const totalRevenue = totalRevenueResult._sum.sellingPrice ?? 0
  const totalProfit = totalRevenue - totalExpensesBilled
  const allocatedFund = partnerAllocatedFund + investorAllocatedFund
  const flatsSummary = { available: 0, booked: 0, sold: 0, customerFlats: 0, ownerFlats: 0 }

  for (const flatCount of flatCounts) {
    if (flatCount.status === 'AVAILABLE') flatsSummary.available = flatCount._count
    else if (flatCount.status === 'BOOKED') flatsSummary.booked = flatCount._count
    else if (flatCount.status === 'SOLD') flatsSummary.sold = flatCount._count
  }

  flatsSummary.customerFlats = customerFlatsCount
  flatsSummary.ownerFlats = ownerFlatsCount

  const responseData = {
    site: {
      id: site.id,
      name: site.name,
      address: site.address,
      projectType: site.projectType,
      totalFloors: site.totalFloors,
      totalFlats: site.totalFlats,
      slug: site.slug,
      isActive: site.isActive,
      partnerAllocatedFund,
      investorAllocatedFund,
      allocatedFund,
      totalExpenses,
      totalExpensesBilled,
      customerPayments,
      remainingFund,
      totalRevenue,
      totalProfit,
      flatsSummary,
      createdAt: site.createdAt,
    },
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_DETAIL)
  return responseData
}

export async function toggleSiteForUser(siteId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId: company.id },
  })
  if (!site) return null

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { isActive: !site.isActive },
  })

  await invalidateSiteListCaches(company.id)
  return updated
}

export async function deleteSiteForUser(siteId: string, userId: string, keepCustomers?: 'true' | 'false') {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId: company.id },
  })
  if (!site) return null

  if (keepCustomers === 'true') {
    await prisma.customer.updateMany({
      where: { siteId: site.id },
      data: { flatId: null, siteId: null },
    })
  }

  await prisma.site.delete({ where: { id: site.id } })
  await invalidateSiteListCaches(company.id)

  return site
}
