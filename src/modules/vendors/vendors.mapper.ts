type VendorLike = {
  id: string
  name: string
  type: string
  status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'ARCHIVED'
  contactPersonName: string | null
  phone: string | null
  email: string | null
  address: string | null
  gstin: string | null
  pan: string | null
  bankAccountName: string | null
  bankName: string | null
  accountNumber: string | null
  ifscCode: string | null
  upiId: string | null
  paymentTermsDays: number | null
  notes: string | null
  openingBalanceAmount: number
  openingBalanceDate: Date | null
  createdAt: Date
  updatedAt: Date
}

type VendorAssignmentLike = {
  id: string
  siteId: string
  status: 'ACTIVE' | 'INACTIVE'
  isPreferred: boolean
  paymentTermsDaysOverride: number | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  site: {
    name: string
  }
}

type VendorDocumentLike = {
  id: string
  vendorId: string
  siteId: string | null
  expenseId: string | null
  documentType: string
  documentName: string
  fileUrl: string
  note: string | null
  uploadedAt: Date
  site: {
    name: string
  } | null
  expense: {
    billNumber: string | null
  } | null
}

export function mapVendorBase(vendor: VendorLike) {
  return {
    id: vendor.id,
    name: vendor.name,
    type: vendor.type,
    status: vendor.status,
    contactPersonName: vendor.contactPersonName,
    phone: vendor.phone,
    email: vendor.email,
    address: vendor.address,
    gstin: vendor.gstin,
    pan: vendor.pan,
    bankAccountName: vendor.bankAccountName,
    bankName: vendor.bankName,
    accountNumber: vendor.accountNumber,
    ifscCode: vendor.ifscCode,
    upiId: vendor.upiId,
    paymentTermsDays: vendor.paymentTermsDays,
    notes: vendor.notes,
    openingBalanceAmount: vendor.openingBalanceAmount,
    openingBalanceDate: vendor.openingBalanceDate?.toISOString() ?? null,
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
  }
}

export function mapVendorAssignment(assignment: VendorAssignmentLike) {
  return {
    id: assignment.id,
    siteId: assignment.siteId,
    siteName: assignment.site.name,
    status: assignment.status,
    isPreferred: assignment.isPreferred,
    paymentTermsDaysOverride: assignment.paymentTermsDaysOverride,
    notes: assignment.notes,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  }
}

export function mapVendorDocument(document: VendorDocumentLike) {
  return {
    id: document.id,
    vendorId: document.vendorId,
    siteId: document.siteId,
    siteName: document.site?.name ?? null,
    expenseId: document.expenseId,
    billNumber: document.expense?.billNumber ?? null,
    documentType: document.documentType,
    documentName: document.documentName,
    fileUrl: document.fileUrl,
    note: document.note,
    uploadedAt: document.uploadedAt.toISOString(),
  }
}

export function mapVendorListItem(
  vendor: VendorLike,
  summary: {
    siteCount: number
    documentCount: number
    billCount: number
    paymentCount: number
    overdueBillCount: number
    totalBilled: number
    totalPaid: number
    totalOutstanding: number
    lastBillDate: string | null
    lastPaymentDate: string | null
  },
) {
  return {
    ...mapVendorBase(vendor),
    siteCount: summary.siteCount,
    documentCount: summary.documentCount,
    billCount: summary.billCount,
    paymentCount: summary.paymentCount,
    overdueBillCount: summary.overdueBillCount,
    totalExpenses: summary.totalBilled,
    totalBilled: summary.totalBilled,
    totalPaid: summary.totalPaid,
    totalOutstanding: summary.totalOutstanding,
    remainingBalance: summary.totalOutstanding,
    lastBillDate: summary.lastBillDate,
    lastPaymentDate: summary.lastPaymentDate,
  }
}

export function mapVendorSummary(
  vendor: VendorLike,
  summary: {
    siteCount: number
    documentCount: number
    billCount: number
    paymentCount: number
    overdueBillCount: number
    totalBilled: number
    totalPaid: number
    totalOutstanding: number
    lastBillDate: string | null
    lastPaymentDate: string | null
  },
  assignments: VendorAssignmentLike[],
) {
  return {
    ...mapVendorListItem(vendor, summary),
    assignments: assignments.map(mapVendorAssignment),
  }
}
