import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { getCustomerPaidTotal } from '../../services/customer-ledger.service.js'
import {
  invalidateCustomerCaches,
  invalidateExpenseCaches,
  invalidateInvestorCaches,
  invalidateInvestorDetailCaches,
  invalidateVendorCaches,
  invalidateWithdrawalCaches,
} from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys } from '../../config/cache-keys.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import { getReceiptByPaymentId, voidReceiptForPayment } from '../../services/receipt.service.js'
import { syncInvestorClosedState } from '../../services/investor-ledger.service.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'

const reversiblePaymentInclude = Prisma.validator<Prisma.PaymentInclude>()({
  receipt: {
    select: {
      id: true,
      receiptNumber: true,
      status: true,
      voidedAt: true,
      voidReason: true,
      createdAt: true,
    },
  },
  reversalEntry: {
    select: {
      id: true,
      amount: true,
      direction: true,
      movementType: true,
      postedAt: true,
      reversalOfPaymentId: true,
      note: true,
      idempotencyKey: true,
    },
  },
  customer: {
    select: {
      id: true,
      flatId: true,
      siteId: true,
      sellingPrice: true,
      dealStatus: true,
    },
  },
  expense: {
    select: {
      id: true,
      siteId: true,
      vendorId: true,
    },
  },
  investorTransaction: {
    select: {
      id: true,
      investor: {
        select: {
          id: true,
          siteId: true,
        },
      },
    },
  },
  companyWithdrawal: {
    select: {
      id: true,
    },
  },
})

type ReversiblePaymentRecord = Prisma.PaymentGetPayload<{
  include: typeof reversiblePaymentInclude
}>

export type PaymentServiceError = {
  error: string
  status: number
}

function isReversalSupported(payment: ReversiblePaymentRecord) {
  if (payment.movementType === 'REVERSAL' || payment.movementType === 'ADJUSTMENT') return false
  if (payment.partnerId) return false
  if (payment.movementType === 'COMPANY_TO_SITE_TRANSFER' || payment.movementType === 'SITE_TO_COMPANY_TRANSFER') return false
  if (payment.movementType === 'SALARY_PAYMENT') return false

  return Boolean(
    payment.customerId
    || payment.expenseId
    || payment.investorTransactionId
    || payment.companyWithdrawalId,
  )
}

function mapReceiptSummary(receipt: {
  id: string
  receiptNumber: string
  status: 'ACTIVE' | 'VOIDED'
  voidedAt: Date | null
  voidReason: string | null
  createdAt: Date
} | null) {
  if (!receipt) return null

  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    status: receipt.status,
    voidedAt: receipt.voidedAt?.toISOString() ?? null,
    voidReason: receipt.voidReason,
    createdAt: receipt.createdAt.toISOString(),
  }
}

function mapReversalResponse(
  payment: ReversiblePaymentRecord,
  reversal: {
    id: string
    amount: Prisma.Decimal | number | string
    direction: 'IN' | 'OUT'
    movementType: string
    reversalOfPaymentId: string | null
    note: string | null
    postedAt: Date
  },
) {
  return {
    payment: {
      id: payment.id,
      amount: Number(payment.amount),
      direction: payment.direction,
      movementType: payment.movementType,
      reversedAt: payment.reversedAt?.toISOString() ?? reversal.postedAt.toISOString(),
      reversalReason: payment.reversalReason ?? null,
    },
    reversal: {
      id: reversal.id,
      amount: Number(reversal.amount),
      direction: reversal.direction,
      movementType: 'REVERSAL',
      reversalOfPaymentId: reversal.reversalOfPaymentId ?? payment.id,
      note: reversal.note,
      createdAt: reversal.postedAt.toISOString(),
    },
    receipt: mapReceiptSummary(payment.receipt),
  }
}

async function getPaymentForCompany(
  paymentId: string,
  companyId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return db.payment.findFirst({
    where: { id: paymentId, companyId },
    include: reversiblePaymentInclude,
  })
}

async function syncCustomerFlatStatus(payment: ReversiblePaymentRecord, tx: Prisma.TransactionClient) {
  if (!payment.customer || payment.customer.dealStatus !== 'ACTIVE' || !payment.customer.flatId) {
    return
  }

  const amountPaid = await getCustomerPaidTotal(payment.customer.id, tx)
  const nextStatus = amountPaid >= payment.customer.sellingPrice ? 'SOLD' : 'BOOKED'

  await tx.flat.update({
    where: { id: payment.customer.flatId },
    data: { status: nextStatus },
  })
}

