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
  ledgerEntries: Array<{ amount: number | string | { toString(): string }; postedAt: Date; direction: 'IN' | 'OUT' }>
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
  direction: 'IN' | 'OUT'
  movementType: string
  note: string | null
  postedAt: Date
  reversalOfPaymentId?: string | null
}) {
  return {
    id: payment.id,
    amount: Number(payment.amount),
    direction: payment.direction,
    movementType: payment.movementType,
    reversalOfPaymentId: payment.reversalOfPaymentId ?? null,
    note: payment.note,
    createdAt: payment.postedAt,
  }
}
