import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCustomerPaidTotal, getCustomerRemaining } from '../../services/customer-ledger.service.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import { createCustomerReceiptForPayment } from '../../services/receipt.service.js'
import { invalidateCustomerCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys } from '../../config/cache-keys.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { getCustomerForUser } from './customer-access.service.js'
import { mapCustomerPaymentHistoryItem } from './customers.mapper.js'

export async function recordCustomerPaymentForUser(
  customerId: string,
  userId: string,
  data: {
    amount: number
    note?: string
    idempotencyKey?: string
    paymentMode: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI'
    referenceNumber?: string
  },
) {
  const { company, customer } = await getCustomerForUser(customerId, userId)
  if (!company) return { error: 'Company not found', status: 404 }
  if (!customer) return { error: 'Customer not found', status: 404 }

  const customerWithLedger = await prisma.customer.findFirst({
    where: { id: customerId, companyId: company.id, isDeleted: false, dealStatus: 'ACTIVE' },
    select: { id: true, siteId: true, flatId: true },
  })
  if (!customerWithLedger) return { error: 'Customer not found', status: 404 }

  const normalizedReferenceNumber = data.referenceNumber?.trim() || undefined

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
        paymentMode: data.paymentMode,
        referenceNumber: normalizedReferenceNumber,
        customerId,
      },
      tx,
    )

    const receipt = await createCustomerReceiptForPayment(payment.id, userId, tx)
    const amountPaid = await getCustomerPaidTotal(customerWithLedger.id, tx)
    const paymentCustomer = await tx.customer.findUnique({
      where: { id: customerWithLedger.id },
      select: { sellingPrice: true, flatId: true },
    })

    if (paymentCustomer && amountPaid >= paymentCustomer.sellingPrice && paymentCustomer.flatId) {
      await tx.flat.update({
        where: { id: paymentCustomer.flatId },
        data: { status: 'SOLD' },
      })
    }

    const remaining = await getCustomerRemaining(customerWithLedger.id, tx)

    return { payment, receipt, amountPaid, remaining }
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
      paymentMode: result.payment.paymentMode,
      referenceNumber: result.payment.referenceNumber,
      note: result.payment.note,
      createdAt: result.payment.postedAt,
    },
    receipt: {
      id: result.receipt.id,
      receiptNumber: result.receipt.receiptNumber,
      status: result.receipt.status,
      createdAt: result.receipt.createdAt,
    },
  }
}

export async function getCustomerPaymentsForUser(customerId: string, userId: string) {
  const { company, customer } = await getCustomerForUser(customerId, userId, { includeCancelled: true })
  if (!company) return { error: 'Company not found', status: 404 }
  if (!customer) return { error: 'Customer not found', status: 404 }

  const payments = await prisma.payment.findMany({
    where: { customerId, companyId: company.id },
    orderBy: { postedAt: 'desc' },
    include: {
      receipt: {
        select: {
          id: true,
          receiptNumber: true,
          status: true,
        },
      },
      reversalEntry: {
        select: {
          id: true,
        },
      },
    },
  })

  return {
    payments: payments.map(mapCustomerPaymentHistoryItem),
  }
}
