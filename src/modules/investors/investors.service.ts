import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { invalidateInvestorCaches, invalidateInvestorDetailCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { mapInvestorTransactionResponse } from '../../services/investor-ledger.service.js'
import { getInvestorForUser } from './investor-access.service.js'
import {
  investorTransactionInclude,
  investorWithLedgerInclude,
  mapInvestorDetailResponse,
  mapInvestorResponse,
} from './investors.mapper.js'

export type InvestorServiceError = {
  error: string
  status: number
}

export async function getInvestorView(
  investorId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const investor = await tx.investor.findUnique({
    where: { id: investorId },
    include: investorWithLedgerInclude,
  })

  if (!investor) return null

  return mapInvestorDetailResponse(investor)
}

export async function getTransactionView(
  transactionId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const transaction = await tx.investorTransaction.findUnique({
    where: { id: transactionId },
    include: investorTransactionInclude,
  })

  if (!transaction) return null

  return mapInvestorTransactionResponse(transaction)
}

export type InvestorDetailView = NonNullable<Awaited<ReturnType<typeof getInvestorView>>>
export type InvestorView = InvestorDetailView['investor']
export type InvestorTransactionView = NonNullable<Awaited<ReturnType<typeof getTransactionView>>>

export async function getInvestorsForUser(
  userId: string,
  filters: { type?: 'EQUITY' | 'FIXED_RATE'; search?: string },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return null

  const search = filters.search?.trim() || undefined
  const cacheKey = `${CacheKeys.investorList(company.id)}:${filters.type ?? 'all'}:${search ? encodeURIComponent(search.toLowerCase()) : 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const investors = await prisma.investor.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      ...(filters.type ? { type: filters.type } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { site: { is: { name: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    },
    include: investorWithLedgerInclude,
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    investors: investors.map((investor) => mapInvestorResponse(investor)),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function createInvestorForUser(
  userId: string,
  data: {
    name: string
    phone?: string
    type: 'EQUITY' | 'FIXED_RATE'
    siteId?: string
    equityPercentage?: number
    fixedRate?: number
  },
): Promise<{ investor: InvestorView } | InvestorServiceError> {
  const company = await getCompanyForUser(userId)
  if (!company) {
    return { error: 'No company found. Create one first.', status: 404 }
  }

  if (data.type === 'EQUITY') {
    if (!data.siteId) return { error: 'siteId is required for equity investors', status: 400 }

    const site = await prisma.site.findFirst({ where: { id: data.siteId, companyId: company.id } })
    if (!site) return { error: 'Site not found', status: 404 }
  }

  if (data.type === 'FIXED_RATE' && data.siteId) {
    return {
      error: 'Fixed-rate investors are linked to the company, not a site. Remove siteId.',
      status: 400,
    }
  }

  const investor = await prisma.investor.create({
    data: {
      companyId: company.id,
      siteId: data.type === 'EQUITY' ? data.siteId : null,
      name: data.name,
      phone: data.phone,
      type: data.type,
      equityPercentage: data.type === 'EQUITY' ? data.equityPercentage : null,
      fixedRate: data.type === 'FIXED_RATE' ? data.fixedRate : null,
    },
  })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  const view = await getInvestorView(investor.id)
  if (!view) return { error: 'Investor not found', status: 404 }

  return { investor: view.investor }
}

export async function getInvestorDetailForUser(investorId: string, userId: string) {
  const { investor } = await getInvestorForUser(investorId, userId)
  if (!investor) return null

  const cacheKey = CacheKeys.investorDetail(investorId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const view = await getInvestorView(investorId)
  if (!view) return null

  const responseData = {
    investor: view.investor,
    transactions: view.transactions,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}

export async function updateInvestorForUser(
  investorId: string,
  userId: string,
  data: {
    name?: string
    phone?: string
    equityPercentage?: number
    fixedRate?: number
  },
) {
  const { company, investor } = await getInvestorForUser(investorId, userId)
  if (!company || !investor) return null

  const updated = await prisma.investor.update({
    where: { id: investorId },
    data,
  })

  await invalidateInvestorCaches(company.id, updated.siteId)
  await invalidateInvestorDetailCaches(updated.id)

  const view = await getInvestorView(updated.id)
  if (!view) return null

  return { investor: view.investor }
}

export async function deleteInvestorForUser(investorId: string, userId: string) {
  const { company, investor } = await getInvestorForUser(investorId, userId)
  if (!company || !investor) return null

  await prisma.investor.update({ where: { id: investorId }, data: { isDeleted: true } })

  await invalidateInvestorCaches(company.id, investor.siteId)
  await invalidateInvestorDetailCaches(investor.id)

  return { message: `Investor "${investor.name}" removed` }
}
