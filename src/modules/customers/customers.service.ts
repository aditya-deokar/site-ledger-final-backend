import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { getCustomerPaidTotal, getCustomerRemaining, sumDirectionalLedgerAmounts } from '../../services/customer-ledger.service.js'
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
    dealStatus: 'ACTIVE' | 'CANCELLED'
    flatId: string | null
    createdAt: Date
  }
  flatNumber: number | null
  customFlatId: string | null
  floorNumber: number
  floorName: string | null
  flatStatus: 'BOOKED' | 'SOLD'
  amountPaid: number
  remaining: number
}

type CancelDealInput = {
  reason: string
  refundAmount: number
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

function getFlatDisplayName(flat: {
  flatNumber: number | null
  customFlatId: string | null
}) {
  return flat.customFlatId || `Flat ${flat.flatNumber ?? '-'}`
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
      dealStatus: 'ACTIVE',
      ...(status ? { flat: { status } } : {}),
    },
    include: {
      ledgerEntries: { select: { amount: true, direction: true } },
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
          customFlatId: flat.customFlatId,
          floorNumber: flat.floor.floorNumber,
          floorName: flat.floor.floorName,
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
      customFlatId: bookingResult.customFlatId,
      floorName: bookingResult.floorName,
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
    where: { siteId: site.id, isDeleted: false, dealStatus: 'ACTIVE' },
    include: {
      ledgerEntries: { select: { amount: true, direction: true } },
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
    where: { flatId, siteId: site.id, isDeleted: false, dealStatus: 'ACTIVE' },
    include: {
      ledgerEntries: { select: { amount: true, direction: true } },
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
    where: { id: customerId, flatId, siteId: site.id, isDeleted: false, dealStatus: 'ACTIVE' },
  })
  if (!existing) return { error: 'Customer not found', status: 404 }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data,
      include: {
        ledgerEntries: { select: { amount: true, direction: true } },
        flat: { include: { floor: true } },
      },
    })

    const amountPaid = sumDirectionalLedgerAmounts(customer.ledgerEntries)

    let flatStatus = customer.flat!.status
    if (amountPaid >= customer.sellingPrice && flatStatus !== 'SOLD') {
      await tx.flat.update({ where: { id: flatId }, data: { status: 'SOLD' } })
      flatStatus = 'SOLD'
    }

    const remaining = await getCustomerRemaining(customer.id, tx)

    return {
      customer: {
        ...customer,
        flat: customer.flat
          ? {
              ...customer.flat,
              status: flatStatus,
            }
          : null,
      },
      amountPaid,
      remaining,
    }
  }, LEDGER_TX_OPTIONS)

  const { company } = await verifySiteOwnership(siteId, userId)
  if (company) await invalidateCustomerCaches(company.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  return {
    customer: mapUpdatedCustomerResponse(result as any),
  }
}

