// ── Cache Key Builders ────────────────────────────────
// Convention: gaa:{entity}:{scope}:{id}

export const CacheKeys = {
  // Company
  companyByUser: (userId: string) => `gaa:company:user:${userId}`,
  companyDetails: (companyId: string) => `gaa:company:details:${companyId}`,
  companyExpenses: (companyId: string) => `gaa:company:expenses:${companyId}`,
  companyWithdrawalList: (companyId: string) => `gaa:company:withdrawals:${companyId}`,

  // Fund calculations (company-level)
  companyPartnerFund: (companyId: string) => `gaa:fund:company:partner:${companyId}`,
  companyInvestorFund: (companyId: string) => `gaa:fund:company:investor:${companyId}`,
  companyFixedRateReturned: (companyId: string) => `gaa:fund:company:fr-returned:${companyId}`,
  companyAvailableFund: (companyId: string) => `gaa:fund:company:available:${companyId}`,
  companyTotalFund: (companyId: string) => `gaa:fund:company:total:${companyId}`,
  companyWithdrawals: (companyId: string) => `gaa:fund:company:withdrawals:${companyId}`,
  companyAllocated: (companyId: string) => `gaa:fund:company:allocated:${companyId}`,

  // Fund calculations (site-level)
  sitePartnerAllocated: (siteId: string) => `gaa:fund:site:partner-alloc:${siteId}`,
  siteWithdrawn: (siteId: string) => `gaa:fund:site:withdrawn:${siteId}`,
  siteEquityInvestorFund: (siteId: string) => `gaa:fund:site:equity-inv:${siteId}`,
  siteAllocated: (siteId: string) => `gaa:fund:site:allocated:${siteId}`,
  siteExpenses: (siteId: string) => `gaa:fund:site:expenses:${siteId}`,
  siteCustomerPayments: (siteId: string) => `gaa:fund:site:payments:${siteId}`,
  siteEquityReturned: (siteId: string) => `gaa:fund:site:equity-returned:${siteId}`,
  siteRemaining: (siteId: string) => `gaa:fund:site:remaining:${siteId}`,

  // Site responses
  siteList: (companyId: string) => `gaa:sites:list:${companyId}`,
  siteDetail: (siteId: string) => `gaa:sites:detail:${siteId}`,
  siteFundHistory: (siteId: string) => `gaa:sites:fund-history:${siteId}`,
  siteExpenseList: (siteId: string) => `gaa:sites:expense-list:${siteId}`,
  siteExpenseSummary: (siteId: string) => `gaa:sites:expense-summary:${siteId}`,
  siteFloors: (siteId: string) => `gaa:sites:floors:${siteId}`,
  siteInvestors: (siteId: string) => `gaa:sites:investors:${siteId}`,
  siteCustomers: (siteId: string) => `gaa:sites:customers:${siteId}`,

  // Entity lists
  vendorList: (companyId: string) => `gaa:vendors:list:${companyId}`,
  vendorDetail: (vendorId: string) => `gaa:vendors:detail:${vendorId}`,
  vendorTransactions: (vendorId: string) => `gaa:vendors:txns:${vendorId}`,
  vendorPayments: (vendorId: string) => `gaa:vendors:payments:${vendorId}`,
  vendorStatement: (vendorId: string) => `gaa:vendors:statement:${vendorId}`,
  customerList: (companyId: string) => `gaa:customers:list:${companyId}`,
  flatCustomer: (flatId: string) => `gaa:customers:flat:${flatId}`,
  investorList: (companyId: string) => `gaa:investors:list:${companyId}`,
  investorDetail: (investorId: string) => `gaa:investors:detail:${investorId}`,
  investorTransactions: (investorId: string) => `gaa:investors:txns:${investorId}`,
  partnerList: (companyId: string) => `gaa:partners:list:${companyId}`,

  // Activity feed
  activityFeed: (companyId: string) => `gaa:activity:${companyId}`,
} as const

// ── TTL Strategy (seconds) ────────────────────────────

export const CacheTTL = {
  COMPANY_PROFILE: 300,     // 5 min — rarely changes
  COMPANY_FOR_USER: 600,    // 10 min — almost never changes
  FUND_CALCULATIONS: 60,    // 1 min — changes on financial mutations
  SITE_LIST: 120,           // 2 min — moderate change frequency
  SITE_DETAIL: 120,         // 2 min
  ENTITY_LIST: 180,         // 3 min — vendors, customers, investors
  ENTITY_DETAIL: 300,       // 5 min — single record views
  ACTIVITY_FEED: 30,        // 30 sec — frequently updated
  PARTNER_LIST: 300,        // 5 min — rarely changes
} as const
