import { prisma } from '../../db/prisma.js'
import { sumDirectionalLedgerAmounts } from '../../services/customer-ledger.service.js'
import { calculateInvestorLedgerTotals } from '../../services/investor-ledger.service.js'
import { mapSiteExpense } from './site-expenses.mapper.js'
import { getSiteForUser } from './site-access.service.js'
import {
  getSiteAllocatedFund,
  getSiteCustomerPayments,
  getSiteEquityInvestorFund,
  getSitePartnerAllocatedFund,
  getSiteRemainingFund,
  getSiteTotalExpenses,
  getSiteTotalExpensesBilled,
  getSiteWithdrawnFund,
} from '../../utils/ledger-fund.js'

function getFloorDisplayName(floorName: string | null, floorNumber: number) {
  return floorName || `Floor ${floorNumber}`
}

function getFlatDisplayName(customFlatId: string | null, flatNumber: number | null) {
  return customFlatId || `Flat ${flatNumber ?? '-'}`
}

function mapRecentActivityLabel(movementType: string) {
  switch (movementType) {
    case 'COMPANY_TO_SITE_TRANSFER':
      return { kind: 'fund', title: 'Fund added to site' }
    case 'SITE_TO_COMPANY_TRANSFER':
      return { kind: 'fund', title: 'Fund pulled from site' }
    case 'CUSTOMER_PAYMENT':
      return { kind: 'customer', title: 'Customer payment received' }
    case 'CUSTOMER_REFUND':
      return { kind: 'customer', title: 'Customer refund recorded' }
    case 'EXPENSE_PAYMENT':
      return { kind: 'expense', title: 'Expense payment recorded' }
    case 'INVESTOR_PRINCIPAL_IN':
      return { kind: 'investor', title: 'Investor principal received' }
    case 'INVESTOR_PRINCIPAL_OUT':
      return { kind: 'investor', title: 'Investor principal returned' }
    case 'INVESTOR_INTEREST':
      return { kind: 'investor', title: 'Investor interest paid' }
    default:
      return { kind: 'ledger', title: 'Ledger movement' }
  }
}

