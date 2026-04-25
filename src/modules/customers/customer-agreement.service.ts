import { Prisma, type CustomerAgreementLineType } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { getCustomerPaidTotal } from '../../services/customer-ledger.service.js'
import { invalidateCustomerCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys } from '../../config/cache-keys.js'
import { getCustomerForUser } from './customer-access.service.js'

type AgreementDb = typeof prisma | Prisma.TransactionClient

export type CustomerAgreementLineInput = {
  type: CustomerAgreementLineType
  label: string
  amount: number
  ratePercent?: number
  calculationBase?: number
  affectsProfit?: boolean
  note?: string
}

export type CustomerAgreementLineView = {
  id: string
  type: CustomerAgreementLineType
  label: string
  amount: number
  signedAmount: number
  ratePercent: number | null
  calculationBase: number | null
  affectsProfit: boolean
  note: string | null
  createdAt: string
}

export type CustomerAgreementTotals = {
  basePrice: number
  charges: number
  tax: number
  discounts: number
  credits: number
  payableTotal: number
  profitRevenue: number
}

type AgreementLineLike = {
  type: CustomerAgreementLineType
  amount: Prisma.Decimal | number | string | { toString(): string }
  affectsProfit: boolean
}

function toMoney(value: Prisma.Decimal | number | string | { toString(): string } | null | undefined) {
  return Math.round(Number(value ?? 0) * 100) / 100
}

function defaultAffectsProfit(type: CustomerAgreementLineType) {
  return type !== 'TAX'
}

export function getAgreementLineSignedAmount(line: Pick<AgreementLineLike, 'type' | 'amount'>) {
  const amount = toMoney(line.amount)
  return line.type === 'DISCOUNT' || line.type === 'CREDIT' ? -amount : amount
}

export function calculateAgreementTotals(lines: AgreementLineLike[], fallbackPayable = 0): CustomerAgreementTotals {
  if (lines.length === 0) {
    const value = toMoney(fallbackPayable)
    return {
      basePrice: value,
      charges: 0,
      tax: 0,
      discounts: 0,
      credits: 0,
      payableTotal: value,
      profitRevenue: value,
    }
  }

  const totals: CustomerAgreementTotals = {
    basePrice: 0,
    charges: 0,
    tax: 0,
    discounts: 0,
    credits: 0,
    payableTotal: 0,
    profitRevenue: 0,
  }

  for (const line of lines) {
    const amount = toMoney(line.amount)
    const signedAmount = getAgreementLineSignedAmount(line)
    totals.payableTotal += signedAmount

    if (line.type === 'BASE_PRICE') totals.basePrice += amount
    else if (line.type === 'CHARGE') totals.charges += amount
    else if (line.type === 'TAX') totals.tax += amount
    else if (line.type === 'DISCOUNT') totals.discounts += amount
    else if (line.type === 'CREDIT') totals.credits += amount

    if (line.affectsProfit) {
      totals.profitRevenue += signedAmount
    }
  }

  return {
    basePrice: toMoney(totals.basePrice),
    charges: toMoney(totals.charges),
    tax: toMoney(totals.tax),
    discounts: toMoney(totals.discounts),
    credits: toMoney(totals.credits),
    payableTotal: Math.max(toMoney(totals.payableTotal), 0),
    profitRevenue: Math.max(toMoney(totals.profitRevenue), 0),
  }
}

export function mapAgreementLine(line: {
  id: string
  type: CustomerAgreementLineType
  label: string
  amount: Prisma.Decimal | number | string | { toString(): string }
  ratePercent: number | null
  calculationBase: Prisma.Decimal | number | string | { toString(): string } | null
  affectsProfit: boolean
  note: string | null
  createdAt: Date
}): CustomerAgreementLineView {
  return {
    id: line.id,
    type: line.type,
    label: line.label,
    amount: toMoney(line.amount),
    signedAmount: getAgreementLineSignedAmount(line),
    ratePercent: line.ratePercent,
    calculationBase: line.calculationBase === null ? null : toMoney(line.calculationBase),
    affectsProfit: line.affectsProfit,
    note: line.note,
    createdAt: line.createdAt.toISOString(),
  }
}

export async function getCustomerAgreementTotals(customerId: string, db: AgreementDb = prisma) {
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: {
      sellingPrice: true,
      agreementLines: {
        where: { isDeleted: false },
        select: { type: true, amount: true, affectsProfit: true },
      },
    },
  })
  if (!customer) throw new Error('CUSTOMER_NOT_FOUND')

  return calculateAgreementTotals(customer.agreementLines, customer.sellingPrice)
}

