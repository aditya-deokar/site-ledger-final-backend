import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import { invalidatePartnerCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { getPartnerPaidTotal } from '../../services/ledger-read.service.js'
import { getCompanyPartnerFund } from '../../utils/ledger-fund.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { mapPartnerResponse } from './company.mapper.js'
import { isCompanyServiceError, type CompanyServiceError } from './company.service.js'

type CompanyRecord = NonNullable<Awaited<ReturnType<typeof getCompanyForUser>>>

async function requireCompanyForUser(userId: string, message: string): Promise<CompanyRecord | CompanyServiceError> {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: message, status: 404 }

  return company
}

export async function addPartnerForUser(
  userId: string,
  data: {
    name: string
    email?: string
    phone?: string
    investmentAmount: number
    stakePercentage: number
  },
) {
  const company = await requireCompanyForUser(userId, 'No company found. Create one first.')
  if (isCompanyServiceError(company)) return company

  const partner = await prisma.$transaction(
    async (tx) => {
      const createdPartner = await tx.partner.create({
        data: {
          companyId: company.id,
          name: data.name,
          email: data.email,
          phone: data.phone,
          stakePercentage: data.stakePercentage,
        },
      })

      if (data.investmentAmount > 0) {
        await createLedgerEntry(
          {
            companyId: company.id,
            walletType: 'COMPANY',
            direction: 'IN',
            movementType: 'PARTNER_CAPITAL_IN',
            amount: new Prisma.Decimal(data.investmentAmount),
            idempotencyKey: `partner-create:${createdPartner.id}:capital`,
            note: 'Initial partner capital',
            partnerId: createdPartner.id,
          },
          tx,
        )
      }

      return tx.partner.findUnique({
        where: { id: createdPartner.id },
        include: {
          ledgerEntries: {
            select: { amount: true, direction: true },
          },
        },
      })
    },
    LEDGER_TX_OPTIONS,
  )

  if (!partner) return { error: 'Partner could not be created', status: 400 }

  await invalidatePartnerCaches(company.id)

  return { partner: mapPartnerResponse(partner) }
}

export async function getPartnersForUser(userId: string) {
  const company = await requireCompanyForUser(userId, 'No company found. Create one first.')
  if (isCompanyServiceError(company)) return company

  const cacheKey = CacheKeys.partnerList(company.id)
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

  const totalFund = await getCompanyPartnerFund(company.id)

  const responseData = {
    company: {
      id: companyWithPartners.id,
      name: companyWithPartners.name,
    },
    total_fund: totalFund,
    partners: companyWithPartners.partners.map(mapPartnerResponse),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.PARTNER_LIST)
  return responseData
}

export async function updatePartnerForUser(
  partnerId: string,
  userId: string,
  data: {
    name?: string
    email?: string
    phone?: string
    investmentAmount?: number
    stakePercentage?: number
  },
) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  const existing = await prisma.partner.findFirst({
    where: { id: partnerId, companyId: company.id },
  })
  if (!existing) return { error: 'Partner not found', status: 404 }

  const partner = await prisma.$transaction(
    async (tx) => {
      const updatedPartner = await tx.partner.update({
        where: { id: partnerId },
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          stakePercentage: data.stakePercentage,
        },
      })

      if (data.investmentAmount !== undefined) {
        const currentInvestment = await getPartnerPaidTotal(partnerId, tx)
        const delta = data.investmentAmount - currentInvestment

        if (delta !== 0) {
          await createLedgerEntry(
            {
              companyId: company.id,
              walletType: 'COMPANY',
              direction: delta > 0 ? 'IN' : 'OUT',
              movementType: delta > 0 ? 'PARTNER_CAPITAL_IN' : 'ADJUSTMENT',
              amount: new Prisma.Decimal(Math.abs(delta)),
              idempotencyKey: `partner-update:${partnerId}:${Date.now()}`,
              note: delta > 0 ? 'Partner capital increased' : 'Partner capital adjusted down',
              partnerId,
            },
            tx,
          )
        }
      }

      return tx.partner.findUnique({
        where: { id: updatedPartner.id },
        include: {
          ledgerEntries: {
            select: { amount: true, direction: true },
          },
        },
      })
    },
    LEDGER_TX_OPTIONS,
  )

  if (!partner) return { error: 'Partner not found', status: 404 }

  await invalidatePartnerCaches(company.id)

  return { partner: mapPartnerResponse(partner) }
}

export async function deletePartnerForUser(partnerId: string, userId: string) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  const existing = await prisma.partner.findFirst({
    where: { id: partnerId, companyId: company.id },
  })
  if (!existing) return { error: 'Partner not found', status: 404 }

  const ledgerEntryCount = await prisma.payment.count({
    where: { partnerId },
  })
  if (ledgerEntryCount > 0) {
    return {
      error: 'Partner has financial history, so deletion is blocked to preserve ledger history.',
      status: 400,
    }
  }

  await prisma.partner.delete({
    where: { id: partnerId },
  })

  await invalidatePartnerCaches(company.id)

  return { message: `Partner ${existing.name} removed` }
}

export async function getPartnerLedgerForUser(partnerId: string, userId: string) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  const partner = await prisma.partner.findFirst({
    where: { id: partnerId, companyId: company.id },
  })
  if (!partner) return { error: 'Partner not found', status: 404 }

  const payments = await prisma.payment.findMany({
    where: { partnerId, companyId: company.id },
    orderBy: { postedAt: 'desc' },
    select: {
      id: true,
      amount: true,
      direction: true,
      movementType: true,
      note: true,
      postedAt: true,
      reversalOfPaymentId: true,
    },
  })

  const totalIn = payments
    .filter((p) => p.direction === 'IN')
    .reduce((s, p) => s + Number(p.amount), 0)
  const totalOut = payments
    .filter((p) => p.direction === 'OUT')
    .reduce((s, p) => s + Number(p.amount), 0)

  return {
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      stakePercentage: partner.stakePercentage,
    },
    summary: {
      totalIn,
      totalOut,
      netCapital: totalIn - totalOut,
    },
    entries: payments.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      direction: p.direction,
      movementType: p.movementType,
      note: p.note,
      reversalOfPaymentId: p.reversalOfPaymentId,
      date: p.postedAt.toISOString(),
    })),
  }
}
