import { mapExpenseLedgerFields } from '../../services/expense-ledger.service.js'

export function mapSiteExpense(expense: {
  id: string
  type: string
  reason: string | null
  vendorId: string | null
  description: string | null
  amount: number
  createdAt: Date
  vendor?: { name: string; type: string } | null
  ledgerEntries: Array<{ amount: number | string | { toString(): string }; postedAt: Date }>
}) {
  const ledger = mapExpenseLedgerFields(expense.amount, expense.ledgerEntries)

  return {
    id: expense.id,
    type: expense.type,
    reason: expense.reason,
    vendorId: expense.vendorId,
    vendorName: expense.vendor?.name ?? null,
    vendorType: expense.vendor?.type ?? null,
    description: expense.description,
    amount: expense.amount,
    amountPaid: ledger.amountPaid,
    remaining: ledger.remaining,
    paymentDate: ledger.paymentDate,
    paymentStatus: ledger.paymentStatus,
    createdAt: expense.createdAt.toISOString(),
  }
}

export function mapExpensePayment(payment: {
  id: string
  amount: number | { toString(): string }
  note: string | null
  postedAt: Date
}) {
  return {
    id: payment.id,
    amount: Number(payment.amount),
    note: payment.note,
    createdAt: payment.postedAt,
  }
}