export async function syncCustomerAgreementPayable(customerId: string, db: AgreementDb = prisma) {
  const totals = await getCustomerAgreementTotals(customerId, db)
  await db.customer.update({
    where: { id: customerId },
    data: { sellingPrice: totals.payableTotal },
  })

  return totals
}

export async function createBaseAgreementLine(
  db: AgreementDb,
  input: {
    customerId: string
    companyId: string
    siteId?: string | null
    amount: number
  },
) {
  return db.customerAgreementLine.create({
    data: {
      customerId: input.customerId,
      companyId: input.companyId,
      siteId: input.siteId ?? null,
      type: 'BASE_PRICE',
      label: 'Base flat price',
      amount: new Prisma.Decimal(input.amount),
      affectsProfit: true,
      note: 'Initial agreement value',
    },
  })
}

export async function updateBaseAgreementLine(
  db: AgreementDb,
  input: {
    customerId: string
    companyId: string
    siteId?: string | null
    amount: number
  },
) {
  const existing = await db.customerAgreementLine.findFirst({
    where: { customerId: input.customerId, type: 'BASE_PRICE', isDeleted: false },
    orderBy: { createdAt: 'asc' },
  })

  if (existing) {
    return db.customerAgreementLine.update({
      where: { id: existing.id },
      data: {
        amount: new Prisma.Decimal(input.amount),
        companyId: input.companyId,
        siteId: input.siteId ?? null,
      },
    })
  }

  return createBaseAgreementLine(db, input)
}

async function assertAgreementCanCoverPaid(customerId: string, nextPayableTotal: number, db: AgreementDb = prisma) {
  const paidTotal = await getCustomerPaidTotal(customerId, db)
  if (nextPayableTotal < paidTotal) {
    return {
      error: 'Agreement total cannot be lower than the amount already collected. Record a refund or credit first.',
      status: 400 as const,
    }
  }

  return null
}

function mapAgreementMutationError(err: unknown) {
  if (err instanceof Error && err.message === 'AGREEMENT_BELOW_PAID') {
    return {
      error: 'Agreement total cannot be lower than the amount already collected. Record a refund or credit first.',
      status: 400 as const,
    }
  }

  throw err
}

function normalizeLineInput(data: CustomerAgreementLineInput) {
  const label = data.label.trim()
  const affectsProfit = data.affectsProfit ?? defaultAffectsProfit(data.type)

  return {
    type: data.type,
    label,
    amount: new Prisma.Decimal(data.amount),
    ratePercent: data.ratePercent ?? null,
    calculationBase: data.calculationBase !== undefined ? new Prisma.Decimal(data.calculationBase) : null,
    affectsProfit,
    note: data.note?.trim() || null,
  }
}

async function invalidateAgreementCaches(companyId: string, siteId: string | null, flatId: string | null) {
  if (siteId) await invalidateCustomerCaches(companyId, siteId)
  if (flatId) await cacheService.del(CacheKeys.flatCustomer(flatId))
}

