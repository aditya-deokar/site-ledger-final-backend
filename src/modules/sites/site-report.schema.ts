import { z } from '@hono/zod-openapi'

export const siteReportSiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  projectType: z.enum(['NEW_CONSTRUCTION', 'REDEVELOPMENT']),
  totalFloors: z.number(),
  totalFlats: z.number(),
  generatedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
})

export const siteReportFinancialSummarySchema = z.object({
  partnerAllocatedFund: z.number(),
  investorAllocatedFund: z.number(),
  totalAllocatedFund: z.number(),
  totalWithdrawnFund: z.number(),
  totalAgreementValue: z.number(),
  netSaleValue: z.number(),
  totalTaxAmount: z.number(),
  totalDiscounts: z.number(),
  totalExpensesPaid: z.number(),
  totalExpensesRecorded: z.number(),
  totalExpensesOutstanding: z.number(),
  customerCollections: z.number(),
  remainingFund: z.number(),
  totalProjectedRevenue: z.number(),
  totalOutstandingReceivables: z.number(),
  totalProfit: z.number(),
})

export const siteReportInventorySummarySchema = z.object({
  totalUnits: z.number(),
  availableUnits: z.number(),
  bookedUnits: z.number(),
  soldUnits: z.number(),
  customerFlats: z.number(),
  ownerFlats: z.number(),
})

export const siteReportCustomerSummarySchema = z.object({
  totalCustomers: z.number(),
  bookedCustomers: z.number(),
  soldCustomers: z.number(),
  existingOwners: z.number(),
  totalAgreementValue: z.number(),
  netSaleValue: z.number(),
  totalTaxAmount: z.number(),
  totalDiscounts: z.number(),
  totalBookingAmount: z.number(),
  totalCollected: z.number(),
  totalOutstanding: z.number(),
})

export const siteReportExpenseSummarySchema = z.object({
  totalExpenseItems: z.number(),
  generalExpenseItems: z.number(),
  vendorExpenseItems: z.number(),
  totalRecorded: z.number(),
  totalPaid: z.number(),
  totalOutstanding: z.number(),
  pendingCount: z.number(),
  partialCount: z.number(),
  completedCount: z.number(),
})

export const siteReportInvestorSummarySchema = z.object({
  totalInvestors: z.number(),
  activeInvestors: z.number(),
  closedInvestors: z.number(),
  totalInvested: z.number(),
  totalReturned: z.number(),
  outstandingPrincipal: z.number(),
})

export const siteReportFlatRowSchema = z.object({
  id: z.string(),
  flatNumber: z.number().nullable(),
  customFlatId: z.string().nullable(),
  displayName: z.string(),
  status: z.enum(['AVAILABLE', 'BOOKED', 'SOLD']),
  flatType: z.enum(['CUSTOMER', 'EXISTING_OWNER']),
  customerName: z.string().nullable(),
  customerType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).nullable(),
  sellingPrice: z.number().nullable(),
  bookingAmount: z.number().nullable(),
  amountPaid: z.number().nullable(),
  remaining: z.number().nullable(),
})

export const siteReportFloorSchema = z.object({
  id: z.string(),
  floorNumber: z.number(),
  floorName: z.string().nullable(),
  displayName: z.string(),
  totals: z.object({
    totalUnits: z.number(),
    availableUnits: z.number(),
    bookedUnits: z.number(),
    soldUnits: z.number(),
  }),
  flats: z.array(siteReportFlatRowSchema),
})

export const siteReportCustomerRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  customerType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).nullable(),
  flatStatus: z.enum(['BOOKED', 'SOLD', 'AVAILABLE']).nullable(),
  floorName: z.string().nullable(),
  flatDisplayName: z.string(),
  sellingPrice: z.number(),
  bookingAmount: z.number(),
  amountPaid: z.number(),
  remaining: z.number(),
  createdAt: z.string().datetime(),
})

export const siteReportExpenseRowSchema = z.object({
  id: z.string(),
  type: z.enum(['GENERAL', 'VENDOR']),
  reason: z.string().nullable(),
  vendorName: z.string().nullable(),
  vendorType: z.string().nullable(),
  description: z.string().nullable(),
  amount: z.number(),
  amountPaid: z.number(),
  remaining: z.number(),
  paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
  paymentDate: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const siteReportInvestorRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  equityPercentage: z.number().nullable(),
  totalInvested: z.number(),
  totalReturned: z.number(),
  outstandingPrincipal: z.number(),
  isClosed: z.boolean(),
  createdAt: z.string().datetime(),
})

export const siteReportFundHistoryRowSchema = z.object({
  id: z.string(),
  type: z.enum(['ALLOCATION', 'WITHDRAWAL']),
  amount: z.number(),
  note: z.string().nullable(),
  runningBalance: z.number(),
  createdAt: z.string().datetime(),
})

export const siteReportActivityRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  counterparty: z.string().nullable(),
  amount: z.number(),
  direction: z.enum(['IN', 'OUT']),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
})

export const siteReportSchema = z.object({
  site: siteReportSiteSchema,
  financialSummary: siteReportFinancialSummarySchema,
  inventorySummary: siteReportInventorySummarySchema,
  customerSummary: siteReportCustomerSummarySchema,
  expenseSummary: siteReportExpenseSummarySchema,
  investorSummary: siteReportInvestorSummarySchema,
  floors: z.array(siteReportFloorSchema),
  customers: z.array(siteReportCustomerRowSchema),
  existingOwners: z.array(siteReportCustomerRowSchema),
  expenses: z.array(siteReportExpenseRowSchema),
  investors: z.array(siteReportInvestorRowSchema),
  fundHistory: z.array(siteReportFundHistoryRowSchema),
  recentActivity: z.array(siteReportActivityRowSchema),
})
