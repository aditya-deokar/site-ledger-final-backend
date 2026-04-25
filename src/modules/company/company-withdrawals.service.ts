import { Prisma } from '@prisma/client'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { createLedgerEntry } from '../../services/ledger.service.js'
import {
  deriveCompanyWithdrawalPaymentStatus,
  getCompanyWithdrawalPaidTotal,
  getCompanyWithdrawalRemaining,
} from '../../services/company-withdrawal-ledger.service.js'
import { invalidateWithdrawalCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { getCompanyAvailableFund } from '../../utils/ledger-fund.js'
import { LEDGER_TX_OPTIONS } from '../../shared/constants/ledger.js'
import { mapCompanyWithdrawalResponse } from './company.mapper.js'
import { isCompanyServiceError, type CompanyServiceError } from './company.service.js'

type CompanyRecord = NonNullable<Awaited<ReturnType<typeof getCompanyForUser>>>

type CompanyWithdrawalWithLedger = {
  id: string
  amount: number
  note: string | null
  createdAt: Date
  companyId: string
  ledgerEntries: Array<{ amount: number | string | { toString(): string }; direction: 'IN' | 'OUT'; postedAt: Date }>
}

async function requireCompanyForUser(userId: string, message: string): Promise<CompanyRecord | CompanyServiceError> {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: message, status: 404 }

  return company
}

async function getCompanyWithdrawalForUser(withdrawalId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, withdrawal: null }

  const withdrawal = await prisma.companyWithdrawal.findFirst({
    where: { id: withdrawalId, companyId: company.id, isDeleted: false },
    include: {
      ledgerEntries: {
        select: { amount: true, direction: true, postedAt: true },
        orderBy: { postedAt: 'desc' },
      },
    },
  })

  return {
    company,
    withdrawal: withdrawal as CompanyWithdrawalWithLedger | null,
  }
}

export async function createCompanyWithdrawalForUser(
  userId: string,
  data: { amount: number; note?: string; amountPaid?: number; paymentDate?: string; idempotencyKey?: string },
) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  const availableFund = await getCompanyAvailableFund(company.id)
  const { amount, note, amountPaid = 0, paymentDate, idempotencyKey } = data

  if (amountPaid > amount) return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }
  if (amountPaid > availableFund) return { error: 'INSUFFICIENT_FUNDS', status: 400 }

  const result = await prisma.$transaction(
    async (tx: any) => {
      const withdrawal = await tx.companyWithdrawal.create({
        data: {
          companyId: company.id,
          amount,
          note,
        },
      })

      let initialPaymentDate: string | null = null
      if (amountPaid > 0) {
        const payment = await createLedgerEntry(
          {
            companyId: company.id,
            walletType: 'COMPANY',
            direction: 'OUT',
            movementType: 'COMPANY_WITHDRAWAL',
            amount: new Prisma.Decimal(amountPaid),
            idempotencyKey: idempotencyKey ?? `company-withdrawal:${withdrawal.id}:${Date.now()}`,
            postedAt: paymentDate ? new Date(paymentDate) : undefined,
            note: note || 'Initial withdrawal payment',
            companyWithdrawalId: withdrawal.id,
          },
          tx,
        )
        initialPaymentDate = payment.postedAt.toISOString()
      }

      const paidTotal = await getCompanyWithdrawalPaidTotal(withdrawal.id, tx)
      const remaining = await getCompanyWithdrawalRemaining(withdrawal.id, tx)

      return { withdrawal, paidTotal, remaining, initialPaymentDate }
    },
    LEDGER_TX_OPTIONS,
  )

  await invalidateWithdrawalCaches(company.id)

  const newAvailableFund = await getCompanyAvailableFund(company.id)
  const paymentStatus = deriveCompanyWithdrawalPaymentStatus(result.withdrawal.amount, result.paidTotal)

  return {
    withdrawal: {
      id: result.withdrawal.id,
      amount: result.withdrawal.amount,
      note: result.withdrawal.note,
      amountPaid: result.paidTotal,
      remaining: result.remaining,
      paymentDate: result.initialPaymentDate,
      paymentStatus,
      createdAt: result.withdrawal.createdAt.toISOString(),
    },
    availableFund: newAvailableFund,
  }
}

