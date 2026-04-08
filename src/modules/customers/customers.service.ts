import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { getCustomerPaidTotal, getCustomerRemaining } from '../../services/customer-ledger.service.js'
import { createLedgerEntry, LedgerError } from '../../services/ledger.service.js'
import { getSiteBalance } from '../../services/ledger-read.service.js'
import { invalidateCustomerCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { verifySiteOwnership } from './customer-access.service.js'
import {
  mapBookingCustomerResponse,
  mapCompanyCustomerSummary,
  mapFlatCustomerResponse,
  mapSiteCustomerResponse,
  mapUpdatedCustomerResponse,
} from './customers.mapper.js'

export type CustomerServiceError = {
  error: string
  status: number
  availableFund?: number
  refundAmount?: number
  shortfall?: number
}

type BookingSuccessResult = {
  customer: {
    id: string
    name: string
    phone: string | null
    email: string | null
    sellingPrice: number
    bookingAmount: number
    customerType: string
    flatId: string | null
    createdAt: Date
  }
  flatNumber: number | null
  floorNumber: number
  flatStatus: 'BOOKED' | 'SOLD'
  amountPaid: number
  remaining: number
}

export function isCustomerServiceError(result: unknown): result is CustomerServiceError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

function normalizeCurrencyAmount(value: number) {
  return Number(value.toFixed(2))
}

async function buildCancelBookingInsufficientFundsError(siteId: string, refundAmount: number): Promise<CustomerServiceError> {
  const availableFund = normalizeCurrencyAmount(await getSiteBalance(siteId))
  const normalizedRefundAmount = normalizeCurrencyAmount(refundAmount)
  const shortfall = normalizeCurrencyAmount(Math.max(0, normalizedRefundAmount - availableFund))

  return {
    error: 'INSUFFICIENT_FUNDS',
    status: 400,
    availableFund,
    refundAmount: normalizedRefundAmount,
    shortfall,
  }
}

export async function getAllCustomersForUser(userId: string, status?: 'BOOKED' | 'SOLD') {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const cacheKey = `${CacheKeys.customerList(company.id)}:${status ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const customers = await prisma.customer.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      ...(status ? { flat: { status } } : {}),
    },
    include: {
      ledgerEntries: { select: { amount: true } },
      flat: { include: { floor: true } },
      site: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    customers: customers.map(mapCompanyCustomerSummary),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function bookFlatForUser(
  siteId: string,
  flatId: string,
  userId: string,
  data: {
    name: string
    phone?: string
    email?: string
    sellingPrice: number
    bookingAmount: number
    customerType?: 'CUSTOMER' | 'EXISTING_OWNER'
  },
) {
  const { company, site } = await verifySiteOwnership(siteId, userId)
  if (!company || !site) return { error: 'Site not found', status: 404 }

  if (data.bookingAmount > data.sellingPrice) {
    return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }
  }

  const result = await prisma
    .$transaction(
      async (tx: Prisma.TransactionClient) => {
        const flat = await tx.flat.findFirst({
          where: { id: flatId, siteId: site.id },
          include: { floor: true },
        })
        if (!flat) throw new Error('FLAT_NOT_FOUND')
        if (flat.status !== 'AVAILABLE') throw new Error('FLAT_NOT_AVAILABLE')

        const forcedCustomerType = flat.flatType === 'EXISTING_OWNER' ? 'EXISTING_OWNER' : 'CUSTOMER'

        const customer = await tx.customer.create({
          data: {
            flatId: flat.id,
            siteId: site.id,
            companyId: company.id,
            name: data.name,
            phone: data.phone,
            email: data.email,
            sellingPrice: data.sellingPrice,
            bookingAmount: data.bookingAmount,
            customerType: forcedCustomerType,
          },
        })

        if (data.bookingAmount > 0) {
          await createLedgerEntry(
            {
              companyId: company.id,
              siteId: site.id,
              walletType: 'SITE',
              direction: 'IN',
              movementType: 'CUSTOMER_PAYMENT',
              amount: new Prisma.Decimal(data.bookingAmount),
              idempotencyKey: `customer-booking:${customer.id}:${Date.now()}`,
              note: 'Initial booking amount',
              customerId: customer.id,
            },
            tx,
          )
        }

        const newStatus = data.bookingAmount >= data.sellingPrice ? ('SOLD' as const) : ('BOOKED' as const)
        await tx.flat.update({
          where: { id: flat.id },
          data: { status: newStatus },
        })

        const amountPaid = await getCustomerPaidTotal(customer.id, tx)
        const remaining = await getCustomerRemaining(customer.id, tx)

        return {
          customer,
          flatNumber: flat.flatNumber,
          floorNumber: flat.floor.floorNumber,
          flatStatus: newStatus,
          amountPaid,
          remaining,
        }
      },
      LEDGER_TX_OPTIONS,
    )
    .catch((err: unknown) => {
      if (err instanceof Error && err.message === 'FLAT_NOT_FOUND') {
        return { error: 'Flat not found', status: 404 as const }
      }
      if (err instanceof Error && err.message === 'FLAT_NOT_AVAILABLE') {
        return { error: 'Flat is not available for booking', status: 400 as const }
      }
      throw err
    })

  if (isCustomerServiceError(result)) return result

  const bookingResult = result as BookingSuccessResult

  await invalidateCustomerCaches(company.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  const customerType =
    bookingResult.customer.customerType === 'CUSTOMER' || bookingResult.customer.customerType === 'EXISTING_OWNER'
      ? bookingResult.customer.customerType
      : null

  return {
    customer: mapBookingCustomerResponse({
      ...bookingResult,
      customer: {
        ...bookingResult.customer,
        customerType,
      },
    }),
  }
}

export async function getSiteCustomersForUser(siteId: string, userId: string) {
  const { site } = await verifySiteOwnership(siteId, userId)
  if (!site) return { error: 'Site not found', status: 404 }

  const cacheKey = CacheKeys.siteCustomers(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const customers = await prisma.customer.findMany({
    where: { siteId: site.id, isDeleted: false },
    include: {
      ledgerEntries: { select: { amount: true } },
      flat: { include: { floor: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    customers: customers.map((customer) => mapSiteCustomerResponse(customer as any)),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function getFlatCustomerForUser(siteId: string, flatId: string, userId: string) {
  const { site } = await verifySiteOwnership(siteId, userId)
  if (!site) return { error: 'Site not found', status: 404 }

  const cacheKey = CacheKeys.flatCustomer(flatId)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const customer = await prisma.customer.findFirst({
    where: { flatId, siteId: site.id, isDeleted: false },
    include: {
      ledgerEntries: { select: { amount: true } },
      flat: { include: { floor: true } },
    },
  })
  if (!customer) return { error: 'No customer found for this flat', status: 404 }

  const responseData = {
    customer: mapFlatCustomerResponse(customer as any),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_DETAIL)
  return responseData
}

export async function updateCustomerForUser(
  siteId: string,
  flatId: string,
  customerId: string,
  userId: string,
  data: { name?: string; phone?: string; email?: string },
) {
  const { site } = await verifySiteOwnership(siteId, userId)
  if (!site) return { error: 'Site not found', status: 404 }

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, flatId, siteId: site.id },
  })
  if (!existing) return { error: 'Customer not found', status: 404 }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data,
      include: {
        ledgerEntries: { select: { amount: true } },
        flat: { include: { floor: true } },
      },
    })

    const amountPaid = customer.ledgerEntries.reduce((sum, entry) => sum + Number(entry.amount), 0)

    let flatStatus = customer.flat!.status
    if (amountPaid >= customer.sellingPrice && flatStatus !== 'SOLD') {
      await tx.flat.update({ where: { id: flatId }, data: { status: 'SOLD' } })
      flatStatus = 'SOLD'
    }

    const remaining = await getCustomerRemaining(customer.id, tx)

    return { customer, flatStatus, amountPaid, remaining }
  }, LEDGER_TX_OPTIONS)

  const { company } = await verifySiteOwnership(siteId, userId)
  if (company) await invalidateCustomerCaches(company.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  return {
    customer: mapUpdatedCustomerResponse(result as any),
  }
}

export async function cancelBookingForUser(siteId: string, flatId: string, customerId: string, userId: string) {
  const { company, site } = await verifySiteOwnership(siteId, userId)
  if (!company || !site) return { error: 'Site not found', status: 404 }

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, flatId, siteId: site.id, isDeleted: false },
  })
  if (!existing) return { error: 'Customer not found', status: 404 }

  const refundAmount = await getCustomerPaidTotal(customerId)
  if (refundAmount > 0) {
    const availableFund = await getSiteBalance(site.id)
    if (refundAmount > availableFund) {
      return buildCancelBookingInsufficientFundsError(site.id, refundAmount)
    }
  }

  const transactionResult = await prisma
    .$transaction(async (tx: Prisma.TransactionClient) => {
      if (refundAmount > 0) {
        await createLedgerEntry(
          {
            companyId: company.id,
            siteId: site.id,
            walletType: 'SITE',
            direction: 'OUT',
            movementType: 'CUSTOMER_REFUND',
            amount: new Prisma.Decimal(refundAmount),
            idempotencyKey: `customer-cancel:${customerId}:refund`,
            note: 'Booking cancelled refund',
            customerId,
          },
          tx,
        )
      }

      await tx.customer.update({
        where: { id: customerId },
        data: { isDeleted: true, flatId: null },
      })
      await tx.flat.update({
        where: { id: flatId },
        data: { status: 'AVAILABLE' },
      })
    }, LEDGER_TX_OPTIONS)
    .catch(async (err: unknown) => {
      if (err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS') {
        return buildCancelBookingInsufficientFundsError(site.id, refundAmount)
      }

      throw err
    })

  if (isCustomerServiceError(transactionResult)) return transactionResult

  await invalidateCustomerCaches(company.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  return { message: `Booking for "${existing.name}" cancelled. Flat is now available.` }
}
