import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { invalidateCompanyCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { getCompanyAvailableFund, getCompanyFixedRateInvestorFund, getCompanyPartnerFund } from '../../utils/ledger-fund.js'
import { mapCompanyActivity, mapCompanyExpenseResponse, mapCompanyResponse, mapPartnerResponse } from './company.mapper.js'

export type CompanyServiceError = {
  error: string
  status: number
}

export function isCompanyServiceError(result: unknown): result is CompanyServiceError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

type CompanyRecord = NonNullable<Awaited<ReturnType<typeof getCompanyForUser>>>

async function requireCompanyForUser(userId: string, message: string): Promise<CompanyRecord | CompanyServiceError> {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: message, status: 404 }

  return company
}

export async function createCompanyForUser(userId: string, data: { name: string; address?: string }) {
  const existing = await prisma.company.findUnique({
    where: { createdBy: userId },
  })
  if (existing) return { error: 'You already have a company', status: 400 }

  const company = await prisma.company.create({
    data: {
      name: data.name,
      address: data.address,
      createdBy: userId,
    },
  })

  return { company: mapCompanyResponse(company) }
}

export async function getCompanySummaryForUser(userId: string) {
  const company = await requireCompanyForUser(userId, 'No company found. Create one first.')
  if (isCompanyServiceError(company)) return company

  const cacheKey = CacheKeys.companyDetails(company.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const companyWithPartners = await prisma.company.findUnique({
    where: { id: company.id },
    include: {
      partners: {
        include: {
          ledgerEntries: {
            select: { amount: true, direction: true },
          },
        },
      },
    },
  })
  if (!companyWithPartners) return { error: 'No company found', status: 404 }

  const [partnerFund, investorFund, availableFund] = await Promise.all([
    getCompanyPartnerFund(company.id),
    getCompanyFixedRateInvestorFund(company.id),
    getCompanyAvailableFund(company.id),
  ])
  const totalFund = partnerFund + investorFund

  const responseData = {
    company: mapCompanyResponse(companyWithPartners),
    partner_fund: partnerFund,
    investor_fund: investorFund,
    total_fund: totalFund,
    available_fund: availableFund,
    partners: companyWithPartners.partners.map(mapPartnerResponse),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.COMPANY_PROFILE)
  return responseData
}

export async function updateCompanyForUser(userId: string, data: { name?: string; address?: string }) {
  const existing = await requireCompanyForUser(userId, 'No company found. Create one first.')
  if (isCompanyServiceError(existing)) return existing

  const company = await prisma.company.update({
    where: { id: existing.id },
    data,
  })

  await invalidateCompanyCaches(company.id, userId)

  return { company: mapCompanyResponse(company) }
}

export async function deleteCompanyForUser(userId: string) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  await prisma.company.delete({ where: { id: company.id } })
  await invalidateCompanyCaches(company.id, userId)

  return { message: `Company "${company.name}" deleted` }
}

export async function getCompanyActivityForUser(
  userId: string,
  query: { cursor?: string; limit?: number },
) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  const limit = query.limit ?? 10
  const cacheKey = `${CacheKeys.activityFeed(company.id)}:${query.cursor ?? 'first'}:${limit}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const fetchLimit = limit + 5
  const payments = await prisma.payment.findMany({
    where: {
      companyId: company.id,
      ...(query.cursor ? { postedAt: { lt: new Date(query.cursor) } } : {}),
      OR: [
        { companyWithdrawalId: { not: null } },
        {
          walletType: 'COMPANY',
          movementType: { in: ['COMPANY_TO_SITE_TRANSFER', 'SITE_TO_COMPANY_TRANSFER'] },
        },
        { investorTransactionId: { not: null } },
        { expenseId: { not: null } },
        { partnerId: { not: null } },
      ],
    },
    orderBy: { postedAt: 'desc' },
    take: fetchLimit,
    include: {
      site: { select: { name: true } },
      companyWithdrawal: { select: { note: true } },
      partner: { select: { name: true } },
      investorTransaction: {
        select: {
          note: true,
          kind: true,
          investor: { select: { name: true } },
        },
      },
      expense: {
        select: {
          description: true,
          site: { select: { name: true } },
        },
      },
    },
  })

  const page = payments.slice(0, limit)
  const hasMore = payments.length > limit
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].postedAt.toISOString() : null

  const responseData = {
    activities: page.map(mapCompanyActivity),
    nextCursor,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ACTIVITY_FEED)
  return responseData
}

export async function getCompanyExpensesForUser(
  userId: string,
  query: { page?: number; limit?: number },
) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  const page = query.page ?? 1
  const limit = query.limit ?? 20
  const skip = (page - 1) * limit

  const cacheKey = `${CacheKeys.companyExpenses(company.id)}:${page}:${limit}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where: { site: { companyId: company.id }, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        site: { select: { name: true } },
        vendor: { select: { name: true } },
      },
    }),
    prisma.expense.count({ where: { site: { companyId: company.id }, isDeleted: false } }),
  ])

  const responseData = {
    expenses: expenses.map(mapCompanyExpenseResponse),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}
