import { randomUUID } from 'node:crypto'
import { Prisma, type Direction, type MovementType, type Payment, type PaymentMode, type WalletType } from '@prisma/client'

export type LedgerErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'AMOUNT_EXCEEDS_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_LEDGER_INPUT'

export class LedgerError extends Error {
  code: LedgerErrorCode

  constructor(code: LedgerErrorCode) {
    super(code)
    this.name = 'LedgerError'
    this.code = code
  }
}

type CreateLedgerEntryInput = {
  companyId: string
  siteId?: string | null
  walletType: WalletType
  direction: Direction
  movementType: MovementType
  amount: Prisma.Decimal
  idempotencyKey: string
  postedAt?: Date
  note?: string
  paymentMode?: PaymentMode
  referenceNumber?: string
  customerId?: string
  expenseId?: string
  investorTransactionId?: string
  companyWithdrawalId?: string
  partnerId?: string
  entryGroupId?: string
}

type CreateTransferEntriesInput = {
  companyId: string
  siteId: string
  amount: Prisma.Decimal
  direction: 'COMPANY_TO_SITE' | 'SITE_TO_COMPANY'
  idempotencyKey?: string
  entryGroupId?: string
  postedAt?: Date
  note?: string
}

function assertLedger(condition: unknown, code: LedgerErrorCode): asserts condition {
  if (!condition) {
    throw new LedgerError(code)
  }
}

function getEntityRefCount(input: CreateLedgerEntryInput) {
  return [
    input.customerId,
    input.expenseId,
    input.investorTransactionId,
    input.companyWithdrawalId,
    input.partnerId,
  ].filter(Boolean).length
}

function getNormalizedAmount(value: Prisma.Decimal | number | string | null | undefined) {
  return new Prisma.Decimal(value ?? 0)
}

function isMatchingIdempotentPayload(existing: Payment, input: CreateLedgerEntryInput) {
  const note = input.note ?? null
  const siteId = input.siteId ?? null

  if (existing.siteId !== siteId) return false
  if (existing.walletType !== input.walletType) return false
  if (existing.direction !== input.direction) return false
  if (existing.movementType !== input.movementType) return false
  if (!getNormalizedAmount(existing.amount).equals(input.amount)) return false
  if ((existing.paymentMode ?? null) !== (input.paymentMode ?? null)) return false
  if ((existing.referenceNumber ?? null) !== (input.referenceNumber ?? null)) return false
  if ((existing.note ?? null) !== note) return false
  if ((existing.customerId ?? null) !== (input.customerId ?? null)) return false
  if ((existing.expenseId ?? null) !== (input.expenseId ?? null)) return false
  if ((existing.investorTransactionId ?? null) !== (input.investorTransactionId ?? null)) return false
  if ((existing.companyWithdrawalId ?? null) !== (input.companyWithdrawalId ?? null)) return false
  if ((existing.partnerId ?? null) !== (input.partnerId ?? null)) return false

  if (input.entryGroupId !== undefined && (existing.entryGroupId ?? null) !== input.entryGroupId) return false
  if (input.postedAt && existing.postedAt.getTime() !== input.postedAt.getTime()) return false

  return true
}

