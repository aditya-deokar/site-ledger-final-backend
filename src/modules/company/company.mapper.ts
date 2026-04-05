import { Prisma } from '@prisma/client'
import { mapCompanyWithdrawalLedgerFields } from '../../services/company-withdrawal-ledger.service.js'
import { sumDirectionalLedgerAmounts } from '../../services/ledger-read.service.js'

export function mapCompanyResponse(company: {
  id: string
  name: string
  address: string | null
  createdAt: Date
}) {
  return {
    id: company.id,
    name: company.name,
    address: company.address,
    createdAt: company.createdAt.toISOString(),
  }
}

export function mapPartnerResponse(
  partner: {
    id: string
    name: string
    email: string | null
    phone: string | null
    stakePercentage: number
    ledgerEntries: Array<{ amount: Prisma.Decimal | number | string; direction: 'IN' | 'OUT' }>
  },
) {
  return {
    id: partner.id,
    name: partner.name,
    email: partner.email,
    phone: partner.phone,
    investmentAmount: sumDirectionalLedgerAmounts(partner.ledgerEntries),
    stakePercentage: partner.stakePercentage,
  }
}

export function mapCompanyWithdrawalResponse(
  withdrawal: {
    id: string
    amount: number
    note: string | null
    createdAt: Date
    ledgerEntries: Array<{ amount: number | string | { toString(): string }; postedAt: Date }>
  },
) {
  const derived = mapCompanyWithdrawalLedgerFields(withdrawal.amount, withdrawal.ledgerEntries)

  return {
    id: withdrawal.id,
    amount: withdrawal.amount,
    note: withdrawal.note,
    amountPaid: derived.amountPaid,
    remaining: derived.remaining,
    paymentDate: derived.paymentDate,
    paymentStatus: derived.paymentStatus,
    createdAt: withdrawal.createdAt.toISOString(),
  }
}

export function mapCompanyActivity(payment: {
  id: string
  amount: Prisma.Decimal | number | string
  note: string | null
  postedAt: Date
  companyWithdrawalId: string | null
  walletType: string
  movementType: string
  site: { name: string } | null
  companyWithdrawal: { note: string | null } | null
  partnerId: string | null
  partner: { name: string } | null
  investorTransactionId: string | null
  investorTransaction:
    | {
        note: string | null
        kind: string
        investor: { name: string } | null
      }
    | null
  expense:
    | {
        description: string | null
        site: { name: string } | null
      }
    | null
}) {
  if (payment.companyWithdrawalId) {
    return {
      id: payment.id,
      type: 'withdrawal' as const,
      amount: -Number(payment.amount),
      description: payment.note || payment.companyWithdrawal?.note || 'Company withdrawal',
      date: payment.postedAt.toISOString(),
    }
  }

  if (payment.walletType === 'COMPANY' && payment.movementType === 'COMPANY_TO_SITE_TRANSFER') {
    return {
      id: payment.id,
      type: 'site_fund' as const,
      amount: Number(payment.amount),
      description: `Fund allocated to ${payment.site?.name ?? 'site'}`,
      date: payment.postedAt.toISOString(),
    }
  }

  if (payment.walletType === 'COMPANY' && payment.movementType === 'SITE_TO_COMPANY_TRANSFER') {
    return {
      id: payment.id,
      type: 'site_fund' as const,
      amount: -Number(payment.amount),
      description: `Fund pulled from ${payment.site?.name ?? 'site'}`,
      date: payment.postedAt.toISOString(),
    }
  }

  if (payment.investorTransactionId) {
    const investorName = payment.investorTransaction?.investor?.name ?? 'Investor'

    return {
      id: payment.id,
      type: 'investor_tx' as const,
      amount: payment.movementType === 'INVESTOR_PRINCIPAL_IN' ? Number(payment.amount) : -Number(payment.amount),
      description:
        payment.movementType === 'INVESTOR_PRINCIPAL_IN'
          ? `${investorName} invested`
          : payment.movementType === 'INVESTOR_INTEREST'
            ? `Interest paid to ${investorName}`
            : `Returned to ${investorName}`,
      date: payment.postedAt.toISOString(),
    }
  }

  if (payment.partnerId) {
    return {
      id: payment.id,
      type: 'investor_tx' as const,
      amount: Number(payment.amount),
      description: `Capital from ${payment.partner?.name ?? 'Partner'}`,
      date: payment.postedAt.toISOString(),
    }
  }

  return {
    id: payment.id,
    type: 'expense' as const,
    amount: -Number(payment.amount),
    description: `${payment.expense?.description ?? 'Expense'} - ${payment.expense?.site?.name ?? 'site'}`,
    date: payment.postedAt.toISOString(),
  }
}

export function mapCompanyExpenseResponse(expense: {
  id: string
  type: string
  reason: string | null
  description: string | null
  amount: number
  createdAt: Date
  site: { name: string }
  vendor: { name: string } | null
}) {
  return {
    id: expense.id,
    type: expense.type,
    reason: expense.reason,
    description: expense.description,
    amount: expense.amount,
    siteName: expense.site.name,
    vendorName: expense.vendor?.name ?? null,
    createdAt: expense.createdAt.toISOString(),
  }
}
