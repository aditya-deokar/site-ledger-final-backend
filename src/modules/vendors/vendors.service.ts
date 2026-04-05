import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { invalidateVendorCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { mapVendorBase } from './vendors.mapper.js'

export type VendorServiceError = {
  error: string
  status: number
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

export async function getVendorForUser(vendorId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, vendor: null }

  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, companyId: company.id, isDeleted: false },
  })

  return { company, vendor }
}

export async function getVendorsForUser(userId: string, type?: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const cacheKey = `${CacheKeys.vendorList(company.id)}:${type ?? 'all'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const vendors = await prisma.vendor.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      ...(type ? { type } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    vendors: vendors.map(mapVendorBase),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function createVendorForUser(
  userId: string,
  data: { name: string; type: string; phone?: string; email?: string },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const vendor = await prisma.vendor.create({
    data: {
      companyId: company.id,
      name: data.name,
      type: data.type,
      phone: data.phone,
      email: data.email,
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
  data: { name?: string; type?: string; phone?: string; email?: string },
) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found', status: 404 }

  const existing = await prisma.vendor.findFirst({
    where: { id: vendorId, companyId: company.id, isDeleted: false },
  })
  if (!existing) return { error: 'Vendor not found', status: 404 }

  const vendor = await prisma.vendor.update({
    where: { id: vendorId },
    data,
  })

  await invalidateVendorCaches(company.id, vendorId)

  return {
    vendor: mapVendorBase(vendor),
  }
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