async function invalidateReversalSideEffects(payment: ReversiblePaymentRecord) {
  if (payment.customerId && payment.siteId) {
    await invalidateCustomerCaches(payment.companyId, payment.siteId)
    if (payment.customer?.flatId) {
      await cacheService.del(CacheKeys.flatCustomer(payment.customer.flatId))
    }
  }

  if (payment.expenseId && payment.expense) {
    await invalidateExpenseCaches(payment.companyId, payment.expense.siteId)
    if (payment.expense.vendorId) {
      await invalidateVendorCaches(payment.companyId, payment.expense.vendorId)
    }
  }

  if (payment.investorTransactionId && payment.investorTransaction) {
    await invalidateInvestorCaches(payment.companyId, payment.investorTransaction.investor.siteId)
    await invalidateInvestorDetailCaches(payment.investorTransaction.investor.id)
  }

  if (payment.companyWithdrawalId) {
    await invalidateWithdrawalCaches(payment.companyId)
  }
}

export function isPaymentServiceError(value: unknown): value is PaymentServiceError {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value
}

export async function getPaymentReceiptForUser(paymentId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'Company not found', status: 404 as const }

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, companyId: company.id },
    select: { id: true },
  })
  if (!payment) return { error: 'Payment not found', status: 404 as const }

  const receipt = await getReceiptByPaymentId(paymentId)
  if (!receipt) return { error: 'Receipt not found', status: 404 as const }

  return { receipt }
}

export async function reversePaymentForUser(
  paymentId: string,
  userId: string,
  data: { reason: string; idempotencyKey?: string },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'Company not found', status: 404 as const }

  const normalizedReason = data.reason.trim()
  const baseIdempotencyKey = data.idempotencyKey?.trim() || `payment-reversal:${paymentId}`

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Payment"
      WHERE id = ${paymentId}
        AND "companyId" = ${company.id}
      FOR UPDATE
    `

    const payment = await getPaymentForCompany(paymentId, company.id, tx)
    if (!payment) throw new Error('PAYMENT_NOT_FOUND')

    if (!isReversalSupported(payment)) {
      throw new Error('PAYMENT_REVERSAL_NOT_SUPPORTED')
    }

    if (payment.reversalEntry) {
      return {
        payment,
        reversal: payment.reversalEntry,
      }
    }

    if (payment.reversedAt) {
      throw new Error('PAYMENT_ALREADY_REVERSED')
    }

    const reversal = await createLedgerEntry(
      {
        companyId: payment.companyId,
        siteId: payment.siteId,
        walletType: payment.walletType,
        direction: payment.direction === 'IN' ? 'OUT' : 'IN',
        movementType: 'REVERSAL',
        amount: new Prisma.Decimal(payment.amount),
        idempotencyKey: `${baseIdempotencyKey}:reverse`,
        note: `Reversal of payment ${payment.id}: ${normalizedReason}`,
        paymentMode: payment.paymentMode ?? undefined,
        referenceNumber: payment.referenceNumber ?? undefined,
        customerId: payment.customerId ?? undefined,
        expenseId: payment.expenseId ?? undefined,
        investorTransactionId: payment.investorTransactionId ?? undefined,
        companyWithdrawalId: payment.companyWithdrawalId ?? undefined,
        reversalOfPaymentId: payment.id,
      },
      tx,
    )

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        reversedAt: reversal.postedAt,
        reversedByUserId: userId,
        reversalReason: normalizedReason,
      },
    })

    const voidReason = `Voided because payment ${payment.id} was reversed: ${normalizedReason}`
    await voidReceiptForPayment(payment.id, voidReason, tx)

    if (payment.customer) {
      await syncCustomerFlatStatus(payment, tx)
    }

    if (payment.investorTransaction) {
      await syncInvestorClosedState(payment.investorTransaction.investor.id, tx)
    }

    const refreshed = await getPaymentForCompany(payment.id, company.id, tx)
    if (!refreshed) throw new Error('PAYMENT_NOT_FOUND')

    return {
      payment: refreshed,
      reversal,
    }
  }, LEDGER_TX_OPTIONS).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'PAYMENT_NOT_FOUND') {
      return { error: 'Payment not found', status: 404 as const }
    }

    if (error instanceof Error && error.message === 'PAYMENT_ALREADY_REVERSED') {
      return { error: 'Payment is already reversed', status: 400 as const }
    }

    if (error instanceof Error && error.message === 'PAYMENT_REVERSAL_NOT_SUPPORTED') {
      return {
        error: 'This payment type cannot be reversed from /payments/:id/reverse yet.',
        status: 400 as const,
      }
    }

    throw error
  })

  if (isPaymentServiceError(result)) {
    return result
  }

  await invalidateReversalSideEffects(result.payment)

  return mapReversalResponse(result.payment, result.reversal)
}
