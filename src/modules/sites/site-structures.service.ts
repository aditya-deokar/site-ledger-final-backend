import { prisma } from '../../db/prisma.js'
import { sumDirectionalLedgerAmounts } from '../../services/customer-ledger.service.js'
import { invalidateSiteListCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { getSiteForUser } from './site-access.service.js'

async function syncSiteStructureCounts(siteId: string) {
  const [floorCount, flatCount] = await Promise.all([
    prisma.floor.count({ where: { siteId } }),
    prisma.flat.count({ where: { siteId } }),
  ])

  await prisma.site.update({
    where: { id: siteId },
    data: {
      totalFloors: floorCount,
      totalFlats: flatCount,
    },
  })
}

export async function createFloorForUser(siteId: string, userId: string, floorName: string) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const trimmedName = floorName.trim()
  const lastFloor = await prisma.floor.findFirst({
    where: { siteId: site.id, wingId: null },
    orderBy: { floorNumber: 'desc' },
  })
  const nextFloorNumber = (lastFloor?.floorNumber ?? 0) + 1

  const floor = await prisma.floor.create({
    data: {
      siteId: site.id,
      floorNumber: nextFloorNumber,
      floorName: trimmedName,
      wingId: null,
    },
  })

  await prisma.site.update({
    where: { id: site.id },
    data: { totalFloors: { increment: 1 } },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await invalidateSiteListCaches(company.id)

  return floor
}

export async function createFloorInWingForUser(
  siteId: string,
  userId: string,
  data: { floorName: string; wingId?: string },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const requestedWingId = data.wingId?.trim() || null
  if (requestedWingId) {
    const wing = await prisma.wing.findFirst({
      where: { id: requestedWingId, siteId: site.id },
    })
    if (!wing) return { error: 'Wing not found', status: 404 as const }
  }

  const lastFloor = await prisma.floor.findFirst({
    where: {
      siteId: site.id,
      wingId: requestedWingId,
    },
    orderBy: { floorNumber: 'desc' },
  })
  const nextFloorNumber = (lastFloor?.floorNumber ?? 0) + 1

  const floor = await prisma.floor.create({
    data: {
      siteId: site.id,
      floorNumber: nextFloorNumber,
      floorName: data.floorName.trim(),
      wingId: requestedWingId,
    },
  })

  await prisma.site.update({
    where: { id: site.id },
    data: { totalFloors: { increment: 1 } },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await invalidateSiteListCaches(company.id)

  return floor
}

export async function getWingsForUser(siteId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const wings = await prisma.wing.findMany({
    where: { siteId: site.id },
    include: {
      _count: {
        select: { floors: true },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
  })

  return {
    wings: wings.map((wing) => ({
      id: wing.id,
      siteId: wing.siteId,
      name: wing.name,
      code: wing.code,
      isActive: wing.isActive,
      floorsCount: wing._count.floors,
      createdAt: wing.createdAt.toISOString(),
      updatedAt: wing.updatedAt.toISOString(),
    })),
  }
}

export async function createWingForUser(siteId: string, userId: string, data: { name: string }) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const trimmedName = data.name.trim()
  const duplicate = await prisma.wing.findFirst({
    where: {
      siteId: site.id,
      name: { equals: trimmedName, mode: 'insensitive' },
    },
  })
  if (duplicate) return { error: 'Wing name already exists for this site', status: 400 as const }

  const wingsCount = await prisma.wing.count({ where: { siteId: site.id } })
  const code = String.fromCharCode(65 + (wingsCount % 26))
  const wing = await prisma.wing.create({
    data: {
      siteId: site.id,
      name: trimmedName,
      code,
      isActive: true,
    },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(company.id)

  return wing
}

export async function updateWingForUser(
  siteId: string,
  wingId: string,
  userId: string,
  data: { name: string },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const wing = await prisma.wing.findFirst({
    where: { id: wingId, siteId: site.id },
  })
  if (!wing) return { error: 'Wing not found', status: 404 as const }

  const trimmedName = data.name.trim()
  const duplicate = await prisma.wing.findFirst({
    where: {
      siteId: site.id,
      id: { not: wing.id },
      name: { equals: trimmedName, mode: 'insensitive' },
    },
  })
  if (duplicate) return { error: 'Wing name already exists for this site', status: 400 as const }

  const updated = await prisma.wing.update({
    where: { id: wing.id },
    data: { name: trimmedName },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(company.id)

  return updated
}

export async function deleteWingForUser(siteId: string, wingId: string, userId: string) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const wing = await prisma.wing.findFirst({
    where: { id: wingId, siteId: site.id },
    include: {
      _count: {
        select: { floors: true },
      },
    },
  })
  if (!wing) return { error: 'Wing not found', status: 404 as const }

  if (wing._count.floors > 0) {
    return {
      error: 'Cannot delete this wing because it still has floors',
      status: 400 as const,
    }
  }

  await prisma.wing.delete({
    where: { id: wing.id },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(company.id)

  return { id: wing.id }
}

export async function createFlatForUser(
  siteId: string,
  floorId: string,
  userId: string,
  data: { customFlatId: string; unitType?: string; flatType?: 'CUSTOMER' | 'EXISTING_OWNER' },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const requestedFlatType = data.flatType ?? 'CUSTOMER'
  const flatType = site.projectType === 'NEW_CONSTRUCTION' ? 'CUSTOMER' : requestedFlatType

  const floor = await prisma.floor.findFirst({
    where: { id: floorId, siteId: site.id },
  })
  if (!floor) return { error: 'Floor not found', status: 404 as const }

  const existing = await prisma.flat.findFirst({
    where: { siteId: site.id, customFlatId: data.customFlatId },
  })
  if (existing) return { error: 'Flat ID already exists in this site', status: 400 as const }

  const flat = await prisma.flat.create({
    data: {
      siteId: site.id,
      floorId: floor.id,
      customFlatId: data.customFlatId,
      unitType: data.unitType?.trim() || null,
      flatType,
      status: 'AVAILABLE',
    },
  })

  await prisma.site.update({
    where: { id: site.id },
    data: { totalFlats: { increment: 1 } },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await invalidateSiteListCaches(company.id)

  return flat
}

export async function getFloorsForUser(siteId: string, userId: string) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const cacheKey = CacheKeys.siteFloors(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return cached

  const floors = await prisma.floor.findMany({
    where: { siteId: site.id },
    include: {
      wing: {
        select: {
          id: true,
          name: true,
        },
      },
      flats: {
        include: {
          customer: {
            include: {
              ledgerEntries: {
                select: { amount: true, direction: true },
              },
            },
          },
        },
        orderBy: { flatNumber: 'asc' },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { floorNumber: 'asc' }],
  })

  const responseData = {
    floors: floors.map((floor) => ({
      id: floor.id,
      floorNumber: floor.floorNumber,
      floorName: floor.floorName,
      wingId: floor.wingId,
      wingName: floor.wing?.name ?? null,
      flats: floor.flats.map((flat) => ({
        id: flat.id,
        flatNumber: flat.flatNumber,
        customFlatId: flat.customFlatId,
        unitType: flat.unitType,
        status: flat.status,
        flatType: flat.flatType,
        customer: flat.customer
          ? (() => {
              const amountPaid = sumDirectionalLedgerAmounts(flat.customer.ledgerEntries)

              return {
                id: flat.customer.id,
                name: flat.customer.name,
                phone: flat.customer.phone,
                email: flat.customer.email,
                sellingPrice: flat.customer.sellingPrice,
                bookingAmount: flat.customer.bookingAmount,
                amountPaid,
                remaining: flat.customer.sellingPrice - amountPaid,
                customerType: flat.customer.customerType,
                createdAt: flat.customer.createdAt.toISOString(),
              }
            })()
          : null,
      })),
    })),
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return responseData
}

export async function updateFlatForUser(
  siteId: string,
  floorId: string,
  flatId: string,
  userId: string,
  status: 'AVAILABLE' | 'BOOKED' | 'SOLD',
) {
  const { site } = await getSiteForUser(siteId, userId)
  if (!site) return null

  const flat = await prisma.flat.findFirst({
    where: { id: flatId, floorId, siteId: site.id },
  })
  if (!flat) return { error: 'Flat not found', status: 404 as const }

  const updated = await prisma.flat.update({
    where: { id: flatId },
    data: { status },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(site.companyId)

  return updated
}

export async function updateFloorForUser(
  siteId: string,
  floorId: string,
  userId: string,
  data: { floorName: string; wingId?: string },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const floor = await prisma.floor.findFirst({
    where: { id: floorId, siteId: site.id },
  })
  if (!floor) return { error: 'Floor not found', status: 404 as const }

  const requestedWingId = data.wingId?.trim() || null
  if (requestedWingId) {
    const wing = await prisma.wing.findFirst({
      where: { id: requestedWingId, siteId: site.id },
    })
    if (!wing) return { error: 'Wing not found', status: 404 as const }
  }

  const shouldReindexFloorNumber = floor.wingId !== requestedWingId
  const nextFloorNumber = shouldReindexFloorNumber
    ? (await prisma.floor.count({
        where: {
          siteId: site.id,
          wingId: requestedWingId,
        },
      })) + 1
    : floor.floorNumber

  const updated = await prisma.floor.update({
    where: { id: floor.id },
    data: {
      floorName: data.floorName,
      wingId: requestedWingId,
      floorNumber: nextFloorNumber,
    },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(company.id)

  return updated
}

export async function deleteFloorForUser(siteId: string, floorId: string, userId: string) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const floor = await prisma.floor.findFirst({
    where: { id: floorId, siteId: site.id },
    include: {
      _count: {
        select: { flats: true },
      },
    },
  })
  if (!floor) return { error: 'Floor not found', status: 404 as const }

  if (floor._count.flats > 0) {
    return {
      error: 'Cannot delete this floor because it still contains flats',
      status: 400 as const,
    }
  }

  await prisma.floor.delete({
    where: { id: floor.id },
  })

  await syncSiteStructureCounts(site.id)
  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(company.id)

  return { id: floor.id }
}

export async function updateFlatDetailsForUser(
  siteId: string,
  flatId: string,
  userId: string,
  data: { customFlatId: string; unitType?: string; floorId?: string; flatType?: 'CUSTOMER' | 'EXISTING_OWNER' },
) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const flat = await prisma.flat.findFirst({
    where: { id: flatId, siteId: site.id },
    include: {
      customer: {
        select: { id: true },
      },
    },
  })
  if (!flat) return { error: 'Flat not found', status: 404 as const }

  const existing = await prisma.flat.findFirst({
    where: {
      siteId: site.id,
      customFlatId: data.customFlatId,
      id: { not: flat.id },
    },
  })
  if (existing) return { error: 'Flat ID already exists in this site', status: 400 as const }

  let nextFloorId = flat.floorId

  if (data.floorId && data.floorId !== flat.floorId) {
    const targetFloor = await prisma.floor.findFirst({
      where: { id: data.floorId, siteId: site.id },
      select: { id: true },
    })

    if (!targetFloor) return { error: 'Target floor not found', status: 404 as const }
    nextFloorId = targetFloor.id
  }

  const requestedFlatType = data.flatType ?? flat.flatType ?? 'CUSTOMER'
  const flatType = site.projectType === 'NEW_CONSTRUCTION'
    ? 'CUSTOMER'
    : requestedFlatType

  const updated = await prisma.flat.update({
    where: { id: flat.id },
    data: {
      customFlatId: data.customFlatId,
      floorId: nextFloorId,
      unitType: data.unitType?.trim() || flat.unitType,
      flatType,
    },
  })

  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(company.id)

  return updated
}

export async function deleteFlatForUser(siteId: string, flatId: string, userId: string) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const flat = await prisma.flat.findFirst({
    where: { id: flatId, siteId: site.id },
    include: {
      customer: {
        select: { id: true },
      },
    },
  })
  if (!flat) return { error: 'Flat not found', status: 404 as const }

  if (flat.customer) {
    return {
      error: 'Cannot delete this flat because it is linked to an existing customer',
      status: 400 as const,
    }
  }

  if (flat.status !== 'AVAILABLE') {
    return {
      error: 'Cannot delete this flat because only available, unassigned flats can be removed',
      status: 400 as const,
    }
  }

  await prisma.flat.delete({
    where: { id: flat.id },
  })

  await syncSiteStructureCounts(site.id)
  await cacheService.del(CacheKeys.siteFloors(site.id))
  await cacheService.del(CacheKeys.siteDetail(site.id))
  await invalidateSiteListCaches(company.id)

  return { id: flat.id }
}