export async function getSiteReportForUser(siteId: string, userId: string) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const [
    partnerAllocatedFund,
    investorAllocatedFund,
    totalAllocatedFund,
    totalWithdrawnFund,
    totalExpensesPaid,
    totalExpensesRecorded,
    customerCollections,
    remainingFund,
    floorsRaw,
    customersRaw,
    expensesRaw,
    investorsRaw,
    fundHistoryEntries,
    recentPayments,
  ] = await Promise.all([
    getSitePartnerAllocatedFund(site.id),
    getSiteEquityInvestorFund(site.id),
    getSiteAllocatedFund(site.id),
    getSiteWithdrawnFund(site.id),
    getSiteTotalExpenses(site.id),
    getSiteTotalExpensesBilled(site.id),
    getSiteCustomerPayments(site.id),
    getSiteRemainingFund(site.id),
    prisma.floor.findMany({
      where: { siteId: site.id },
      orderBy: { floorNumber: 'asc' },
      include: {
        flats: {
          orderBy: { flatNumber: 'asc' },
          include: {
            customer: {
              where: { isDeleted: false, dealStatus: 'ACTIVE' },
              select: {
                name: true,
                customerType: true,
                sellingPrice: true,
                bookingAmount: true,
                ledgerEntries: { select: { amount: true, direction: true } },
              },
            },
          },
        },
      },
    }),
    prisma.customer.findMany({
      where: { siteId: site.id, isDeleted: false, dealStatus: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: {
        ledgerEntries: { select: { amount: true, direction: true } },
        flat: {
          select: {
            status: true,
            flatNumber: true,
            customFlatId: true,
            floor: { select: { floorNumber: true, floorName: true } },
          },
        },
      },
    }),
    prisma.expense.findMany({
      where: { siteId: site.id, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      include: {
        vendor: { select: { id: true, name: true, type: true } },
        ledgerEntries: {
          select: { amount: true, postedAt: true },
          orderBy: { postedAt: 'desc' },
        },
      },
    }),
    prisma.investor.findMany({
      where: { siteId: site.id, type: 'EQUITY', isDeleted: false },
      orderBy: { createdAt: 'desc' },
      include: {
        transactions: {
          where: { isDeleted: false },
          select: {
            kind: true,
            ledgerEntries: { select: { amount: true } },
          },
        },
      },
    }),
    prisma.payment.findMany({
      where: {
        companyId: company.id,
        siteId: site.id,
        walletType: 'SITE',
        movementType: { in: ['COMPANY_TO_SITE_TRANSFER', 'SITE_TO_COMPANY_TRANSFER'] },
      },
      orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.payment.findMany({
      where: {
        companyId: company.id,
        siteId: site.id,
        walletType: 'SITE',
      },
      orderBy: { postedAt: 'desc' },
      take: 12,
      include: {
        customer: { select: { name: true } },
        expense: {
          select: {
            reason: true,
            description: true,
            vendor: { select: { name: true } },
          },
        },
        investorTransaction: {
          select: {
            investor: { select: { name: true } },
          },
        },
      },
    }),
  ])

  const floors = floorsRaw.map((floor) => {
    const displayName = getFloorDisplayName(floor.floorName, floor.floorNumber)
    const flats = floor.flats.map((flat) => {
      const amountPaid = flat.customer ? sumDirectionalLedgerAmounts(flat.customer.ledgerEntries) : null
      const remaining = flat.customer ? flat.customer.sellingPrice - amountPaid! : null

      return {
        id: flat.id,
        flatNumber: flat.flatNumber,
        customFlatId: flat.customFlatId,
        displayName: getFlatDisplayName(flat.customFlatId, flat.flatNumber),
        status: flat.status,
        flatType: flat.flatType as 'CUSTOMER' | 'EXISTING_OWNER',
        customerName: flat.customer?.name ?? null,
        customerType: (flat.customer?.customerType ?? null) as 'CUSTOMER' | 'EXISTING_OWNER' | null,
        sellingPrice: flat.customer?.sellingPrice ?? null,
        bookingAmount: flat.customer?.bookingAmount ?? null,
        amountPaid,
        remaining,
      }
    })

    return {
      id: floor.id,
      floorNumber: floor.floorNumber,
      floorName: floor.floorName,
      displayName,
      totals: {
        totalUnits: flats.length,
        availableUnits: flats.filter((flat) => flat.status === 'AVAILABLE').length,
        bookedUnits: flats.filter((flat) => flat.status === 'BOOKED').length,
        soldUnits: flats.filter((flat) => flat.status === 'SOLD').length,
      },
      flats,
    }
  })

  const customers = customersRaw.map((customer) => {
    const amountPaid = sumDirectionalLedgerAmounts(customer.ledgerEntries)
    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      customerType: (customer.customerType ?? null) as 'CUSTOMER' | 'EXISTING_OWNER' | null,
      flatStatus: (customer.flat?.status ?? null) as 'BOOKED' | 'SOLD' | 'AVAILABLE' | null,
      floorName: customer.flat?.floor.floorName ?? getFloorDisplayName(null, customer.flat?.floor.floorNumber ?? 0),
      flatDisplayName: getFlatDisplayName(customer.flat?.customFlatId ?? null, customer.flat?.flatNumber ?? null),
      sellingPrice: customer.sellingPrice,
      bookingAmount: customer.bookingAmount,
      amountPaid,
      remaining: customer.sellingPrice - amountPaid,
      createdAt: customer.createdAt.toISOString(),
    }
  })

  const existingOwners = customers.filter((customer) => customer.customerType === 'EXISTING_OWNER')
  const expenses = expensesRaw.map(mapSiteExpense)
  const investors = investorsRaw.map((investor) => {
    const totals = calculateInvestorLedgerTotals(investor.transactions)
    return {
      id: investor.id,
      name: investor.name,
      phone: investor.phone,
      equityPercentage: investor.equityPercentage,
      totalInvested: totals.principalInTotal,
      totalReturned: totals.totalReturned,
      outstandingPrincipal: totals.outstandingPrincipal,
      isClosed: investor.isClosed,
      createdAt: investor.createdAt.toISOString(),
    }
  })

  let runningBalance = 0
  const fundHistory = fundHistoryEntries
    .map((entry) => {
      const signedAmount = entry.direction === 'IN' ? Number(entry.amount) : -Number(entry.amount)
      runningBalance += signedAmount
      return {
        id: entry.id,
        type: entry.direction === 'IN' ? ('ALLOCATION' as const) : ('WITHDRAWAL' as const),
        amount: Number(entry.amount),
        note: entry.note,
        runningBalance,
        createdAt: entry.postedAt.toISOString(),
      }
    })
    .reverse()

  const recentActivity = recentPayments.map((payment) => {
    const label = mapRecentActivityLabel(payment.movementType)
    const counterparty =
      payment.customer?.name
      ?? payment.expense?.vendor?.name
      ?? payment.investorTransaction?.investor?.name
      ?? payment.expense?.reason
      ?? payment.expense?.description
      ?? null

    return {
      id: payment.id,
      kind: label.kind,
      title: label.title,
      counterparty,
      amount: Number(payment.amount),
      direction: payment.direction,
      note: payment.note,
      createdAt: payment.postedAt.toISOString(),
    }
  })

  const allFlats = floors.flatMap((floor) => floor.flats)
  const totalAgreementValue = customers.reduce((sum, customer) => sum + customer.sellingPrice, 0)
  const totalBookingAmount = customers.reduce((sum, customer) => sum + customer.bookingAmount, 0)
  const totalCollected = customers.reduce((sum, customer) => sum + customer.amountPaid, 0)
  const totalOutstanding = customers.reduce((sum, customer) => sum + customer.remaining, 0)
  const totalReturned = investors.reduce((sum, investor) => sum + investor.totalReturned, 0)
  const outstandingPrincipal = investors.reduce((sum, investor) => sum + investor.outstandingPrincipal, 0)

  return {
    site: {
      id: site.id,
      name: site.name,
      address: site.address,
      projectType: site.projectType as 'NEW_CONSTRUCTION' | 'REDEVELOPMENT',
      totalFloors: site.totalFloors ?? floors.length,
      totalFlats: site.totalFlats ?? allFlats.length,
      generatedAt: new Date().toISOString(),
      createdAt: site.createdAt.toISOString(),
    },
    financialSummary: {
      partnerAllocatedFund,
      investorAllocatedFund,
      totalAllocatedFund,
      totalWithdrawnFund,
      totalExpensesPaid,
      totalExpensesRecorded,
      totalExpensesOutstanding: Math.max(0, totalExpensesRecorded - totalExpensesPaid),
      customerCollections,
      remainingFund,
      totalProjectedRevenue: totalAgreementValue,
      totalOutstandingReceivables: totalOutstanding,
      totalProfit: totalAgreementValue - totalExpensesRecorded,
    },
    inventorySummary: {
      totalUnits: allFlats.length,
      availableUnits: allFlats.filter((flat) => flat.status === 'AVAILABLE').length,
      bookedUnits: allFlats.filter((flat) => flat.status === 'BOOKED').length,
      soldUnits: allFlats.filter((flat) => flat.status === 'SOLD').length,
      customerFlats: allFlats.filter((flat) => flat.flatType === 'CUSTOMER').length,
      ownerFlats: allFlats.filter((flat) => flat.flatType === 'EXISTING_OWNER').length,
    },
    customerSummary: {
      totalCustomers: customers.length,
      bookedCustomers: customers.filter((customer) => customer.flatStatus === 'BOOKED').length,
      soldCustomers: customers.filter((customer) => customer.flatStatus === 'SOLD').length,
      existingOwners: existingOwners.length,
      totalAgreementValue,
      totalBookingAmount,
      totalCollected,
      totalOutstanding,
    },
    expenseSummary: {
      totalExpenseItems: expenses.length,
      generalExpenseItems: expenses.filter((expense) => expense.type === 'GENERAL').length,
      vendorExpenseItems: expenses.filter((expense) => expense.type === 'VENDOR').length,
      totalRecorded: expenses.reduce((sum, expense) => sum + expense.amount, 0),
      totalPaid: expenses.reduce((sum, expense) => sum + expense.amountPaid, 0),
      totalOutstanding: expenses.reduce((sum, expense) => sum + expense.remaining, 0),
      pendingCount: expenses.filter((expense) => expense.paymentStatus === 'PENDING').length,
      partialCount: expenses.filter((expense) => expense.paymentStatus === 'PARTIAL').length,
      completedCount: expenses.filter((expense) => expense.paymentStatus === 'COMPLETED').length,
    },
    investorSummary: {
      totalInvestors: investors.length,
      activeInvestors: investors.filter((investor) => !investor.isClosed).length,
      closedInvestors: investors.filter((investor) => investor.isClosed).length,
      totalInvested: investors.reduce((sum, investor) => sum + investor.totalInvested, 0),
      totalReturned,
      outstandingPrincipal,
    },
    floors,
    customers,
    existingOwners,
    expenses,
    investors,
    fundHistory,
    recentActivity,
  }
}
