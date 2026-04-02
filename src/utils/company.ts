import { prisma } from '../db/prisma.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export async function getCompanyForUser(userId: string) {
  const cached = await cacheService.get<{ id: string; createdBy: string; name: string; address: string | null; createdAt: string }>(CacheKeys.companyByUser(userId))
  if (cached) return cached

  const company = await prisma.company.findUnique({ where: { createdBy: userId } })
  if (company) {
    await cacheService.set(CacheKeys.companyByUser(userId), company, CacheTTL.COMPANY_FOR_USER)
  }
  return company
}
