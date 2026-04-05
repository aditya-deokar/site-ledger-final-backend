import { prisma } from '../db/prisma.js'
import { mapExpenseLedgerFields } from './expense-ledger.service.js'
import { sumLedgerAmounts, type LedgerReadDb } from './ledger-read.service.js'

type VendorPaymentEntry = {
  id: string
  amount: number | string | { toString(): string }
  note: string | null
  postedAt: Date
}

type VendorExpenseRecord = {
  id: string
  siteId: string
  amount: number
  description: string | null
  reason: string | null
  createdAt: Date
  site: {
    id: string
    name: string
  }
  ledgerEntries: VendorPaymentEntry[]
}

type VendorStatementRow = {
  id: string
  entryType: 'BILL' | 'PAYMENT'
  referenceId: string
  expenseId: string
  date: string
  billAmount: number
  paymentAmount: number
  balance: number
  description: string | null
  reason: string | null
  note: string | null
  siteId: string
  siteName: string
}

export async function getVendorExpenseRecords(
  vendorId: string,
  tx?: LedgerReadDb,
): Promise<VendorExpenseRecord[]> {
  const db = tx ?? prisma

  return db.expense.findMany({
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
      ledgerEntries: {
        select: {
          id: true,
          amount: true,
          note: true,
          postedAt: true,
        },
        orderBy: {
          postedAt: 'desc',
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })
}

export function summarizeVendorRecords(expenses: VendorExpenseRecord[]) {
  const totalBilled = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const totalPaid = expenses.reduce((sum, expense) => sum + sumLedgerAmounts(expense.ledgerEntries), 0)

  return {
    totalBilled,
    totalPaid,
    totalOutstanding: totalBilled - totalPaid,
    billCount: expenses.length,
  }
}

function mapVendorBill(expense: VendorExpenseRecord) {
  const ledgerEntries = [...expense.ledgerEntries].sort(
    (left, right) => right.postedAt.getTime() - left.postedAt.getTime(),
  )
  const ledger = mapExpenseLedgerFields(expense.amount, ledgerEntries)

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
    createdAt: expense.createdAt.toISOString(),
    billDate: expense.createdAt.toISOString(),
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
        note: payment.note,
        siteId: expense.siteId,
        siteName: expense.site.name,
        description: expense.description,
        reason: expense.reason,
        createdAt: payment.postedAt.toISOString(),
        paymentDate: payment.postedAt.toISOString(),
      })),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function buildVendorStatement(expenses: VendorExpenseRecord[]) {
  const entries: Array<VendorStatementRow & { sortDate: number; sortOrder: number }> = []

  for (const expense of expenses) {
    entries.push({
      id: `bill:${expense.id}`,
      entryType: 'BILL',
      referenceId: expense.id,
      expenseId: expense.id,
      date: expense.createdAt.toISOString(),
      billAmount: expense.amount,
      paymentAmount: 0,
      balance: 0,
      description: expense.description,
      reason: expense.reason,
      note: null,
      siteId: expense.siteId,
      siteName: expense.site.name,
      sortDate: expense.createdAt.getTime(),
      sortOrder: 0,
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
        paymentAmount: Number(payment.amount),
        balance: 0,
        description: expense.description,
        reason: expense.reason,
        note: payment.note,
        siteId: expense.siteId,
        siteName: expense.site.name,
        sortDate: payment.postedAt.getTime(),
        sortOrder: 1,
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
    if (entry.entryType === 'BILL') {
      runningBalance += entry.billAmount
    } else {
      runningBalance -= entry.paymentAmount
    }

    return {
      ...entry,
      balance: runningBalance,
    }
  })

  const summary = summarizeVendorRecords(expenses)

  return {
    statement,
    totalBilled: summary.totalBilled,
    totalPaid: summary.totalPaid,
    closingBalance: summary.totalOutstanding,
  }
}
