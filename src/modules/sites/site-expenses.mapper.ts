import { mapExpenseLedgerFields } from '../../services/expense-ledger.service.js'

export function mapSiteExpense(expense: {
  id: string
  type: string
  reason: string | null
  vendorId: string | null
  description: string | null
  billNumber?: string | null
  billDate?: Date | null
  dueDate?: Date | null
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
    billNumber: expense.billNumber ?? null,
    billDate: (expense.billDate ?? expense.createdAt).toISOString(),
    dueDate: (expense.dueDate ?? expense.billDate ?? expense.createdAt).toISOString(),
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
  paymentMode?: string | null
  referenceNumber?: string | null
  receipt?: {
    id: string
    receiptNumber: string
    status: 'ACTIVE' | 'VOIDED'
    createdAt: Date
  } | null
  reversalOfPaymentId?: string | null
}) {
  return {
    id: payment.id,
    amount: Number(payment.amount),
    direction: payment.direction,
    movementType: payment.movementType,
    reversalOfPaymentId: payment.reversalOfPaymentId ?? null,
    note: payment.note,
    paymentMode: payment.paymentMode ?? null,
    referenceNumber: payment.referenceNumber ?? null,
    receipt: payment.receipt
      ? {
          id: payment.receipt.id,
          receiptNumber: payment.receipt.receiptNumber,
          status: payment.receipt.status,
          createdAt: payment.receipt.createdAt.toISOString(),
        }
      : null,
    createdAt: payment.postedAt.toISOString(),
  }
}