export async function getCompanyWithdrawalsForUser(userId: string) {
  const company = await requireCompanyForUser(userId, 'No company found')
  if (isCompanyServiceError(company)) return company

  const cacheKey = CacheKeys.companyWithdrawalList(company.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const withdrawals = await prisma.companyWithdrawal.findMany({
    where: { companyId: company.id, isDeleted: false },
    include: {
      ledgerEntries: {
        select: { amount: true, direction: true, postedAt: true },
        orderBy: { postedAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    withdrawals: withdrawals.map((withdrawal) => mapCompanyWithdrawalResponse(withdrawal as CompanyWithdrawalWithLedger)),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function getCompanyWithdrawalDetailForUser(withdrawalId: string, userId: string) {
  const { withdrawal } = await getCompanyWithdrawalForUser(withdrawalId, userId)
  if (!withdrawal) return { error: 'Withdrawal not found', status: 404 }

  return {
    withdrawal: mapCompanyWithdrawalResponse(withdrawal),
  }
}

export async function addCompanyWithdrawalPaymentForUser(
  withdrawalId: string,
  userId: string,
  data: { amount: number; note?: string; idempotencyKey?: string },
) {
  const { company, withdrawal } = await getCompanyWithdrawalForUser(withdrawalId, userId)
  if (!company || !withdrawal) return { error: 'Withdrawal not found', status: 404 }

  const availableFund = await getCompanyAvailableFund(company.id)
  if (data.amount > availableFund) return { error: 'INSUFFICIENT_FUNDS', status: 400 }

  const currentPaid = await getCompanyWithdrawalPaidTotal(withdrawal.id)
  const newTotal = currentPaid + data.amount
  if (newTotal > withdrawal.amount) return { error: 'AMOUNT_EXCEEDS_LIMIT', status: 400 }

  const result = await prisma.$transaction(
    async (tx) => {
      const payment = await createLedgerEntry(
        {
          companyId: company.id,
          walletType: 'COMPANY',
          direction: 'OUT',
          movementType: 'COMPANY_WITHDRAWAL',
          amount: new Prisma.Decimal(data.amount),
          idempotencyKey: data.idempotencyKey ?? `company-withdrawal-payment:${withdrawal.id}:${Date.now()}`,
          note: data.note || 'Withdrawal payment',
          companyWithdrawalId: withdrawal.id,
        },
        tx,
      )

      const amountPaid = await getCompanyWithdrawalPaidTotal(withdrawal.id, tx)
      const remaining = await getCompanyWithdrawalRemaining(withdrawal.id, tx)
      const paymentStatus = deriveCompanyWithdrawalPaymentStatus(withdrawal.amount, amountPaid)

      return { payment, amountPaid, remaining, paymentStatus }
    },
    LEDGER_TX_OPTIONS,
  )

  await invalidateWithdrawalCaches(company.id)

  return {
    withdrawal: {
      id: withdrawal.id,
      amountPaid: result.amountPaid,
      remaining: result.remaining,
      paymentStatus: result.paymentStatus,
    },
    payment: {
      id: result.payment.id,
      amount: Number(result.payment.amount),
      createdAt: result.payment.postedAt.toISOString(),
    },
    availableFund: await getCompanyAvailableFund(company.id),
  }
}

export async function getCompanyWithdrawalPaymentsForUser(withdrawalId: string, userId: string) {
  const { company, withdrawal } = await getCompanyWithdrawalForUser(withdrawalId, userId)
  if (!company || !withdrawal) return { error: 'Withdrawal not found', status: 404 }

  const payments = await prisma.payment.findMany({
    where: {
      companyId: company.id,
      companyWithdrawalId: withdrawal.id,
    },
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

  return {
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      direction: payment.direction,
      movementType: payment.movementType,
      reversalOfPaymentId: payment.reversalOfPaymentId,
      note: payment.note,
      createdAt: payment.postedAt.toISOString(),
    })),
  }
}
