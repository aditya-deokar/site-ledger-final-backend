import { prisma } from '../../db/prisma.js'
import { sumLedgerAmounts } from '../../services/customer-ledger.service.js'
import { invalidateSiteListCaches } from '../../services/cache-invalidation.js'
import { cacheService } from '../../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../../config/cache-keys.js'
import { getSiteForUser } from './site-access.service.js'

export async function createFloorForUser(siteId: string, userId: string, floorName: string) {
  const { company, site } = await getSiteForUser(siteId, userId)
  if (!company || !site) return null

  const lastFloor = await prisma.floor.findFirst({
    where: { siteId: site.id },
    orderBy: { floorNumber: 'desc' },
  })
  const nextFloorNumber = (lastFloor?.floorNumber ?? 0) + 1

  const floor = await prisma.floor.create({
    data: {
      siteId: site.id,
      floorNumber: nextFloorNumber,
      floorName,
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

export async function createFlatForUser(
  siteId: string,
  floorId: string,
  userId: string,
  data: { customFlatId: string; flatType?: 'CUSTOMER' | 'EXISTING_OWNER' },
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
      flats: {
        include: {
          customer: {
            include: {
              ledgerEntries: {
                select: { amount: true },
              },
            },
          },
        },
        orderBy: { flatNumber: 'asc' },
      },
    },
    orderBy: { floorNumber: 'asc' },
  })

  const responseData = {
    floors: floors.map((floor) => ({
      id: floor.id,
      floorNumber: floor.floorNumber,
      floorName: floor.floorName,
      flats: floor.flats.map((flat) => ({
        id: flat.id,
        flatNumber: flat.flatNumber,
        customFlatId: flat.customFlatId,
        status: flat.status,
        flatType: flat.flatType,
        customer: flat.customer
          ? (() => {
              const amountPaid = sumLedgerAmounts(flat.customer.ledgerEntries)

              return {
                id: flat.customer.id,
                name: flat.customer.name,
                phone: flat.customer.phone,
                sellingPrice: flat.customer.sellingPrice,
                bookingAmount: flat.customer.bookingAmount,
                amountPaid,
                remaining: flat.customer.sellingPrice - amountPaid,
                customerType: flat.customer.customerType,
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

  return updated
}