export async function cancelDealForUser(
  siteId: string,
  flatId: string,
  customerId: string,
  userId: string,
  data: CancelDealInput,
) {
  const { company, site } = await verifySiteOwnership(siteId, userId)
  if (!company || !site) return { error: 'Site not found', status: 404 }

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, flatId, siteId: site.id, isDeleted: false, dealStatus: 'ACTIVE' },
    include: {
      ledgerEntries: { select: { amount: true, direction: true } },
      flat: {
        include: {
          floor: true,
        },
      },
    },
  })
  if (!existing) return { error: 'Customer not found', status: 404 }

  const refundAmount = normalizeCurrencyAmount(data.refundAmount)
  const netPaid = normalizeCurrencyAmount(sumDirectionalLedgerAmounts(existing.ledgerEntries))
  if (refundAmount < 0) {
    return { error: 'Refund amount must be zero or greater', status: 400 }
  }
  if (refundAmount > netPaid) {
    return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }
  }
  if (refundAmount > 0) {
    const availableFund = await getSiteBalance(site.id)
    if (refundAmount > availableFund) {
      return buildCancelBookingInsufficientFundsError(site.id, refundAmount)
    }
  }

  const transactionResult = await prisma
    .$transaction(async (tx: Prisma.TransactionClient) => {
      const flat = await tx.flat.findFirst({
        where: { id: flatId, siteId: site.id },
        include: { floor: true },
      })
      if (!flat) throw new Error('FLAT_NOT_FOUND')
      if (flat.status === 'AVAILABLE') throw new Error('FLAT_ALREADY_AVAILABLE')

      const customer = await tx.customer.findFirst({
        where: { id: customerId, flatId, siteId: site.id, isDeleted: false, dealStatus: 'ACTIVE' },
        include: {
          ledgerEntries: { select: { amount: true, direction: true } },
          flat: { include: { floor: true } },
        },
      })
      if (!customer || !customer.flat) throw new Error('CUSTOMER_NOT_FOUND')

      const customerNetPaid = normalizeCurrencyAmount(sumDirectionalLedgerAmounts(customer.ledgerEntries))
      if (refundAmount > customerNetPaid) throw new Error('REFUND_EXCEEDS_NET_PAID')

      const snapshotFlat = customer.flat

      let refundPayment: {
        id: string
        amount: number
        direction: 'OUT'
        movementType: 'CUSTOMER_REFUND'
      } | null = null

      if (refundAmount > 0) {
        const payment = await createLedgerEntry(
          {
            companyId: company.id,
            siteId: site.id,
            walletType: 'SITE',
            direction: 'OUT',
            movementType: 'CUSTOMER_REFUND',
            amount: new Prisma.Decimal(refundAmount),
            idempotencyKey: `customer-cancel:${customerId}:${Date.now()}:refund`,
            note: data.reason,
            customerId,
          },
          tx,
        )

        refundPayment = {
          id: payment.id,
          amount: Number(payment.amount),
          direction: 'OUT',
          movementType: 'CUSTOMER_REFUND',
        }
      }

      const customerAfterCancel = await tx.customer.update({
        where: { id: customerId },
        data: {
          dealStatus: 'CANCELLED',
          isDeleted: false,
          flatId: null,
          cancelledAt: new Date(),
          cancellationReason: data.reason,
          cancelledByUserId: userId,
          cancelledFromFlatStatus: snapshotFlat.status,
          cancelledFlatId: snapshotFlat.id,
          cancelledFlatDisplay: getFlatDisplayName(snapshotFlat),
          cancelledFloorNumber: snapshotFlat.floor.floorNumber,
          cancelledFloorName: snapshotFlat.floor.floorName,
        },
        include: {
          ledgerEntries: { select: { amount: true, direction: true } },
          flat: { include: { floor: true } },
        },
      })

      const flatAfterCancel = await tx.flat.update({
        where: { id: flatId },
        data: { status: 'AVAILABLE' },
      })

      const amountPaid = await getCustomerPaidTotal(customerId, tx)
      const remaining = await getCustomerRemaining(customerId, tx)

      return {
        customer: customerAfterCancel,
        refund: refundPayment,
        flat: flatAfterCancel,
        amountPaid,
        remaining,
      }
    }, LEDGER_TX_OPTIONS)
    .catch(async (err: unknown) => {
      if (err instanceof Error && (err.message === 'FLAT_NOT_FOUND' || err.message === 'CUSTOMER_NOT_FOUND')) {
        return { error: 'Customer not found', status: 404 as const }
      }
      if (err instanceof Error && err.message === 'FLAT_ALREADY_AVAILABLE') {
        return { error: 'Flat is already available', status: 400 as const }
      }
      if (err instanceof Error && err.message === 'REFUND_EXCEEDS_NET_PAID') {
        return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 as const }
      }
      if (err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS') {
        return buildCancelBookingInsufficientFundsError(site.id, refundAmount)
      }

      throw err
    })

  if (isCustomerServiceError(transactionResult)) return transactionResult

  await invalidateCustomerCaches(company.id, siteId)
  await cacheService.del(CacheKeys.flatCustomer(flatId))

  return {
    customer: mapUpdatedCustomerResponse({
      customer: transactionResult.customer as any,
      amountPaid: transactionResult.amountPaid,
      remaining: transactionResult.remaining,
    }),
    refund: transactionResult.refund,
    flat: {
      id: transactionResult.flat.id,
      status: transactionResult.flat.status,
    },
  }
}

export async function cancelBookingForUser(siteId: string, flatId: string, customerId: string, userId: string) {
  const { company, site } = await verifySiteOwnership(siteId, userId)
  if (!company || !site) return { error: 'Site not found', status: 404 }

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, flatId, siteId: site.id, isDeleted: false, dealStatus: 'ACTIVE' },
    include: {
      ledgerEntries: { select: { amount: true, direction: true } },
    },
  })
  if (!existing) return { error: 'Customer not found', status: 404 }

  const netPaid = normalizeCurrencyAmount(sumDirectionalLedgerAmounts(existing.ledgerEntries))

  const result = await cancelDealForUser(siteId, flatId, customerId, userId, {
    reason: 'Legacy delete cancel',
    refundAmount: netPaid,
  })

  if (isCustomerServiceError(result)) return result

  return { message: `Booking for "${existing.name}" cancelled. Flat is now available.` }
}
