import { Prisma } from '@prisma/client'
import {
  calculateInvestorLedgerTotals,
  mapInvestorTransactionResponse,
} from '../../services/investor-ledger.service.js'

export const investorTransactionInclude = Prisma.validator<Prisma.InvestorTransactionInclude>()({
  ledgerEntries: {
    select: { amount: true, direction: true, postedAt: true },
    orderBy: { postedAt: 'desc' },
  },
})

export const investorWithLedgerInclude = Prisma.validator<Prisma.InvestorInclude>()({
  site: { select: { id: true, name: true } },
  transactions: {
    where: { isDeleted: false },
    include: investorTransactionInclude,
    orderBy: { createdAt: 'desc' },
  },
})

export type InvestorTransactionWithLedger = Prisma.InvestorTransactionGetPayload<{
  include: typeof investorTransactionInclude
}>

export type InvestorWithLedger = Prisma.InvestorGetPayload<{
  include: typeof investorWithLedgerInclude
}>

export function mapInvestorResponse(investor: InvestorWithLedger) {
  const totals = calculateInvestorLedgerTotals(investor.transactions)

  return {
    id: investor.id,
    name: investor.name,
    phone: investor.phone,
    type: investor.type,
    siteId: investor.siteId,
    siteName: investor.site?.name ?? null,
    equityPercentage: investor.equityPercentage,
    fixedRate: investor.fixedRate,
    totalInvested: totals.principalInTotal,
    totalReturned: totals.totalReturned,
    interestPaid: totals.interestTotal,
    outstandingPrincipal: totals.outstandingPrincipal,
    isClosed: investor.isClosed,
    createdAt: investor.createdAt.toISOString(),
  }
}

export function mapInvestorDetailResponse(investor: InvestorWithLedger) {
  return {
    investor: mapInvestorResponse(investor),
    transactions: investor.transactions.map((transaction: InvestorTransactionWithLedger) =>
      mapInvestorTransactionResponse(transaction),
    ),
  }
}
