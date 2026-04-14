import { randomUUID } from 'node:crypto'

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

function distributeFlatsAcrossFloors(totalFloors: number, totalFlats: number) {
  if (totalFloors <= 0) return []

  const baseFlatCount = Math.floor(totalFlats / totalFloors)
  const remainder = totalFlats % totalFloors

  return Array.from({ length: totalFloors }, (_, index) => baseFlatCount + (index < remainder ? 1 : 0))
}

function chunkItems<T>(items: T[], chunkSize: number) {
  if (!items.length) return []

  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }

  return chunks
}

export async function createSiteForUser(
  userId: string,
  data: {
    name: string
    address: string
    projectType: 'NEW_CONSTRUCTION' | 'REDEVELOPMENT'
    totalFloors?: number
    totalFlats?: number
  },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const slug = await generateUniqueSlug(data.name)
  const totalFloors = data.totalFloors ?? 0
  const totalFlats = data.totalFlats ?? 0
  const flatDistribution = distributeFlatsAcrossFloors(totalFloors, totalFlats)
  const siteId = randomUUID()
  const floorRecords = Array.from({ length: totalFloors }, (_, floorIndex) => ({
    id: randomUUID(),
    siteId,
    floorNumber: floorIndex + 1,
    floorName: null as string | null,
  }))
  const flatRecords = floorRecords.flatMap((floor, floorIndex) => {
    const flatsForFloor = flatDistribution[floorIndex] ?? 0

    return Array.from({ length: flatsForFloor }, (_, flatIndex) => ({
      id: randomUUID(),
      siteId,
      floorId: floor.id,
      flatNumber: flatIndex + 1,
      customFlatId: null as string | null,
      flatType: 'CUSTOMER' as const,
      status: 'AVAILABLE' as const,
    }))
  })
  const flatBatches = chunkItems(flatRecords, 5000)

  await prisma.$transaction([
    prisma.site.create({
      data: {
        id: siteId,
        companyId: company.id,
        name: data.name,
        address: data.address,
        projectType: data.projectType,
        slug,
        totalFloors,
        totalFlats,
      },
    }),
    ...(floorRecords.length
      ? [
          prisma.floor.createMany({
            data: floorRecords,
          }),
        ]
      : []),
    ...flatBatches.map((batch) =>
      prisma.flat.createMany({
        data: batch,
      }),
    ),
  ])

  const site = await prisma.site.findUniqueOrThrow({
    where: { id: siteId },
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
      const [partnerAllocatedFund, investorAllocatedFund, totalExpenses, totalExpensesBilled, customerPayments, remainingFund, totalRevenueResult] = await Promise.all([
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
