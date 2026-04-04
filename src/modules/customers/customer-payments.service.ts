import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCustomerPaidTotal, getCustomerRemaining } from '../../services/customer-ledger.service.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import { invalidateCustomerCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { getCustomerForUser } from './customer-access.service.js'
import { mapCustomerPaymentHistoryItem } from './customers.mapper.js'

export async function recordCustomerPaymentForUser(
  customerId: string,
  userId: string,
  data: { amount: number; note?: string; idempotencyKey?: string },
) {
  const { company, customer } = await getCustomerForUser(customerId, userId)
  if (!company) return { error: 'Company not found', status: 404 }
  if (!customer) return { error: 'Customer not found', status: 404 }

  const customerWithLedger = await prisma.customer.findFirst({
    where: { id: customerId, companyId: company.id, isDeleted: false },
    include: { ledgerEntries: { select: { amount: true } } },
  })
  if (!customerWithLedger) return { error: 'Customer not found', status: 404 }

  const currentPaid = customerWithLedger.ledgerEntries.reduce((sum, entry) => sum + Number(entry.amount), 0)
  const newTotal = currentPaid + data.amount
  if (newTotal > customerWithLedger.sellingPrice) {
    return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const payment = await createLedgerEntry(
      {
        companyId: company.id,
        siteId: customerWithLedger.siteId,
        walletType: 'SITE',
        direction: 'IN',
        movementType: 'CUSTOMER_PAYMENT',
        amount: new Prisma.Decimal(data.amount),
        idempotencyKey: data.idempotencyKey ?? `customer-payment:${customerId}:${Date.now()}`,
        note: data.note || 'Installment payment',
        customerId,
      },
      tx,
    )

    if (newTotal >= customerWithLedger.sellingPrice && customerWithLedger.flatId) {
      await tx.flat.update({
        where: { id: customerWithLedger.flatId },
        data: { status: 'SOLD' },
      })
    }

    const amountPaid = await getCustomerPaidTotal(customerWithLedger.id, tx)
    const remaining = await getCustomerRemaining(customerWithLedger.id, tx)

    return { payment, amountPaid, remaining }
  }, LEDGER_TX_OPTIONS)

  await invalidateCustomerCaches(company.id, customerWithLedger.siteId!)
  if (customerWithLedger.flatId) await cacheService.del(CacheKeys.flatCustomer(customerWithLedger.flatId))

  return {
    customer: {
      id: customerWithLedger.id,
      amountPaid: result.amountPaid,
      remaining: result.remaining,
    },
    payment: {
      id: result.payment.id,
      amount: Number(result.payment.amount),
      createdAt: result.payment.postedAt,
    },
  }
}

export async function getCustomerPaymentsForUser(customerId: string, userId: string) {
  const { company, customer } = await getCustomerForUser(customerId, userId)
  if (!company) return { error: 'Company not found', status: 404 }
  if (!customer) return { error: 'Customer not found', status: 404 }

  const payments = await prisma.payment.findMany({
    where: { customerId, companyId: company.id },
    orderBy: { postedAt: 'desc' },
  })

  return {
    payments: payments.map(mapCustomerPaymentHistoryItem),
  }
}