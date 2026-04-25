import { Prisma, type ReceiptStatus } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import {
  calculateAgreementTotals,
  mapAgreementLine,
  type CustomerAgreementLineView,
  type CustomerAgreementTotals,
} from '../modules/customers/customer-agreement.service.js'

type ReceiptDb = Prisma.TransactionClient | typeof prisma

type CustomerReceiptSnapshot = {
  version: 1
  company: {
    id: string
    name: string
    address: string | null
  }
  site: {
    id: string | null
    name: string | null
    address: string | null
  }
  customer: {
    id: string
    name: string
    phone: string | null
    email: string | null
    customerType: string | null
  }
  flat: {
    id: string | null
    displayName: string | null
    floorName: string | null
    floorNumber: number | null
    status: string | null
  }
  agreement: {
    totals: CustomerAgreementTotals
    lines: CustomerAgreementLineView[]
  }
  payment: {
    id: string
    amount: number
    direction: 'IN' | 'OUT'
    movementType: string
    paymentMode: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI' | null
    referenceNumber: string | null
    note: string | null
    date: string
  }
}

function getFlatDisplayName(customFlatId: string | null, flatNumber: number | null) {
  return customFlatId || (flatNumber === null ? null : `Flat ${flatNumber}`)
}

function getFloorDisplayName(floorName: string | null, floorNumber: number | null) {
  if (floorName) return floorName
  return floorNumber === null ? null : `Floor ${floorNumber}`
}

function buildReceiptNumber(sequenceValue: number) {
  return `RCP-${String(sequenceValue).padStart(6, '0')}`
}

async function getNextReceiptNumber(tx: Prisma.TransactionClient) {
  const sequence = await tx.receiptSequence.update({
    where: { key: 'receipt' },
    data: { lastValue: { increment: 1 } },
    select: { lastValue: true },
  })

  return buildReceiptNumber(sequence.lastValue)
}

async function getCustomerPaymentForSnapshot(paymentId: string, db: ReceiptDb) {
  return db.payment.findUnique({
    where: { id: paymentId },
    include: {
      receipt: true,
      company: {
        select: {
          id: true,
          name: true,
          address: true,
        },
      },
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          customerType: true,
          sellingPrice: true,
          site: {
            select: {
              id: true,
              name: true,
              address: true,
            },
          },
          flat: {
            select: {
              id: true,
              flatNumber: true,
              customFlatId: true,
              status: true,
              floor: {
                select: {
                  floorNumber: true,
                  floorName: true,
                },
              },
            },
          },
          agreementLines: {
            where: { isDeleted: false },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              type: true,
              label: true,
              amount: true,
              ratePercent: true,
              calculationBase: true,
              affectsProfit: true,
              note: true,
              createdAt: true,
            },
          },
        },
      },
    },
  })
}

function buildCustomerReceiptSnapshot(payment: NonNullable<Awaited<ReturnType<typeof getCustomerPaymentForSnapshot>>>): CustomerReceiptSnapshot {
  if (!payment.customer) {
    throw new Error('RECEIPT_CUSTOMER_REQUIRED')
  }

  const lines = payment.customer.agreementLines.map(mapAgreementLine)
  const totals = calculateAgreementTotals(payment.customer.agreementLines, payment.customer.sellingPrice)

  return {
    version: 1,
    company: {
      id: payment.company.id,
      name: payment.company.name,
      address: payment.company.address,
    },
    site: {
      id: payment.customer.site?.id ?? payment.siteId ?? null,
      name: payment.customer.site?.name ?? null,
      address: payment.customer.site?.address ?? null,
    },
    customer: {
      id: payment.customer.id,
      name: payment.customer.name,
      phone: payment.customer.phone,
      email: payment.customer.email,
      customerType: payment.customer.customerType,
    },
    flat: {
      id: payment.customer.flat?.id ?? null,
      displayName: getFlatDisplayName(payment.customer.flat?.customFlatId ?? null, payment.customer.flat?.flatNumber ?? null),
      floorName: getFloorDisplayName(
        payment.customer.flat?.floor?.floorName ?? null,
        payment.customer.flat?.floor?.floorNumber ?? null,
      ),
      floorNumber: payment.customer.flat?.floor?.floorNumber ?? null,
      status: payment.customer.flat?.status ?? null,
    },
    agreement: {
      totals,
      lines,
    },
    payment: {
      id: payment.id,
      amount: Number(payment.amount),
      direction: payment.direction,
      movementType: payment.movementType,
      paymentMode: payment.paymentMode,
      referenceNumber: payment.referenceNumber,
      note: payment.note,
      date: payment.postedAt.toISOString(),
    },
  }
}

export async function createCustomerReceiptForPayment(
  paymentId: string,
  createdByUserId: string,
  tx: Prisma.TransactionClient,
) {
  const payment = await getCustomerPaymentForSnapshot(paymentId, tx)
  if (!payment) {
    throw new Error('PAYMENT_NOT_FOUND')
  }

  if (payment.receipt) {
    return payment.receipt
  }

  if (payment.movementType !== 'CUSTOMER_PAYMENT' || payment.direction !== 'IN') {
    throw new Error('RECEIPT_NOT_SUPPORTED')
  }

  const receiptNumber = await getNextReceiptNumber(tx)
  const snapshot = buildCustomerReceiptSnapshot(payment)

  return tx.receipt.create({
    data: {
      receiptNumber,
      paymentId: payment.id,
      snapshot: snapshot as Prisma.InputJsonValue,
      createdByUserId,
    },
  })
}

export async function getReceiptByPaymentId(
  paymentId: string,
  db: ReceiptDb = prisma,
): Promise<{
  id: string
  receiptNumber: string
  status: ReceiptStatus
  voidedAt: string | null
  voidReason: string | null
  createdByUserId: string
  createdAt: string
  snapshot: Prisma.JsonValue
} | null> {
  const receipt = await db.receipt.findUnique({
    where: { paymentId },
  })

  if (!receipt) return null

  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    status: receipt.status,
    voidedAt: receipt.voidedAt?.toISOString() ?? null,
    voidReason: receipt.voidReason,
    createdByUserId: receipt.createdByUserId,
    createdAt: receipt.createdAt.toISOString(),
    snapshot: receipt.snapshot,
  }
}

export async function voidReceiptForPayment(
  paymentId: string,
  voidReason: string,
  tx: Prisma.TransactionClient,
) {
  const receipt = await tx.receipt.findUnique({
    where: { paymentId },
  })

  if (!receipt || receipt.status === 'VOIDED') {
    return receipt
  }

  return tx.receipt.update({
    where: { paymentId },
    data: {
      status: 'VOIDED',
      voidedAt: new Date(),
      voidReason,
    },
  })
}
