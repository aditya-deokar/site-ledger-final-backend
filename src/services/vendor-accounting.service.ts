import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { mapExpenseLedgerFields } from './expense-ledger.service.js'
import { sumLedgerAmountsForDirection, type LedgerReadDb } from './ledger-read.service.js'

export type VendorExpenseRecord = Prisma.ExpenseGetPayload<{
  include: {
    site: {
      select: {
        id: true
        name: true
        address: true
      }
    }
    vendorDocuments: {
      select: {
        id: true
      }
    }
    ledgerEntries: {
      select: {
        id: true
        amount: true
        direction: true
        note: true
        postedAt: true
        paymentMode: true
        referenceNumber: true
        receipt: {
          select: {
            id: true
            receiptNumber: true
            status: true
            createdAt: true
          }
        }
      }
    }
  }
}>

type VendorStatementRow = {
  id: string
  entryType: 'OPENING_BALANCE' | 'BILL' | 'PAYMENT'
  referenceId: string
  expenseId: string | null
  date: string
  billAmount: number
  paymentAmount: number
  balance: number
  description: string | null
  reason: string | null
  note: string | null
  siteId: string | null
  siteName: string | null
  billNumber: string | null
  dueDate: string | null
  paymentMode: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI' | null
  referenceNumber: string | null
}

function toIsoOrNull(value?: Date | null) {
  return value ? value.toISOString() : null
}

function getEffectiveBillDate(expense: Pick<VendorExpenseRecord, 'billDate' | 'createdAt'>) {
  return expense.billDate ?? expense.createdAt
}

export async function getVendorExpenseRecords(
  vendorId: string,
  tx?: LedgerReadDb,
): Promise<VendorExpenseRecord[]> {
  const db = tx ?? prisma

  const expenses = await db.expense.findMany({
    where: {
      vendorId,
      isDeleted: false,
    },
    include: {
      site: {
        select: {
          id: true,
          name: true,
        },
      },
      vendorDocuments: {
        select: {
          id: true,
        },
      },
      ledgerEntries: {
        select: {
          id: true,
          amount: true,
          direction: true,
          note: true,
          postedAt: true,
          paymentMode: true,
          referenceNumber: true,
          receipt: {
            select: {
              id: true,
              receiptNumber: true,
              status: true,
              createdAt: true,
            },
          },
        },
        orderBy: {
          postedAt: 'desc',
        },
      },
    },
    orderBy: [
      { billDate: 'desc' },
      { createdAt: 'desc' },
    ],
  })

  return expenses as VendorExpenseRecord[]
}

export function summarizeVendorRecords(
  expenses: VendorExpenseRecord[],
  openingBalanceAmount = 0,
) {
  const totalBilled = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const totalPaid = expenses.reduce((sum, expense) => sum + sumLedgerAmountsForDirection(expense.ledgerEntries, 'OUT'), 0)
  const overdueBillCount = expenses.reduce((sum, expense) => {
    const dueDate = expense.dueDate ?? getEffectiveBillDate(expense)
    const ledger = mapExpenseLedgerFields(expense.amount, expense.ledgerEntries)
    const isOverdue = ledger.remaining > 0 && dueDate.getTime() < Date.now()
    return sum + (isOverdue ? 1 : 0)
  }, 0)
  const paymentCount = expenses.reduce((sum, expense) => sum + expense.ledgerEntries.length, 0)

  const lastBillAt = expenses.reduce<Date | null>((latest, expense) => {
    const current = getEffectiveBillDate(expense)
    if (!latest || current.getTime() > latest.getTime()) return current
    return latest
  }, null)

  const lastPaymentAt = expenses
    .flatMap((expense) => expense.ledgerEntries.map((entry) => entry.postedAt))
    .reduce<Date | null>((latest, current) => {
      if (!latest || current.getTime() > latest.getTime()) return current
      return latest
    }, null)

  return {
    totalBilled,
    totalPaid,
    totalOutstanding: openingBalanceAmount + totalBilled - totalPaid,
    billCount: expenses.length,
    overdueBillCount,
    paymentCount,
    lastBillDate: toIsoOrNull(lastBillAt),
    lastPaymentDate: toIsoOrNull(lastPaymentAt),
  }
}

