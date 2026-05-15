import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { invalidateVendorCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { getVendorExpenseRecords, summarizeVendorRecords } from '../../services/vendor-accounting.service.js'
import { mapVendorBase, mapVendorDocument, mapVendorListItem } from './vendors.mapper.js'

export type VendorServiceError = {
  error: string
  status: number
}

type VendorListQuery = {
  type?: string
  search?: string
  status?: 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'ARCHIVED'
  siteId?: string
  hasOutstanding?: boolean
  hasDocuments?: boolean
  includeArchived?: boolean
  page?: number
  size?: number
}

type VendorInput = {
  name: string
  type: string
  status?: 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'ARCHIVED'
  contactPersonName?: string
  phone?: string
  email?: string
  address?: string
  gstin?: string
  pan?: string
  bankAccountName?: string
  bankName?: string
  accountNumber?: string
  ifscCode?: string
  upiId?: string
  paymentTermsDays?: number
  notes?: string
  openingBalanceAmount?: number
  openingBalanceDate?: string
}

type VendorAssignmentInput = {
  status?: 'ACTIVE' | 'INACTIVE'
  isPreferred?: boolean
  paymentTermsDaysOverride?: number | null
  notes?: string
}

type VendorDocumentInput = {
  documentType: string
  documentName: string
  fileUrl: string
  note?: string
  siteId?: string
  expenseId?: string
}

export function isVendorServiceError(result: unknown): result is VendorServiceError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

function trimToUndefined(value?: string | null) {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function toNullableDate(value?: string | null) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function normalizeVendorWriteInput(data: Partial<VendorInput>) {
  return {
    name: trimToUndefined(data.name),
    type: trimToUndefined(data.type),
    status: data.status,
    contactPersonName: trimToUndefined(data.contactPersonName) ?? null,
    phone: trimToUndefined(data.phone) ?? null,
    email: trimToUndefined(data.email) ?? null,
    address: trimToUndefined(data.address) ?? null,
    gstin: trimToUndefined(data.gstin) ?? null,
    pan: trimToUndefined(data.pan) ?? null,
    bankAccountName: trimToUndefined(data.bankAccountName) ?? null,
    bankName: trimToUndefined(data.bankName) ?? null,
    accountNumber: trimToUndefined(data.accountNumber) ?? null,
    ifscCode: trimToUndefined(data.ifscCode) ?? null,
    upiId: trimToUndefined(data.upiId) ?? null,
    paymentTermsDays: data.paymentTermsDays ?? null,
    notes: trimToUndefined(data.notes) ?? null,
    openingBalanceAmount: data.openingBalanceAmount ?? 0,
    openingBalanceDate: toNullableDate(data.openingBalanceDate),
  }
}

async function buildVendorSummaryMap(vendors: Array<{ id: string; openingBalanceAmount: number }>) {
  const summaryEntries = await Promise.all(
    vendors.map(async (vendor) => {
      const expenses = await getVendorExpenseRecords(vendor.id)
      const summary = summarizeVendorRecords(expenses, vendor.openingBalanceAmount)
      return [
        vendor.id,
        {
          ...summary,
          documentCount: 0,
          siteCount: 0,
        },
      ] as const
    }),
  )

  return new Map(summaryEntries)
}

async function buildVendorAuxiliaryMaps(companyId: string, vendorIds: string[]) {
  if (vendorIds.length === 0) {
    return {
      assignmentsByVendorId: new Map<string, Array<{ siteId: string }>>(),
      documentCountByVendorId: new Map<string, number>(),
    }
  }

  const [assignments, documentCounts] = await Promise.all([
    prisma.vendorSiteAssignment.findMany({
      where: { vendorId: { in: vendorIds } },
      select: { vendorId: true, siteId: true },
    }),
    prisma.vendorDocument.groupBy({
      by: ['vendorId'],
      where: {
        vendorId: { in: vendorIds },
        vendor: { companyId },
      },
      _count: { _all: true },
    }),
  ])

  const assignmentsByVendorId = new Map<string, Array<{ siteId: string }>>()
  for (const assignment of assignments) {
    const list = assignmentsByVendorId.get(assignment.vendorId) ?? []
    list.push({ siteId: assignment.siteId })
    assignmentsByVendorId.set(assignment.vendorId, list)
  }

  const documentCountByVendorId = new Map<string, number>()
  for (const entry of documentCounts) {
    documentCountByVendorId.set(entry.vendorId, entry._count._all)
  }

  return {
    assignmentsByVendorId,
    documentCountByVendorId,
  }
}

export async function getVendorForUser(vendorId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, vendor: null }

  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, companyId: company.id, isDeleted: false },
  })

  return { company, vendor }
}

