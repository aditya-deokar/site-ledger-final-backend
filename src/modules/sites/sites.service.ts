import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
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
import { getSiteAgreementFinancials } from '../customers/customer-agreement.service.js'

export type SiteServiceError = {
  error: string
  status: number
}

export function isSiteServiceError(result: unknown): result is SiteServiceError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

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

function getDefaultFloorName(floorIndex: number) {
  if (floorIndex === 0) return 'Ground Floor'
  return `Floor ${floorIndex}`
}

function getDefaultWingCode(wingName: string, wingIndex: number) {
  const trimmed = wingName.trim()
  if (trimmed.length > 0) {
    return trimmed.slice(0, 4).toUpperCase()
  }

  return String.fromCharCode(65 + (wingIndex % 26))
}

export async function createSiteForUser(
  userId: string,
  data: {
    name: string
    address: string
    projectType: 'NEW_CONSTRUCTION' | 'REDEVELOPMENT'
    totalFloors?: number
    totalFlats?: number
    hasMultipleWings?: boolean
    includeGroundFloor?: boolean
    wings?: Array<{
      name: string
      floorCount: number
      includeGroundFloor?: boolean
    }>
  },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const slug = await generateUniqueSlug(data.name)
  const requestedWings = data.hasMultipleWings ? data.wings ?? [] : []
  const configuredWings = requestedWings
    .map((wing) => ({
      name: wing.name.trim(),
      floorCount: wing.floorCount,
      includeGroundFloor: !!wing.includeGroundFloor,
    }))
    .filter((wing) => wing.name.length > 0 && wing.floorCount > 0)
  const hasWings = configuredWings.length > 0
  const wingDelegate = (prisma as unknown as { wing?: { createMany?: (...args: unknown[]) => unknown } }).wing

  if (hasWings && typeof wingDelegate?.createMany !== 'function') {
    throw new Error('Wing model is unavailable in Prisma client. Run `npx prisma generate` and restart the backend server.')
  }

  const totalFloors = hasWings
    ? configuredWings.reduce((sum, wing) => sum + wing.floorCount, 0)
    : data.totalFloors ?? 0
  const totalFlats = data.totalFlats ?? 0
  const flatDistribution = distributeFlatsAcrossFloors(totalFloors, totalFlats)
  const siteId = randomUUID()
  const wingRecords = configuredWings.map((wing, wingIndex) => ({
    id: randomUUID(),
    siteId,
    name: wing.name,
    code: getDefaultWingCode(wing.name, wingIndex),
    isActive: true,
  }))

  const floorRecords = hasWings
    ? wingRecords.flatMap((wingRecord, wingIndex) => {
        const wing = configuredWings[wingIndex]
        if (!wing) return []

        return Array.from({ length: wing.floorCount }, (_, floorIndex) => ({
          id: randomUUID(),
          siteId,
          wingId: wingRecord.id,
          floorNumber: floorIndex + 1,
          floorName: wing.includeGroundFloor
            ? floorIndex === 0
              ? 'Ground Floor'
              : `Floor ${floorIndex}`
            : `Floor ${floorIndex + 1}`,
        }))
      })
    : Array.from({ length: totalFloors }, (_, floorIndex) => ({
        id: randomUUID(),
        siteId,
        wingId: null as string | null,
        floorNumber: floorIndex + 1,
        floorName: data.includeGroundFloor
          ? floorIndex === 0
            ? 'Ground Floor'
            : `Floor ${floorIndex}`
          : `Floor ${floorIndex + 1}`,
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
    ...(wingRecords.length
      ? [
          prisma.wing.createMany({
            data: wingRecords,
          }),
        ]
      : []),
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

  // Fetch sites with only required fields to minimize data transfer
  const sites = await prisma.site.findMany({
    where: {
      companyId: company.id,
      ...(isActiveFilter !== undefined ? { isActive: isActiveFilter } : {}),
    },
    select: {
      id: true,
      name: true,
      address: true,
      projectType: true,
      totalFloors: true,
      totalFlats: true,
      slug: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  if (sites.length === 0) {
    const responseData = { sites: [] }
    await cacheService.set(cacheKey, responseData, CacheTTL.SITE_LIST)
    return responseData
  }

  // Batch all fund calculations using raw SQL for maximum performance
  const siteIds = sites.map(s => s.id)
  
  // Run all queries in parallel for maximum performance
  const [flatStatusCounts, fundMetrics, expensesBilled, agreementFinancials] = await Promise.all([
    // Batch flat status counts for all sites
    prisma.flat.groupBy({
      by: ['siteId', 'status'],
      where: { siteId: { in: siteIds } },
      _count: true,
    }),
    
    // Simplified raw SQL query - calculate only essential metrics
    prisma.$queryRaw<Array<{
      siteId: string
      partnerAllocatedFund: bigint
      investorIn: bigint
      investorOut: bigint
      expensesOut: bigint
      customerPaymentsIn: bigint
      totalIn: bigint
      totalOut: bigint
    }>>`
      SELECT 
        p."siteId",
        COALESCE(SUM(CASE WHEN p."movementType" = 'COMPANY_TO_SITE_TRANSFER' AND p."direction" = 'IN' THEN p."amount" ELSE 0 END), 0) as "partnerAllocatedFund",
        COALESCE(SUM(CASE WHEN p."investorTransactionId" IS NOT NULL AND p."direction" = 'IN' THEN p."amount" ELSE 0 END), 0) as "investorIn",
        COALESCE(SUM(CASE WHEN p."investorTransactionId" IS NOT NULL AND p."direction" = 'OUT' THEN p."amount" ELSE 0 END), 0) as "investorOut",
        COALESCE(SUM(CASE WHEN p."expenseId" IS NOT NULL AND p."direction" = 'OUT' THEN p."amount" ELSE 0 END), 0) as "expensesOut",
        COALESCE(SUM(CASE WHEN p."customerId" IS NOT NULL AND p."direction" = 'IN' THEN p."amount" ELSE 0 END), 0) as "customerPaymentsIn",
        COALESCE(SUM(CASE WHEN p."direction" = 'IN' THEN p."amount" ELSE 0 END), 0) as "totalIn",
        COALESCE(SUM(CASE WHEN p."direction" = 'OUT' THEN p."amount" ELSE 0 END), 0) as "totalOut"
      FROM "Payment" p
      WHERE p."siteId" IN (${Prisma.join(siteIds)}) AND p."walletType" = 'SITE'
      GROUP BY p."siteId"
    `,
    
    // Batch expenses billed
    prisma.expense.groupBy({
      by: ['siteId'],
      where: { siteId: { in: siteIds }, isDeleted: false },
      _sum: { amount: true },
    }),
    
    // Batch agreement financials
    prisma.customer.groupBy({
      by: ['siteId'],
      where: { 
        siteId: { in: siteIds }, 
        isDeleted: false, 
        dealStatus: 'ACTIVE' 
      },
      _sum: { sellingPrice: true },
    }),
  ])

  // Create lookup maps
  const fundMetricsMap = new Map(
    fundMetrics.map(m => [m.siteId, {
      partnerAllocatedFund: Number(m.partnerAllocatedFund),
      investorAllocatedFund: Number(m.investorIn) - Number(m.investorOut),
      totalExpenses: Number(m.expensesOut),
      customerPayments: Number(m.customerPaymentsIn),
      remainingFund: Number(m.totalIn) - Number(m.totalOut),
    }])
  )

  const expensesBilledMap = new Map(
    expensesBilled.map(e => [e.siteId, Number(e._sum.amount ?? 0)])
  )

  const agreementFinancialsMap = new Map(
    agreementFinancials.map(a => [a.siteId, Number(a._sum.sellingPrice ?? 0)])
  )

  // Create flat status summary map
  const flatStatusMap = new Map<string, { available: number; booked: number; sold: number }>()
  for (const count of flatStatusCounts) {
    if (!flatStatusMap.has(count.siteId)) {
      flatStatusMap.set(count.siteId, { available: 0, booked: 0, sold: 0 })
    }
    const summary = flatStatusMap.get(count.siteId)!
    if (count.status === 'AVAILABLE') summary.available = count._count
    else if (count.status === 'BOOKED') summary.booked = count._count
    else if (count.status === 'SOLD') summary.sold = count._count
  }

  // Map sites to summaries
  const siteSummaries = sites.map((site) => {
    const metrics = fundMetricsMap.get(site.id) ?? {
      partnerAllocatedFund: 0,
      investorAllocatedFund: 0,
      totalExpenses: 0,
      customerPayments: 0,
      remainingFund: 0,
    }
    
    const totalExpensesBilled = expensesBilledMap.get(site.id) ?? 0
    const totalRevenue = agreementFinancialsMap.get(site.id) ?? 0
    const allocatedFund = metrics.partnerAllocatedFund + metrics.investorAllocatedFund
    const totalProfit = totalRevenue - totalExpensesBilled
    
    const flatsSummary = flatStatusMap.get(site.id) ?? { available: 0, booked: 0, sold: 0 }

    return {
      id: site.id,
      name: site.name,
      address: site.address,
      projectType: site.projectType,
      totalFloors: site.totalFloors,
      totalFlats: site.totalFlats,
      slug: site.slug,
      isActive: site.isActive,
      partnerAllocatedFund: metrics.partnerAllocatedFund,
      investorAllocatedFund: metrics.investorAllocatedFund,
      allocatedFund,
      totalExpenses: metrics.totalExpenses,
      customerPayments: metrics.customerPayments,
      remainingFund: metrics.remainingFund,
      totalProfit,
      flatsSummary,
      createdAt: site.createdAt,
    }
  })

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
    agreementFinancials,
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
    getSiteAgreementFinancials(site.id),
  ])

  const totalRevenue = agreementFinancials.profitRevenue
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

  const [paymentCount, expenseCount, customerCount, investorCount] = await prisma.$transaction([
    prisma.payment.count({ where: { siteId: site.id } }),
    prisma.expense.count({ where: { siteId: site.id } }),
    prisma.customer.count({ where: { siteId: site.id } }),
    prisma.investor.count({ where: { siteId: site.id } }),
  ])

  const hasFinancialOrOperationalHistory =
    paymentCount > 0 ||
    expenseCount > 0 ||
    customerCount > 0 ||
    investorCount > 0

  if (hasFinancialOrOperationalHistory) {
    return {
      error:
        'A site can be permanently deleted only if it has no financial or operational history. Once any real activity exists, the site should only be archived.',
      status: 409,
    }
  }

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