function mapVendorBill(expense: VendorExpenseRecord) {
  const ledgerEntries = [...expense.ledgerEntries].sort(
    (left, right) => right.postedAt.getTime() - left.postedAt.getTime(),
  )
  const ledger = mapExpenseLedgerFields(expense.amount, ledgerEntries)
  const dueDate = expense.dueDate ?? getEffectiveBillDate(expense)

  return {
    id: expense.id,
    siteId: expense.siteId,
    amount: expense.amount,
    amountPaid: ledger.amountPaid,
    remaining: ledger.remaining,
    paymentDate: ledger.paymentDate,
    paymentStatus: ledger.paymentStatus,
    description: expense.description,
    reason: expense.reason,
    siteName: expense.site.name,
    billNumber: expense.billNumber,
    billDate: getEffectiveBillDate(expense).toISOString(),
    dueDate: dueDate.toISOString(),
    isOverdue: ledger.remaining > 0 && dueDate.getTime() < Date.now(),
    documentCount: expense.vendorDocuments.length,
    createdAt: expense.createdAt.toISOString(),
  }
}

export function mapVendorBills(expenses: VendorExpenseRecord[]) {
  return expenses.map(mapVendorBill)
}

export function mapVendorPayments(expenses: VendorExpenseRecord[]) {
  return expenses
    .flatMap((expense) =>
      expense.ledgerEntries.map((payment) => ({
        id: payment.id,
        expenseId: expense.id,
        expenseAmount: expense.amount,
        amount: Number(payment.amount),
        direction: payment.direction,
        note: payment.note,
        paymentMode: payment.paymentMode,
        referenceNumber: payment.referenceNumber,
        siteId: expense.siteId,
        siteName: expense.site.name,
        description: expense.description,
        reason: expense.reason,
        billNumber: expense.billNumber,
        createdAt: payment.postedAt.toISOString(),
        paymentDate: payment.postedAt.toISOString(),
        receipt: payment.receipt
          ? {
              id: payment.receipt.id,
              receiptNumber: payment.receipt.receiptNumber,
              status: payment.receipt.status,
              createdAt: payment.receipt.createdAt.toISOString(),
            }
          : null,
      })),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function mapVendorReceipts(
  vendor: {
    id: string
    name: string
    type: string
    contactPersonName: string | null
    phone: string | null
    email: string | null
    address: string | null
    gstin: string | null
    pan: string | null
  },
  expenses: VendorExpenseRecord[],
) {
  return expenses
    .flatMap((expense) =>
      expense.ledgerEntries
        .filter((payment) => payment.receipt && payment.direction === 'OUT')
        .map((payment) => ({
          id: payment.receipt!.id,
          paymentId: payment.id,
          expenseId: expense.id,
          siteId: expense.siteId,
          siteName: expense.site.name,
          siteAddress: expense.site.address,
          vendorId: vendor.id,
          vendorName: vendor.name,
          vendorType: vendor.type,
          contactPersonName: vendor.contactPersonName,
          vendorPhone: vendor.phone,
          vendorEmail: vendor.email,
          vendorAddress: vendor.address,
          vendorGstin: vendor.gstin,
          vendorPan: vendor.pan,
          billNumber: expense.billNumber,
          billAmount: expense.amount,
          billDate: getEffectiveBillDate(expense).toISOString(),
          dueDate: expense.dueDate?.toISOString() ?? null,
          description: expense.description,
          reason: expense.reason,
          amount: Number(payment.amount),
          paymentMode: payment.paymentMode,
          referenceNumber: payment.referenceNumber,
          note: payment.note,
          date: payment.postedAt.toISOString(),
          receiptNumber: payment.receipt!.receiptNumber,
          status: payment.receipt!.status,
          createdAt: payment.receipt!.createdAt.toISOString(),
        })),
    )
    .sort((left, right) => right.date.localeCompare(left.date))
}

export function buildVendorStatement(
  vendor: {
    id: string
    createdAt: Date
    openingBalanceAmount: number
    openingBalanceDate: Date | null
  },
  expenses: VendorExpenseRecord[],
) {
  const entries: Array<VendorStatementRow & { sortDate: number; sortOrder: number }> = []

  if (vendor.openingBalanceAmount > 0) {
    const openingDate = vendor.openingBalanceDate ?? vendor.createdAt
    entries.push({
      id: `opening:${vendor.id}`,
      entryType: 'OPENING_BALANCE',
      referenceId: `opening-balance:${vendor.id}`,
      expenseId: null,
      date: openingDate.toISOString(),
      billAmount: vendor.openingBalanceAmount,
      paymentAmount: 0,
      balance: 0,
      description: 'Opening balance',
      reason: null,
      note: null,
      siteId: null,
      siteName: null,
      billNumber: null,
      dueDate: openingDate.toISOString(),
      paymentMode: null,
      referenceNumber: null,
      sortDate: openingDate.getTime(),
      sortOrder: 0,
    })
  }

  for (const expense of expenses) {
    const billDate = getEffectiveBillDate(expense)
    const dueDate = expense.dueDate ?? billDate

    entries.push({
      id: `bill:${expense.id}`,
      entryType: 'BILL',
      referenceId: expense.id,
      expenseId: expense.id,
      date: billDate.toISOString(),
      billAmount: expense.amount,
      paymentAmount: 0,
      balance: 0,
      description: expense.description,
      reason: expense.reason,
      note: null,
      siteId: expense.siteId,
      siteName: expense.site.name,
      billNumber: expense.billNumber,
      dueDate: dueDate.toISOString(),
      paymentMode: null,
      referenceNumber: null,
      sortDate: billDate.getTime(),
      sortOrder: 1,
    })

    const paymentsAscending = [...expense.ledgerEntries].sort(
      (left, right) => left.postedAt.getTime() - right.postedAt.getTime(),
    )

    for (const payment of paymentsAscending) {
      entries.push({
        id: `payment:${payment.id}`,
        entryType: 'PAYMENT',
        referenceId: payment.id,
        expenseId: expense.id,
        date: payment.postedAt.toISOString(),
        billAmount: 0,
        paymentAmount: payment.direction === 'OUT' ? Number(payment.amount) : -Number(payment.amount),
        note: payment.note,
        balance: 0,
        description: expense.description,
        reason: expense.reason,
        siteId: expense.siteId,
        siteName: expense.site.name,
        billNumber: expense.billNumber,
        dueDate: dueDate.toISOString(),
        paymentMode: payment.paymentMode,
        referenceNumber: payment.referenceNumber,
        sortDate: payment.postedAt.getTime(),
        sortOrder: 2,
      })
    }
  }

  entries.sort((left, right) => {
    if (left.sortDate !== right.sortDate) {
      return left.sortDate - right.sortDate
    }

    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder
    }

    return left.id.localeCompare(right.id)
  })

  let runningBalance = 0

  const statement = entries.map(({ sortDate: _sortDate, sortOrder: _sortOrder, ...entry }) => {
    if (entry.entryType === 'OPENING_BALANCE' || entry.entryType === 'BILL') {
      runningBalance += entry.billAmount
    } else {
      runningBalance -= entry.paymentAmount
    }

    return {
      ...entry,
      balance: runningBalance,
    }
  })

  const summary = summarizeVendorRecords(expenses, vendor.openingBalanceAmount)

  return {
    statement,
    totalBilled: summary.totalBilled + vendor.openingBalanceAmount,
    totalPaid: summary.totalPaid,
    closingBalance: summary.totalOutstanding,
  }
}