export async function getVendorsForUser(userId: string, query: VendorListQuery = {}) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const cacheKey = `${CacheKeys.vendorList(company.id)}:${JSON.stringify(query)}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const search = trimToUndefined(query.search)
  const shouldIncludeArchived = query.includeArchived ?? false

  const vendors = await prisma.vendor.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : shouldIncludeArchived ? {} : { status: { not: 'ARCHIVED' } }),
      ...(query.hasDocuments === true ? { documents: { some: {} } } : {}),
      ...(query.hasDocuments === false ? { documents: { none: {} } } : {}),
      ...(query.siteId
        ? {
            OR: [
              { assignments: { some: { siteId: query.siteId } } },
              { expenses: { some: { siteId: query.siteId, isDeleted: false } } },
            ],
          }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { type: { contains: search, mode: 'insensitive' } },
              { contactPersonName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { gstin: { contains: search, mode: 'insensitive' } },
              { pan: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [
      { createdAt: 'desc' },
      { name: 'asc' },
    ],
  })

  const vendorIds = vendors.map((vendor) => vendor.id)
  const [summaryMap, auxiliaryMaps] = await Promise.all([
    buildVendorSummaryMap(vendors.map((vendor) => ({ id: vendor.id, openingBalanceAmount: vendor.openingBalanceAmount }))),
    buildVendorAuxiliaryMaps(company.id, vendorIds),
  ])

  const filteredVendors = vendors
    .map((vendor) => {
      const summary = summaryMap.get(vendor.id) ?? {
        totalBilled: 0,
        totalPaid: 0,
        totalOutstanding: vendor.openingBalanceAmount,
        billCount: 0,
        overdueBillCount: 0,
        paymentCount: 0,
        lastBillDate: null,
        lastPaymentDate: null,
        documentCount: 0,
        siteCount: 0,
      }

      return mapVendorListItem(vendor, {
        siteCount: auxiliaryMaps.assignmentsByVendorId.get(vendor.id)?.length ?? 0,
        documentCount: auxiliaryMaps.documentCountByVendorId.get(vendor.id) ?? 0,
        billCount: summary.billCount,
        paymentCount: summary.paymentCount,
        overdueBillCount: summary.overdueBillCount,
        totalBilled: summary.totalBilled,
        totalPaid: summary.totalPaid,
        totalOutstanding: summary.totalOutstanding,
        lastBillDate: summary.lastBillDate,
        lastPaymentDate: summary.lastPaymentDate,
      })
    })
    .filter((vendor) => {
      if (query.hasOutstanding === true && vendor.totalOutstanding <= 0) return false
      if (query.hasOutstanding === false && vendor.totalOutstanding > 0) return false
      return true
    })

  const total = filteredVendors.length
  const size = query.size ?? (total > 0 ? total : 1)
  const page = query.page ?? 1
  const totalPages = total === 0 ? 0 : Math.ceil(total / size)
  const start = (page - 1) * size
  const vendorsPage = filteredVendors.slice(start, start + size)

  const responseData = {
    vendors: vendorsPage,
    pagination: {
      page,
      size,
      total,
      totalPages,
    },
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function createVendorForUser(userId: string, data: VendorInput) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const normalized = normalizeVendorWriteInput(data)
  if (!normalized.name || !normalized.type) {
    return { error: 'Vendor name and type are required', status: 400 }
  }

  const vendor = await prisma.vendor.create({
    data: {
      companyId: company.id,
      name: normalized.name,
      type: normalized.type,
      status: normalized.status ?? 'ACTIVE',
      contactPersonName: normalized.contactPersonName,
      phone: normalized.phone,
      email: normalized.email,
      address: normalized.address,
      gstin: normalized.gstin,
      pan: normalized.pan,
      bankAccountName: normalized.bankAccountName,
      bankName: normalized.bankName,
      accountNumber: normalized.accountNumber,
      ifscCode: normalized.ifscCode,
      upiId: normalized.upiId,
      paymentTermsDays: normalized.paymentTermsDays,
      notes: normalized.notes,
      openingBalanceAmount: normalized.openingBalanceAmount,
      openingBalanceDate: normalized.openingBalanceDate,
    },
  })

  await invalidateVendorCaches(company.id)

  return {
    vendor: mapVendorBase(vendor),
  }
}

export async function updateVendorForUser(
  vendorId: string,
  userId: string,
  data: Partial<VendorInput>,
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found', status: 404 }

  const existing = await prisma.vendor.findFirst({
    where: { id: vendorId, companyId: company.id, isDeleted: false },
  })
  if (!existing) return { error: 'Vendor not found', status: 404 }

  const normalized = normalizeVendorWriteInput(data)
  const vendor = await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      ...(normalized.name !== undefined ? { name: normalized.name } : {}),
      ...(normalized.type !== undefined ? { type: normalized.type } : {}),
      ...(normalized.status !== undefined ? { status: normalized.status } : {}),
      ...(data.contactPersonName !== undefined ? { contactPersonName: normalized.contactPersonName } : {}),
      ...(data.phone !== undefined ? { phone: normalized.phone } : {}),
      ...(data.email !== undefined ? { email: normalized.email } : {}),
      ...(data.address !== undefined ? { address: normalized.address } : {}),
      ...(data.gstin !== undefined ? { gstin: normalized.gstin } : {}),
      ...(data.pan !== undefined ? { pan: normalized.pan } : {}),
      ...(data.bankAccountName !== undefined ? { bankAccountName: normalized.bankAccountName } : {}),
      ...(data.bankName !== undefined ? { bankName: normalized.bankName } : {}),
      ...(data.accountNumber !== undefined ? { accountNumber: normalized.accountNumber } : {}),
      ...(data.ifscCode !== undefined ? { ifscCode: normalized.ifscCode } : {}),
      ...(data.upiId !== undefined ? { upiId: normalized.upiId } : {}),
      ...(data.paymentTermsDays !== undefined ? { paymentTermsDays: normalized.paymentTermsDays } : {}),
      ...(data.notes !== undefined ? { notes: normalized.notes } : {}),
      ...(data.openingBalanceAmount !== undefined ? { openingBalanceAmount: normalized.openingBalanceAmount } : {}),
      ...(data.openingBalanceDate !== undefined ? { openingBalanceDate: normalized.openingBalanceDate } : {}),
    },
  })

  await invalidateVendorCaches(company.id, vendorId)

  return {
    vendor: mapVendorBase(vendor),
  }
}

export async function patchVendorStatusForUser(
  vendorId: string,
  userId: string,
  status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'ARCHIVED',
) {
  return updateVendorForUser(vendorId, userId, { status })
}

export async function deleteVendorForUser(vendorId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found', status: 404 }

  const existing = await prisma.vendor.findFirst({
    where: { id: vendorId, companyId: company.id, isDeleted: false },
  })
  if (!existing) return { error: 'Vendor not found', status: 404 }

  await prisma.vendor.update({
    where: { id: vendorId },
    data: { isDeleted: true },
  })

  await invalidateVendorCaches(company.id, vendorId)

  return { message: `Vendor "${existing.name}" removed` }
}

export async function listVendorSiteAssignmentsForUser(vendorId: string, userId: string) {
  const context = await getVendorForUser(vendorId, userId)
  if (!context.company) return { error: 'No company found', status: 404 as const }
  if (!context.vendor) return { error: 'Vendor not found', status: 404 as const }

  const assignments = await prisma.vendorSiteAssignment.findMany({
    where: { vendorId: context.vendor.id },
    include: {
      site: {
        select: {
          name: true,
        },
      },
    },
    orderBy: [
      { isPreferred: 'desc' },
      { createdAt: 'asc' },
    ],
  })

  return { assignments: assignments.map((assignment) => ({
    id: assignment.id,
    siteId: assignment.siteId,
    siteName: assignment.site.name,
    status: assignment.status,
    isPreferred: assignment.isPreferred,
    paymentTermsDaysOverride: assignment.paymentTermsDaysOverride,
    notes: assignment.notes,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  })) }
}

export async function upsertVendorSiteAssignmentForUser(
  vendorId: string,
  siteId: string,
  userId: string,
  data: VendorAssignmentInput,
) {
  const context = await getVendorForUser(vendorId, userId)
  if (!context.company) return { error: 'No company found', status: 404 as const }
  if (!context.vendor) return { error: 'Vendor not found', status: 404 as const }

  const site = await prisma.site.findFirst({
    where: {
      id: siteId,
      companyId: context.company.id,
    },
  })
  if (!site) return { error: 'Site not found', status: 404 as const }

  const assignment = await prisma.vendorSiteAssignment.upsert({
    where: {
      vendorId_siteId: {
        vendorId: context.vendor.id,
        siteId: site.id,
      },
    },
    update: {
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.isPreferred !== undefined ? { isPreferred: data.isPreferred } : {}),
      ...(data.paymentTermsDaysOverride !== undefined ? { paymentTermsDaysOverride: data.paymentTermsDaysOverride } : {}),
      ...(data.notes !== undefined ? { notes: trimToUndefined(data.notes) ?? null } : {}),
    },
    create: {
      vendorId: context.vendor.id,
      siteId: site.id,
      status: data.status ?? 'ACTIVE',
      isPreferred: data.isPreferred ?? false,
      paymentTermsDaysOverride: data.paymentTermsDaysOverride ?? null,
      notes: trimToUndefined(data.notes) ?? null,
    },
    include: {
      site: {
        select: {
          name: true,
        },
      },
    },
  })

  await invalidateVendorCaches(context.company.id, context.vendor.id)

  return {
    assignment: {
      id: assignment.id,
      siteId: assignment.siteId,
      siteName: assignment.site.name,
      status: assignment.status,
      isPreferred: assignment.isPreferred,
      paymentTermsDaysOverride: assignment.paymentTermsDaysOverride,
      notes: assignment.notes,
      createdAt: assignment.createdAt.toISOString(),
      updatedAt: assignment.updatedAt.toISOString(),
    },
  }
}

export async function listVendorDocumentsForUser(vendorId: string, userId: string) {
  const context = await getVendorForUser(vendorId, userId)
  if (!context.company) return { error: 'No company found', status: 404 as const }
  if (!context.vendor) return { error: 'Vendor not found', status: 404 as const }

  const documents = await prisma.vendorDocument.findMany({
    where: { vendorId: context.vendor.id },
    include: {
      site: {
        select: { name: true },
      },
      expense: {
        select: { billNumber: true },
      },
    },
    orderBy: { uploadedAt: 'desc' },
  })

  return {
    documents: documents.map(mapVendorDocument),
  }
}

export async function createVendorDocumentForUser(vendorId: string, userId: string, data: VendorDocumentInput) {
  const context = await getVendorForUser(vendorId, userId)
  if (!context.company) return { error: 'No company found', status: 404 as const }
  if (!context.vendor) return { error: 'Vendor not found', status: 404 as const }

  let siteId: string | null = null
  if (data.siteId) {
    const site = await prisma.site.findFirst({
      where: { id: data.siteId, companyId: context.company.id },
      select: { id: true },
    })
    if (!site) return { error: 'Site not found', status: 404 as const }
    siteId = site.id
  }

  let expenseId: string | null = null
  if (data.expenseId) {
    const expense = await prisma.expense.findFirst({
      where: {
        id: data.expenseId,
        vendorId: context.vendor.id,
        site: { companyId: context.company.id },
      },
      select: { id: true, siteId: true },
    })
    if (!expense) return { error: 'Vendor bill not found', status: 404 as const }
    expenseId = expense.id
    siteId = siteId ?? expense.siteId
  }

  const document = await prisma.vendorDocument.create({
    data: {
      vendorId: context.vendor.id,
      siteId,
      expenseId,
      documentType: data.documentType.trim(),
      documentName: data.documentName.trim(),
      fileUrl: data.fileUrl,
      note: trimToUndefined(data.note) ?? null,
    },
    include: {
      site: {
        select: { name: true },
      },
      expense: {
        select: { billNumber: true },
      },
    },
  })

  await invalidateVendorCaches(context.company.id, context.vendor.id)

  return {
    document: mapVendorDocument(document),
  }
}

export async function deleteVendorDocumentForUser(vendorId: string, documentId: string, userId: string) {
  const context = await getVendorForUser(vendorId, userId)
  if (!context.company) return { error: 'No company found', status: 404 as const }
  if (!context.vendor) return { error: 'Vendor not found', status: 404 as const }

  const document = await prisma.vendorDocument.findFirst({
    where: {
      id: documentId,
      vendorId: context.vendor.id,
    },
  })
  if (!document) return { error: 'Vendor document not found', status: 404 as const }

  await prisma.vendorDocument.delete({
    where: { id: document.id },
  })

  await invalidateVendorCaches(context.company.id, context.vendor.id)

  return {
    message: `Document "${document.documentName}" deleted`,
  }
}