export async function getAgreementForUser(customerId: string, userId: string) {
  const { company, customer } = await getCustomerForUser(customerId, userId, { includeCancelled: true })
  if (!company) return { error: 'Company not found', status: 404 as const }
  if (!customer) return { error: 'Customer not found', status: 404 as const }

  const [lines, totals, amountPaid] = await Promise.all([
    prisma.customerAgreementLine.findMany({
      where: { customerId, isDeleted: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    getCustomerAgreementTotals(customerId),
    getCustomerPaidTotal(customerId),
  ])

  return {
    agreement: {
      customerId,
      lines: lines.map(mapAgreementLine),
      totals,
      amountPaid,
      remaining: totals.payableTotal - amountPaid,
    },
  }
}

export async function addAgreementLineForUser(customerId: string, userId: string, data: CustomerAgreementLineInput) {
  const { company, customer } = await getCustomerForUser(customerId, userId)
  if (!company) return { error: 'Company not found', status: 404 as const }
  if (!customer) return { error: 'Customer not found', status: 404 as const }

  if (data.type === 'BASE_PRICE') {
    const existingBaseLine = await prisma.customerAgreementLine.findFirst({
      where: { customerId, type: 'BASE_PRICE', isDeleted: false },
      select: { id: true },
    })
    if (existingBaseLine) {
      return {
        error: 'Base price already exists for this customer. Edit the current base price instead.',
        status: 400 as const,
      }
    }
  }

  const result = await prisma
    .$transaction(async (tx) => {
      const line = await tx.customerAgreementLine.create({
        data: {
          ...normalizeLineInput(data),
          customerId,
          companyId: company.id,
          siteId: customer.siteId,
        },
      })
      const totals = await getCustomerAgreementTotals(customerId, tx)
      const error = await assertAgreementCanCoverPaid(customerId, totals.payableTotal, tx)
      if (error) throw new Error('AGREEMENT_BELOW_PAID')
      await syncCustomerAgreementPayable(customerId, tx)

      return { line, totals }
    })
    .catch(mapAgreementMutationError)

  if ('error' in result) return result

  await invalidateAgreementCaches(company.id, customer.siteId, customer.flatId)

  return {
    line: mapAgreementLine(result.line),
    totals: result.totals,
  }
}

export async function updateAgreementLineForUser(
  customerId: string,
  lineId: string,
  userId: string,
  data: CustomerAgreementLineInput,
) {
  const { company, customer } = await getCustomerForUser(customerId, userId)
  if (!company) return { error: 'Company not found', status: 404 as const }
  if (!customer) return { error: 'Customer not found', status: 404 as const }

  const existing = await prisma.customerAgreementLine.findFirst({
    where: { id: lineId, customerId, isDeleted: false },
  })
  if (!existing) return { error: 'Agreement line not found', status: 404 as const }

  const result = await prisma
    .$transaction(async (tx) => {
      const line = await tx.customerAgreementLine.update({
        where: { id: lineId },
        data: normalizeLineInput(data),
      })
      const totals = await getCustomerAgreementTotals(customerId, tx)
      const error = await assertAgreementCanCoverPaid(customerId, totals.payableTotal, tx)
      if (error) throw new Error('AGREEMENT_BELOW_PAID')
      await syncCustomerAgreementPayable(customerId, tx)

      return { line, totals }
    })
    .catch(mapAgreementMutationError)

  if ('error' in result) return result

  await invalidateAgreementCaches(company.id, customer.siteId, customer.flatId)

  return {
    line: mapAgreementLine(result.line),
    totals: result.totals,
  }
}

export async function deleteAgreementLineForUser(customerId: string, lineId: string, userId: string) {
  const { company, customer } = await getCustomerForUser(customerId, userId)
  if (!company) return { error: 'Company not found', status: 404 as const }
  if (!customer) return { error: 'Customer not found', status: 404 as const }

  const existing = await prisma.customerAgreementLine.findFirst({
    where: { id: lineId, customerId, isDeleted: false },
  })
  if (!existing) return { error: 'Agreement line not found', status: 404 as const }
  if (existing.type === 'BASE_PRICE') {
    return {
      error: 'Base price cannot be removed. Edit the base price instead.',
      status: 400 as const,
    }
  }

  const result = await prisma
    .$transaction(async (tx) => {
      await tx.customerAgreementLine.update({ where: { id: lineId }, data: { isDeleted: true } })
      const totals = await getCustomerAgreementTotals(customerId, tx)
      const error = await assertAgreementCanCoverPaid(customerId, totals.payableTotal, tx)
      if (error) throw new Error('AGREEMENT_BELOW_PAID')
      await syncCustomerAgreementPayable(customerId, tx)

      return totals
    })
    .catch(mapAgreementMutationError)

  if ('error' in result) return result

  await invalidateAgreementCaches(company.id, customer.siteId, customer.flatId)

  return {
    message: 'Agreement line removed',
    totals: result,
  }
}

export async function getSiteAgreementFinancials(siteId: string, db: AgreementDb = prisma) {
  const customers = await db.customer.findMany({
    where: { siteId, isDeleted: false, dealStatus: 'ACTIVE' },
    select: {
      sellingPrice: true,
      agreementLines: {
        where: { isDeleted: false },
        select: { type: true, amount: true, affectsProfit: true },
      },
    },
  })

  return customers.reduce(
    (sum, customer) => {
      const totals = calculateAgreementTotals(customer.agreementLines, customer.sellingPrice)
      sum.payableTotal += totals.payableTotal
      sum.profitRevenue += totals.profitRevenue
      sum.tax += totals.tax
      sum.discounts += totals.discounts
      sum.credits += totals.credits
      sum.charges += totals.charges
      sum.basePrice += totals.basePrice
      return sum
    },
    {
      basePrice: 0,
      charges: 0,
      tax: 0,
      discounts: 0,
      credits: 0,
      payableTotal: 0,
      profitRevenue: 0,
    },
  )
}