async function findExistingIdempotentEntry(
  input: CreateLedgerEntryInput,
  tx: Prisma.TransactionClient,
) {
  const existing = await tx.payment.findUnique({
    where: {
      companyId_idempotencyKey: {
        companyId: input.companyId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  })

  if (!existing) return null
  if (!isMatchingIdempotentPayload(existing, input)) {
    throw new LedgerError('IDEMPOTENCY_CONFLICT')
  }

  return existing
}

async function lockWallet(
  input: CreateLedgerEntryInput,
  tx: Prisma.TransactionClient,
) {
  if (input.walletType === 'COMPANY') {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Company"
      WHERE id = ${input.companyId}
      FOR UPDATE
    `

    assertLedger(rows.length > 0, 'INVALID_LEDGER_INPUT')
    return
  }

  assertLedger(Boolean(input.siteId), 'INVALID_LEDGER_INPUT')

  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Site"
    WHERE id = ${input.siteId!}
      AND "companyId" = ${input.companyId}
    FOR UPDATE
  `

  assertLedger(rows.length > 0, 'INVALID_LEDGER_INPUT')
}

async function getWalletBalance(
  input: CreateLedgerEntryInput,
  tx: Prisma.TransactionClient,
) {
  const where: Prisma.PaymentWhereInput = input.walletType === 'COMPANY'
    ? {
        companyId: input.companyId,
        walletType: 'COMPANY',
      }
    : {
        companyId: input.companyId,
        siteId: input.siteId ?? undefined,
        walletType: 'SITE',
      }

  // Interactive Prisma transactions are sensitive to parallel queries on the same tx client.
  const incoming = await tx.payment.aggregate({
    where: { ...where, direction: 'IN' },
    _sum: { amount: true },
  })
  const outgoing = await tx.payment.aggregate({
    where: { ...where, direction: 'OUT' },
    _sum: { amount: true },
  })

  return getNormalizedAmount(incoming._sum.amount).minus(getNormalizedAmount(outgoing._sum.amount))
}

async function getDocumentPaidTotal(
  field: 'customerId' | 'expenseId' | 'investorTransactionId' | 'companyWithdrawalId',
  id: string,
  tx: Prisma.TransactionClient,
) {
  const result = await tx.payment.aggregate({
    where: { [field]: id },
    _sum: { amount: true },
  })

  return getNormalizedAmount(result._sum.amount)
}

function validateMovementCombination(input: CreateLedgerEntryInput) {
  const entityRefCount = getEntityRefCount(input)
  assertLedger(input.amount.greaterThan(0), 'INVALID_LEDGER_INPUT')
  assertLedger(entityRefCount <= 1, 'INVALID_LEDGER_INPUT')

  if (input.walletType === 'SITE') {
    assertLedger(Boolean(input.siteId), 'INVALID_LEDGER_INPUT')
  }

  switch (input.movementType) {
    case 'CUSTOMER_PAYMENT':
      assertLedger(Boolean(input.customerId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.walletType === 'SITE' && input.direction === 'IN', 'INVALID_LEDGER_INPUT')
      return
    case 'CUSTOMER_REFUND':
      assertLedger(Boolean(input.customerId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.walletType === 'SITE' && input.direction === 'OUT', 'INVALID_LEDGER_INPUT')
      return
    case 'EXPENSE_PAYMENT':
      assertLedger(Boolean(input.expenseId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.walletType === 'SITE' && input.direction === 'OUT', 'INVALID_LEDGER_INPUT')
      return
    case 'INVESTOR_PRINCIPAL_IN':
      assertLedger(Boolean(input.investorTransactionId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.direction === 'IN', 'INVALID_LEDGER_INPUT')
      return
    case 'INVESTOR_PRINCIPAL_OUT':
      assertLedger(Boolean(input.investorTransactionId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.direction === 'OUT', 'INVALID_LEDGER_INPUT')
      return
    case 'INVESTOR_INTEREST':
      assertLedger(Boolean(input.investorTransactionId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.direction === 'OUT', 'INVALID_LEDGER_INPUT')
      return
    case 'COMPANY_WITHDRAWAL':
      assertLedger(Boolean(input.companyWithdrawalId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.walletType === 'COMPANY' && input.direction === 'OUT', 'INVALID_LEDGER_INPUT')
      return
    case 'PARTNER_CAPITAL_IN':
      assertLedger(Boolean(input.partnerId), 'INVALID_LEDGER_INPUT')
      assertLedger(input.walletType === 'COMPANY' && input.direction === 'IN', 'INVALID_LEDGER_INPUT')
      return
    case 'COMPANY_TO_SITE_TRANSFER':
      assertLedger(entityRefCount === 0, 'INVALID_LEDGER_INPUT')
      assertLedger(Boolean(input.siteId), 'INVALID_LEDGER_INPUT')
      assertLedger(
        (input.walletType === 'COMPANY' && input.direction === 'OUT')
          || (input.walletType === 'SITE' && input.direction === 'IN'),
        'INVALID_LEDGER_INPUT',
      )
      return
    case 'SITE_TO_COMPANY_TRANSFER':
      assertLedger(entityRefCount === 0, 'INVALID_LEDGER_INPUT')
      assertLedger(Boolean(input.siteId), 'INVALID_LEDGER_INPUT')
      assertLedger(
        (input.walletType === 'SITE' && input.direction === 'OUT')
          || (input.walletType === 'COMPANY' && input.direction === 'IN'),
        'INVALID_LEDGER_INPUT',
      )
      return
    case 'REVERSAL':
    case 'ADJUSTMENT':
      return
    default:
      assertLedger(false, 'INVALID_LEDGER_INPUT')
  }
}

async function validateDocumentLimit(
  input: CreateLedgerEntryInput,
  tx: Prisma.TransactionClient,
) {
  if (input.customerId) {
    const customer = await tx.customer.findFirst({
      where: {
        id: input.customerId,
        companyId: input.companyId,
        isDeleted: false,
        dealStatus: 'ACTIVE',
      },
      select: {
        sellingPrice: true,
        siteId: true,
      },
    })

    assertLedger(Boolean(customer), 'INVALID_LEDGER_INPUT')
    assertLedger(customer!.siteId === input.siteId, 'INVALID_LEDGER_INPUT')

    const incomingResult = await tx.payment.aggregate({
      where: {
        customerId: input.customerId,
        direction: 'IN',
      },
      _sum: { amount: true },
    })
    const outgoingResult = await tx.payment.aggregate({
      where: {
        customerId: input.customerId,
        direction: 'OUT',
      },
      _sum: { amount: true },
    })

    const netPaid = getNormalizedAmount(incomingResult._sum.amount).minus(getNormalizedAmount(outgoingResult._sum.amount))

    if (input.movementType === 'CUSTOMER_REFUND') {
      assertLedger(netPaid.minus(input.amount).greaterThanOrEqualTo(0), 'AMOUNT_EXCEEDS_LIMIT')
      return
    }

    assertLedger(netPaid.plus(input.amount).lessThanOrEqualTo(customer!.sellingPrice), 'AMOUNT_EXCEEDS_LIMIT')
    return
  }

  if (input.expenseId) {
    const expense = await tx.expense.findFirst({
      where: {
        id: input.expenseId,
        site: { companyId: input.companyId },
        isDeleted: false,
      },
      select: {
        amount: true,
        siteId: true,
      },
    })

    assertLedger(Boolean(expense), 'INVALID_LEDGER_INPUT')
    assertLedger(expense!.siteId === input.siteId, 'INVALID_LEDGER_INPUT')

    const paidTotal = await getDocumentPaidTotal('expenseId', input.expenseId, tx)
    assertLedger(paidTotal.plus(input.amount).lessThanOrEqualTo(expense!.amount), 'AMOUNT_EXCEEDS_LIMIT')
    return
  }

  if (input.investorTransactionId) {
    const transaction = await tx.investorTransaction.findFirst({
      where: {
        id: input.investorTransactionId,
        isDeleted: false,
        investor: {
          companyId: input.companyId,
          isDeleted: false,
        },
      },
      select: {
        amount: true,
        kind: true,
        investor: {
          select: {
            siteId: true,
          },
        },
      },
    })

    assertLedger(Boolean(transaction), 'INVALID_LEDGER_INPUT')

    const expectedWalletType: WalletType = transaction!.investor.siteId ? 'SITE' : 'COMPANY'
    assertLedger(expectedWalletType === input.walletType, 'INVALID_LEDGER_INPUT')
    assertLedger((transaction!.investor.siteId ?? null) === (input.siteId ?? null), 'INVALID_LEDGER_INPUT')

    const expectedMovementType: MovementType = transaction!.kind === 'PRINCIPAL_IN'
      ? 'INVESTOR_PRINCIPAL_IN'
      : transaction!.kind === 'PRINCIPAL_OUT'
        ? 'INVESTOR_PRINCIPAL_OUT'
        : 'INVESTOR_INTEREST'
    assertLedger(expectedMovementType === input.movementType, 'INVALID_LEDGER_INPUT')

    const paidTotal = await getDocumentPaidTotal('investorTransactionId', input.investorTransactionId, tx)
    assertLedger(paidTotal.plus(input.amount).lessThanOrEqualTo(transaction!.amount), 'AMOUNT_EXCEEDS_LIMIT')
    return
  }

  if (input.companyWithdrawalId) {
    const withdrawal = await tx.companyWithdrawal.findFirst({
      where: {
        id: input.companyWithdrawalId,
        companyId: input.companyId,
        isDeleted: false,
      },
      select: {
        amount: true,
      },
    })

    assertLedger(Boolean(withdrawal), 'INVALID_LEDGER_INPUT')

    const paidTotal = await getDocumentPaidTotal('companyWithdrawalId', input.companyWithdrawalId, tx)
    assertLedger(paidTotal.plus(input.amount).lessThanOrEqualTo(withdrawal!.amount), 'AMOUNT_EXCEEDS_LIMIT')
    return
  }

  if (input.partnerId) {
    const partner = await tx.partner.findFirst({
      where: {
        id: input.partnerId,
        companyId: input.companyId,
      },
      select: { id: true },
    })

    assertLedger(Boolean(partner), 'INVALID_LEDGER_INPUT')
  }
}

export async function createLedgerEntry(
  input: CreateLedgerEntryInput,
  tx: Prisma.TransactionClient,
) {
  validateMovementCombination(input)

  const existingBeforeLock = await findExistingIdempotentEntry(input, tx)
  if (existingBeforeLock) return existingBeforeLock

  await lockWallet(input, tx)

  const existingAfterLock = await findExistingIdempotentEntry(input, tx)
  if (existingAfterLock) return existingAfterLock

  await validateDocumentLimit(input, tx)

  if (input.direction === 'OUT') {
    const balance = await getWalletBalance(input, tx)
    assertLedger(balance.minus(input.amount).greaterThanOrEqualTo(0), 'INSUFFICIENT_FUNDS')
  }

  return tx.payment.create({
    data: {
      companyId: input.companyId,
      siteId: input.siteId ?? null,
      walletType: input.walletType,
      direction: input.direction,
      movementType: input.movementType,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      postedAt: input.postedAt,
      paymentMode: input.paymentMode ?? null,
      referenceNumber: input.referenceNumber ?? null,
      note: input.note ?? null,
      customerId: input.customerId ?? null,
      expenseId: input.expenseId ?? null,
      investorTransactionId: input.investorTransactionId ?? null,
      companyWithdrawalId: input.companyWithdrawalId ?? null,
      partnerId: input.partnerId ?? null,
      entryGroupId: input.entryGroupId ?? null,
    },
  })
}

export async function createTransferEntries(
  input: CreateTransferEntriesInput,
  tx: Prisma.TransactionClient,
) {
  const entryGroupId = input.entryGroupId
    ?? (input.idempotencyKey ? `transfer:${input.idempotencyKey}` : `transfer:${randomUUID()}`)
  const baseKey = input.idempotencyKey ?? entryGroupId

  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Company"
    WHERE id = ${input.companyId}
    FOR UPDATE
  `

  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Site"
    WHERE id = ${input.siteId}
      AND "companyId" = ${input.companyId}
    FOR UPDATE
  `

  if (input.direction === 'COMPANY_TO_SITE') {
    const companyEntry = await createLedgerEntry({
      companyId: input.companyId,
      siteId: input.siteId,
      walletType: 'COMPANY',
      direction: 'OUT',
      movementType: 'COMPANY_TO_SITE_TRANSFER',
      amount: input.amount,
      idempotencyKey: `${baseKey}:company`,
      postedAt: input.postedAt,
      note: input.note ?? 'Transfer from company to site',
      entryGroupId,
    }, tx)

    const siteEntry = await createLedgerEntry({
      companyId: input.companyId,
      siteId: input.siteId,
      walletType: 'SITE',
      direction: 'IN',
      movementType: 'COMPANY_TO_SITE_TRANSFER',
      amount: input.amount,
      idempotencyKey: `${baseKey}:site`,
      postedAt: input.postedAt,
      note: input.note ?? 'Transfer from company to site',
      entryGroupId,
    }, tx)

    return { entryGroupId, companyEntry, siteEntry }
  }

  const siteEntry = await createLedgerEntry({
    companyId: input.companyId,
    siteId: input.siteId,
    walletType: 'SITE',
    direction: 'OUT',
    movementType: 'SITE_TO_COMPANY_TRANSFER',
    amount: input.amount,
    idempotencyKey: `${baseKey}:site`,
    postedAt: input.postedAt,
    note: input.note ?? 'Transfer from site to company',
    entryGroupId,
  }, tx)

  const companyEntry = await createLedgerEntry({
    companyId: input.companyId,
    siteId: input.siteId,
    walletType: 'COMPANY',
    direction: 'IN',
    movementType: 'SITE_TO_COMPANY_TRANSFER',
    amount: input.amount,
    idempotencyKey: `${baseKey}:company`,
    postedAt: input.postedAt,
    note: input.note ?? 'Transfer from site to company',
    entryGroupId,
  }, tx)

  return { entryGroupId, companyEntry, siteEntry }
}
