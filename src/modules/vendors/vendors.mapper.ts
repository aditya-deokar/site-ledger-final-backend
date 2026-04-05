export function mapVendorBase(vendor: {
  id: string
  name: string
  type: string
  phone: string | null
  email: string | null
  createdAt: Date
}) {
  return {
    id: vendor.id,
    name: vendor.name,
    type: vendor.type,
    phone: vendor.phone,
    email: vendor.email,
    createdAt: vendor.createdAt.toISOString(),
  }
}

export function mapVendorSummary(
  vendor: {
    id: string
    name: string
    type: string
    phone: string | null
    email: string | null
    createdAt: Date
  },
  summary: {
    totalBilled: number
    totalPaid: number
    totalOutstanding: number
    billCount: number
  },
) {
  return {
    ...mapVendorBase(vendor),
    totalExpenses: summary.totalBilled,
    totalBilled: summary.totalBilled,
    totalPaid: summary.totalPaid,
    totalOutstanding: summary.totalOutstanding,
    remainingBalance: summary.totalOutstanding,
    expenseCount: summary.billCount,
    billCount: summary.billCount,
  }
}