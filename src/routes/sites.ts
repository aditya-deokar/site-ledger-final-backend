import { Prisma } from '@prisma/client'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyForUser } from '../utils/company.js'
import { generateUniqueSlug } from '../utils/slug.js'
import {
  getSitePartnerAllocatedFund,
  getSiteEquityInvestorFund,
  getSiteAllocatedFund,
  getSiteTotalExpenses,
  getSiteTotalExpensesBilled,
  getSiteCustomerPayments,
  getSiteRemainingFund,
  getCompanyAvailableFund,
  getSiteLedgerBalance,
} from '../utils/ledger-fund.js'
import {
  deriveExpensePaymentStatus,
  getExpensePaidTotal,
  getExpenseRemaining,
  getSiteLedgerNetCash,
  mapExpenseLedgerFields,
} from '../services/expense-ledger.service.js'
import { sumLedgerAmounts } from '../services/customer-ledger.service.js'
import { calculateInvestorLedgerTotals } from '../services/investor-ledger.service.js'
import { LedgerError, createLedgerEntry, createTransferEntries } from '../services/ledger.service.js'
import { invalidateSiteFundCaches, invalidateExpenseCaches, invalidateSiteListCaches, invalidateVendorCaches } from '../services/cache-invalidation.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const siteRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()
const LEDGER_TX_OPTIONS = { maxWait: 15000, timeout: 20000 } as const

siteRoutes.use('*', requireJwt)

// ── Schemas ──────────────────────────────────────────

const createSiteSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  projectType: z.enum(['NEW_CONSTRUCTION', 'REDEVELOPMENT']).optional().default('NEW_CONSTRUCTION'),
  totalFloors: z.number().int().min(1).optional(),
  totalFlats: z.number().int().min(1).optional(),
})

const createFloorSchema = z.object({
  floorName: z.string().min(1),
})

const createFlatSchema = z.object({
  customFlatId: z.string().min(1),
  flatType: z.enum(['CUSTOMER', 'EXISTING_OWNER']).optional().default('CUSTOMER'),
})

const allocateFundSchema = z.object({
  amount: z.number().positive(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})

const transferSchema = z.object({
  amount: z.number().positive(),
  direction: z.enum(['COMPANY_TO_SITE', 'SITE_TO_COMPANY']),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
})

const createExpenseSchema = z.object({
  type: z.enum(['GENERAL', 'VENDOR']),
  reason: z.string().optional(),
  vendorId: z.string().optional(),
  description: z.string().optional(),
  amount: z.number().positive(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
})

const updateFlatSchema = z.object({
  status: z.enum(['AVAILABLE', 'BOOKED', 'SOLD']),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

// ── Helper: verify site belongs to user's company ────

async function getSiteForUser(siteId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, site: null }

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId: company.id },
  })
  return { company, site }
}

async function performSiteTransfer(
  companyId: string,
  siteId: string,
  amount: number,
  direction: 'COMPANY_TO_SITE' | 'SITE_TO_COMPANY',
  note?: string,
  idempotencyKey?: string,
) {
  if (direction === 'COMPANY_TO_SITE') {
    const availableFund = await getCompanyAvailableFund(companyId)
    if (amount > availableFund) {
      throw new LedgerError('INSUFFICIENT_FUNDS')
    }
  } else {
    const siteBalance = await getSiteLedgerBalance(siteId)
    if (amount > siteBalance) {
      throw new LedgerError('INSUFFICIENT_FUNDS')
    }
  }

  const transfer = await prisma.$transaction(async (tx) => {
    return createTransferEntries({
      companyId,
      siteId,
      amount: new Prisma.Decimal(amount),
      direction,
      idempotencyKey,
      note,
    }, tx)
  }, LEDGER_TX_OPTIONS)

  await invalidateSiteFundCaches(companyId, siteId)

  const [companyAvailableFund, siteBalance, siteAllocatedFund] = await Promise.all([
    getCompanyAvailableFund(companyId),
    getSiteRemainingFund(siteId),
    getSiteAllocatedFund(siteId),
  ])

  return {
    transfer,
    companyAvailableFund,
    siteBalance,
    siteAllocatedFund,
  }
}

// ══════════════════════════════════════════════════════
// SITE CRUD
// ══════════════════════════════════════════════════════

// ── POST /sites ──────────────────────────────────────

const createSiteRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Sites'],
  summary: 'Create a new site',
  description: 'Create a construction site with name, address, floor count, and flat count. Floors and flats are auto-generated with flats distributed evenly across floors.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: createSiteSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              site: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string(),
                totalFloors: z.number().nullable(),
                totalFlats: z.number().nullable(),
                slug: z.string(),
                createdAt: z.string().datetime(),
              }),
            }),
          }),
        },
      },
      description: 'Site created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

siteRoutes.openapi(createSiteRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createSiteSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found. Create one first.', 404) as any

  const { name, address, projectType } = parsed.data
  const slug = await generateUniqueSlug(name)

  const site = await prisma.site.create({
    data: { companyId: company.id, name, address, projectType, slug, totalFloors: 0, totalFlats: 0 },
   })

  await invalidateSiteListCaches(company.id)

  return jsonOk(c, {
    site: {
      id: site.id,
      name: site.name,
      address: site.address,
      totalFloors: site.totalFloors,
      totalFlats: site.totalFlats,
      slug: site.slug,
      createdAt: site.createdAt,
    },
  }, 201) as any
})

// ── POST /sites/:id/floors ───────────────────────────

const createFloorRoute = createRoute({
  method: 'post',
  path: '/{id}/floors',
  tags: ['Floors & Flats'],
  summary: 'Add a floor to a site',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: createFloorSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              floor: z.object({
                id: z.string(),
                floorNumber: z.number(),
                floorName: z.string(),
              }),
            }),
          }),
        },
      },
      description: 'Floor created',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(createFloorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = createFloorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  // Get next floor number
  const lastFloor = await prisma.floor.findFirst({
    where: { siteId: site.id },
    orderBy: { floorNumber: 'desc' },
  })
  const nextFloorNumber = (lastFloor?.floorNumber ?? 0) + 1

  const floor = await prisma.floor.create({
    data: {
      siteId: site.id,
      floorNumber: nextFloorNumber,
      floorName: parsed.data.floorName,
    },
  })

  // Update site totalFloors count
   await prisma.site.update({
     where: { id: site.id },
     data: { totalFloors: { increment: 1 } },
   })
 
   await cacheService.del(CacheKeys.siteFloors(site.id))
   await invalidateSiteListCaches(company.id)

  return jsonOk(c, {
    floor: {
      id: floor.id,
      floorNumber: floor.floorNumber,
      floorName: floor.floorName,
    },
  }, 201) as any
})

// ── POST /sites/:id/floors/:floorId/flats ───────────

const createFlatRoute = createRoute({
  method: 'post',
  path: '/{id}/floors/{floorId}/flats',
  tags: ['Floors & Flats'],
  summary: 'Add a flat to a floor',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), floorId: z.string() }),
    body: {
      content: { 'application/json': { schema: createFlatSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              flat: z.object({
                id: z.string(),
                customFlatId: z.string(),
                status: z.string(),
              }),
            }),
          }),
        },
      },
      description: 'Flat created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Duplicate Flat ID or bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site or Floor not found',
    },
  },
})

siteRoutes.openapi(createFlatRoute, async (c) => {
  const auth = c.get('auth')
  const { id, floorId } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = createFlatSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  // Enforce flat type rules based on the site's project type.
  const requestedFlatType = parsed.data.flatType ?? 'CUSTOMER'
  const flatType = site.projectType === 'NEW_CONSTRUCTION' ? 'CUSTOMER' : requestedFlatType

  const floor = await prisma.floor.findFirst({
    where: { id: floorId, siteId: site.id },
  })
  if (!floor) return jsonError(c, 'Floor not found', 404) as any

  // Check for duplicate customFlatId in the same site
  const existing = await prisma.flat.findFirst({
    where: { siteId: site.id, customFlatId: parsed.data.customFlatId },
  })
  if (existing) return jsonError(c, 'Flat ID already exists in this site', 400) as any

  const flat = await prisma.flat.create({
    data: {
      siteId: site.id,
      floorId: floor.id,
      customFlatId: parsed.data.customFlatId,
      flatType,
      status: 'AVAILABLE',
    },
  })

  // Update site totalFlats count
   await prisma.site.update({
     where: { id: site.id },
     data: { totalFlats: { increment: 1 } },
   })
 
   await cacheService.del(CacheKeys.siteFloors(site.id))
   await invalidateSiteListCaches(company.id)

  return jsonOk(c, {
    flat: {
      id: flat.id,
      customFlatId: flat.customFlatId,
      status: flat.status,
    },
  }, 201) as any
})

// ── GET /sites ───────────────────────────────────────

const getSitesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Sites'],
  summary: 'List all sites',
  description: 'Returns sites for the company. By default returns only active sites. Pass `showArchived=true` to include archived sites, or `showArchived=only` to list only archived sites. Each site includes a fund breakdown: `partnerAllocatedFund`, `investorAllocatedFund`, `allocatedFund`, `totalExpenses`, `customerPayments`, `remainingFund`, and `isActive`.',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      showArchived: z.enum(['true', 'false', 'only']).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              sites: z.array(z.object({
                id: z.string(),
                name: z.string(),
                address: z.string(),
                projectType: z.string(),
                totalFloors: z.number(),
                totalFlats: z.number(),
                slug: z.string(),
                isActive: z.boolean(),
                partnerAllocatedFund: z.number(),
                investorAllocatedFund: z.number(),
                allocatedFund: z.number(),
                totalExpenses: z.number(),
                customerPayments: z.number(),
                remainingFund: z.number(),
                createdAt: z.string().datetime(),
              })),
            }),
          }),
        },
      },
      description: 'List of sites',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

siteRoutes.openapi(getSitesRoute, async (c) => {
  const auth = c.get('auth')
  const company = await getCompanyForUser(auth.userId)
  if (!company) return jsonError(c, 'No company found. Create one first.', 404) as any

  const { showArchived } = c.req.valid('query')

  // Cache the entire site list response per company + filter
  const cacheKey = `${CacheKeys.siteList(company.id)}:${showArchived ?? 'default'}`
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  let isActiveFilter: boolean | undefined
  if (showArchived === 'only') isActiveFilter = false
  else if (showArchived === 'true') isActiveFilter = undefined // all
  else isActiveFilter = true // default: active only

  const sites = await prisma.site.findMany({
    where: {
      companyId: company.id,
      ...(isActiveFilter !== undefined ? { isActive: isActiveFilter } : {}),
    },
    include: {
      floors: { select: { flats: { select: { status: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const siteSummaries = await Promise.all(
    sites.map(async (s) => {
      const [partnerAllocatedFund, investorAllocatedFund, totalExpenses, customerPayments, remainingFund] = await Promise.all([
        getSitePartnerAllocatedFund(s.id),
        getSiteEquityInvestorFund(s.id),
        getSiteTotalExpenses(s.id),
        getSiteCustomerPayments(s.id),
        getSiteRemainingFund(s.id),
      ])

      const allocatedFund = partnerAllocatedFund + investorAllocatedFund
      const flatsSummary = { available: 0, booked: 0, sold: 0 }
      for (const floor of s.floors) {
        for (const f of floor.flats) {
          if (f.status === 'AVAILABLE') flatsSummary.available++
          else if (f.status === 'BOOKED') flatsSummary.booked++
          else if (f.status === 'SOLD') flatsSummary.sold++
        }
      }
      return {
        id: s.id,
        name: s.name,
        address: s.address,
        projectType: s.projectType,
        totalFloors: s.totalFloors,
        totalFlats: s.totalFlats,
        slug: s.slug,
        isActive: s.isActive,
        partnerAllocatedFund,
        investorAllocatedFund,
        allocatedFund,
        totalExpenses,
        customerPayments,
        remainingFund,
        flatsSummary,
        createdAt: s.createdAt,
      }
    }),
  )

  const responseData = {
    sites: siteSummaries,
  }

  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_LIST)

  return jsonOk(c, responseData) as any
})

// ── GET /sites/:id ───────────────────────────────────

const getSiteRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Sites'],
  summary: 'Get site details',
  description: 'Returns full site details with fund breakdown (`partnerAllocatedFund`, `investorAllocatedFund`, `allocatedFund`, `totalExpenses`, `customerPayments`, `remainingFund`) and flat status summary (available/booked/sold count).',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              site: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string(),
                projectType: z.string(),
                totalFloors: z.number(),
                totalFlats: z.number(),
                slug: z.string(),
                isActive: z.boolean(),
                partnerAllocatedFund: z.number(),
                investorAllocatedFund: z.number(),
                allocatedFund: z.number(),
                totalExpenses: z.number(),
                customerPayments: z.number(),
                remainingFund: z.number(),
                totalProfit: z.number(),
                flatsSummary: z.object({
                  available: z.number(),
                  booked: z.number(),
                  sold: z.number(),
                  customerFlats: z.number(),
                  ownerFlats: z.number(),
                }),
                createdAt: z.string().datetime(),
              }),
            }),
          }),
        },
      },
      description: 'Site details',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getSiteRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.siteDetail(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const [partnerAllocatedFund, investorAllocatedFund, totalExpenses, totalExpensesBilled, customerPayments, remainingFund, flatCounts, customerFlatsCount, ownerFlatsCount, totalRevenueResult] = await Promise.all([
    getSitePartnerAllocatedFund(site.id),
    getSiteEquityInvestorFund(site.id),
    getSiteTotalExpenses(site.id),
    getSiteTotalExpensesBilled(site.id),
    getSiteCustomerPayments(site.id),
    getSiteRemainingFund(site.id),
    prisma.flat.groupBy({
      by: ['status'],
      where: { siteId: site.id },
      _count: true,
    }),
    prisma.flat.count({ where: { siteId: site.id, flatType: 'CUSTOMER' } }),
    prisma.flat.count({ where: { siteId: site.id, flatType: 'EXISTING_OWNER' } }),
    prisma.customer.aggregate({
      where: { siteId: site.id, isDeleted: false },
      _sum: { sellingPrice: true },
    }),
  ])
  const totalRevenue = totalRevenueResult._sum.sellingPrice ?? 0
  const totalProfit = totalRevenue - totalExpensesBilled

  const allocatedFund = partnerAllocatedFund + investorAllocatedFund
  const flatsSummary = { available: 0, booked: 0, sold: 0, customerFlats: 0, ownerFlats: 0 }
  for (const fc of flatCounts) {
    if (fc.status === 'AVAILABLE') flatsSummary.available = fc._count
    else if (fc.status === 'BOOKED') flatsSummary.booked = fc._count
    else if (fc.status === 'SOLD') flatsSummary.sold = fc._count
  }
  flatsSummary.customerFlats = customerFlatsCount
  flatsSummary.ownerFlats = ownerFlatsCount

  const responseData = {
    site: {
      id: site.id,
      name: site.name,
      address: site.address,
      projectType: site.projectType,
      totalFloors: site.totalFloors,
      totalFlats: site.totalFlats,
      slug: site.slug,
      isActive: site.isActive,
      partnerAllocatedFund,
      investorAllocatedFund,
      allocatedFund,
      totalExpenses,           // actual cash paid out
      totalExpensesBilled,     // total invoiced
      customerPayments,
      remainingFund,
      totalRevenue,            // sum of selling prices
      totalProfit,             // revenue - expenses (real profit)
      flatsSummary,
      createdAt: site.createdAt,
    },
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_DETAIL)
  return jsonOk(c, responseData) as any
})

// ══════════════════════════════════════════════════════
// ARCHIVE / DELETE
// ══════════════════════════════════════════════════════

// ── PATCH /sites/:id/toggle ──────────────────────────

const toggleSiteRoute = createRoute({
  method: 'patch',
  path: '/{id}/toggle',
  tags: ['Sites'],
  summary: 'Archive or restore a site',
  description: 'Toggles the site `isActive` flag. Active → archived, archived → active. Archived sites are hidden from the default site list.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              id: z.string(),
              name: z.string(),
              isActive: z.boolean(),
              message: z.string(),
            }),
          }),
        },
      },
      description: 'Site archived or restored',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(toggleSiteRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { isActive: !site.isActive },
  })

  await invalidateSiteListCaches(company.id)

  return jsonOk(c, {
    id: updated.id,
    name: updated.name,
    isActive: updated.isActive,
    message: updated.isActive ? `Site "${updated.name}" restored` : `Site "${updated.name}" archived`,
  }) as any
})

// ── DELETE /sites/:id ────────────────────────────────

const deleteSiteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Sites'],
  summary: 'Permanently delete a site',
  description: 'Permanently deletes the site and all associated data (floors, flats, funds, expenses). Vendors are NOT affected (they are company-level). Pass `keepCustomers=true` to preserve customer financial records; otherwise customers are deleted with the site.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      keepCustomers: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ message: z.string() }),
          }),
        },
      },
      description: 'Site deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(deleteSiteRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { keepCustomers } = c.req.valid('query')
  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  if (keepCustomers === 'true') {
    // Detach customers from the flat/site before deleting so their records are preserved
    await prisma.customer.updateMany({
      where: { siteId: site.id },
      data: { flatId: null, siteId: null },
    })
  }

  await prisma.site.delete({ where: { id: site.id } })

  await invalidateSiteListCaches(company.id)

  return jsonOk(c, { message: `Site "${site.name}" permanently deleted` }) as any
})

// ══════════════════════════════════════════════════════
// FUND
// ══════════════════════════════════════════════════════

// ── POST /sites/:id/fund ─────────────────────────────

const allocateFundRoute = createRoute({
  method: 'post',
  path: '/{id}/fund',
  tags: ['Site Fund'],
  summary: 'Allocate fund to site',
  description: 'Transfer funds from company available fund to a site. Fails if the requested amount exceeds company available fund. Uses a transaction to prevent race conditions.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: allocateFundSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              allocation: z.object({ id: z.string(), amount: z.number(), createdAt: z.string().datetime() }),
              companyAvailableFund: z.number(),
              siteAllocatedFund: z.number(),
            }),
          }),
        },
      },
      description: 'Fund allocated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Insufficient funds or bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(allocateFundRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = allocateFundSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  const result = await performSiteTransfer(
    company.id,
    site.id,
    parsed.data.amount,
    'COMPANY_TO_SITE',
    parsed.data.note || 'Fund allocation',
    parsed.data.idempotencyKey,
  ).catch((err: any) => {
    if (err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS') {
      return { error: err.code, status: 400 }
    }
    throw err
  })

  if ('error' in result) {
    return jsonError(c, result.error, result.status) as any
  }

  return jsonOk(c, {
    allocation: {
      id: result.transfer.companyEntry.id,
      amount: Number(result.transfer.companyEntry.amount),
      createdAt: result.transfer.companyEntry.postedAt,
    },
    companyAvailableFund: result.companyAvailableFund,
    siteAllocatedFund: result.siteAllocatedFund,
  }, 201) as any
})

// ── POST /sites/:id/withdraw ─────────────────────────

const withdrawFundRoute = createRoute({
  method: 'post',
  path: '/{id}/withdraw',
  tags: ['Site Fund'],
  summary: 'Withdraw fund from site to company',
  description: 'Pull unspent money back from a site into the company wallet by posting a ledger transfer. Fails if the requested amount exceeds the current site balance.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: allocateFundSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              withdrawal: z.object({ id: z.string(), amount: z.number(), createdAt: z.string().datetime() }),
              siteRemainingFund: z.number(),
              companyAvailableFund: z.number(),
            }),
          }),
        },
      },
      description: 'Funds withdrawn from site back to company',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Insufficient site remaining fund or bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(withdrawFundRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = allocateFundSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  const result = await performSiteTransfer(
    company.id,
    site.id,
    parsed.data.amount,
    'SITE_TO_COMPANY',
    parsed.data.note || 'Fund withdrawal',
    parsed.data.idempotencyKey,
  ).catch((err: any) => {
    if (err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS') {
      return { error: err.code, status: 400 }
    }
    throw err
  })

  if ('error' in result) {
    return jsonError(c, result.error, result.status) as any
  }

  return jsonOk(c, {
    withdrawal: {
      id: result.transfer.siteEntry.id,
      amount: Number(result.transfer.siteEntry.amount),
      createdAt: result.transfer.siteEntry.postedAt,
    },
    siteRemainingFund: result.siteBalance,
    companyAvailableFund: result.companyAvailableFund,
  }) as any
})

// ── GET /sites/:id/fund ──────────────────────────────

const siteTransferRoute = createRoute({
  method: 'post',
  path: '/{id}/transfer',
  tags: ['Site Fund'],
  summary: 'Transfer money between company and site wallets',
  description: 'Creates paired ledger entries for company-to-site or site-to-company transfers.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: transferSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              transfer: z.object({
                entryGroupId: z.string(),
                direction: z.enum(['COMPANY_TO_SITE', 'SITE_TO_COMPANY']),
                amount: z.number(),
                companyEntryId: z.string(),
                siteEntryId: z.string(),
              }),
              companyAvailableFund: z.number(),
              siteBalance: z.number(),
              siteAllocatedFund: z.number(),
            }),
          }),
        },
      },
      description: 'Transfer completed',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Insufficient balance or invalid request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(siteTransferRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = transferSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  const result = await performSiteTransfer(
    company.id,
    site.id,
    parsed.data.amount,
    parsed.data.direction,
    parsed.data.note,
    parsed.data.idempotencyKey,
  ).catch((err: any) => {
    if (err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS') {
      return { error: err.code, status: 400 }
    }
    throw err
  })

  if ('error' in result) {
    return jsonError(c, result.error, result.status) as any
  }

  return jsonOk(c, {
    transfer: {
      entryGroupId: result.transfer.entryGroupId,
      direction: parsed.data.direction,
      amount: parsed.data.amount,
      companyEntryId: result.transfer.companyEntry.id,
      siteEntryId: result.transfer.siteEntry.id,
    },
    companyAvailableFund: result.companyAvailableFund,
    siteBalance: result.siteBalance,
    siteAllocatedFund: result.siteAllocatedFund,
  }) as any
})

const getSiteFundRoute = createRoute({
  method: 'get',
  path: '/{id}/fund',
  tags: ['Site Fund'],
  summary: 'Get site fund details',
  description: 'Returns the site\'s allocated fund, total expenses, remaining fund, and a history of all fund allocations.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              allocatedFund: z.number(),
              totalExpenses: z.number(),
              customerPayments: z.number(),
              remainingFund: z.number(),
              allocations: z.array(z.object({
                id: z.string(),
                amount: z.number(),
                note: z.string().nullable(),
                createdAt: z.string().datetime(),
              })),
            }),
          }),
        },
      },
      description: 'Site fund details',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getSiteFundRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.siteFundHistory(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const [allocatedFund, totalExpenses, customerPayments, allocations, remainingFund] = await Promise.all([
    getSiteAllocatedFund(site.id),
    getSiteTotalExpenses(site.id),
    getSiteCustomerPayments(site.id),
    prisma.payment.findMany({
      where: {
        companyId: site.companyId,
        siteId: site.id,
        walletType: 'SITE',
        movementType: { in: ['COMPANY_TO_SITE_TRANSFER', 'SITE_TO_COMPANY_TRANSFER'] },
      },
      orderBy: { postedAt: 'desc' },
    }),
    getSiteRemainingFund(site.id),
  ])

  const responseData = {
    allocatedFund,
    totalExpenses,
    customerPayments,
    remainingFund,
    allocations: allocations.map((a) => ({
      id: a.id,
      amount: a.direction === 'IN' ? Number(a.amount) : -Number(a.amount),
      note: a.note,
      createdAt: a.postedAt,
    })),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_DETAIL)
  return jsonOk(c, responseData) as any
})

// ── GET /sites/:id/fund-history ─────────────────────

const getSiteFundHistoryRoute = createRoute({
  method: 'get',
  path: '/{id}/fund-history',
  tags: ['Site Fund'],
  summary: 'Get site fund ledger history',
  description: 'Returns bidirectional fund ledger entries (allocation/withdrawal) with running balance.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              history: z.array(z.object({
                id: z.string(),
                type: z.enum(['ALLOCATION', 'WITHDRAWAL']),
                amount: z.number(),
                note: z.string().nullable(),
                runningBalance: z.number(),
                createdAt: z.string().datetime(),
              })),
            }),
          }),
        },
      },
      description: 'Fund ledger history',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getSiteFundHistoryRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const entries = await prisma.payment.findMany({
    where: {
      companyId: site.companyId,
      siteId: site.id,
      walletType: 'SITE',
      movementType: { in: ['COMPANY_TO_SITE_TRANSFER', 'SITE_TO_COMPANY_TRANSFER'] },
    },
    orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
  })

  let runningBalance = 0
  const historyAsc = entries.map((entry) => {
    const signedAmount = entry.direction === 'IN' ? Number(entry.amount) : -Number(entry.amount)
    runningBalance += signedAmount
    return {
      id: entry.id,
      type: entry.direction === 'IN' ? 'ALLOCATION' as const : 'WITHDRAWAL' as const,
      amount: Number(entry.amount),
      note: entry.note,
      runningBalance,
      createdAt: entry.postedAt,
    }
  })

  return jsonOk(c, { history: historyAsc.reverse() }) as any
})

// ══════════════════════════════════════════════════════
// EXPENSES
// ══════════════════════════════════════════════════════

// ── GET /sites/:id/expenses ──────────────────────────

const getExpensesRoute = createRoute({
  method: 'get',
  path: '/{id}/expenses',
  tags: ['Expenses'],
  summary: 'List site expenses',
  description: 'Returns all expenses for a site, including vendor name and type for vendor-linked expenses.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              expenses: z.array(z.object({
                id: z.string(),
                type: z.string(),
                reason: z.string().nullable(),
                vendorId: z.string().nullable(),
                vendorName: z.string().nullable(),
                vendorType: z.string().nullable(),
                description: z.string().nullable(),
                amount: z.number(),
                amountPaid: z.number(),
                remaining: z.number(),
                paymentDate: z.string().datetime().nullable(),
                paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
                createdAt: z.string().datetime(),
              })),
            }),
          }),
        },
      },
      description: 'List of expenses',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getExpensesRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.siteExpenseList(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const expenses = await prisma.expense.findMany({
    where: { siteId: site.id, isDeleted: false },
    include: {
      vendor: { select: { id: true, name: true, type: true } },
      ledgerEntries: {
        select: { amount: true, postedAt: true },
        orderBy: { postedAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    expenses: expenses.map((e) => {
      const ledger = mapExpenseLedgerFields(e.amount, e.ledgerEntries)
      return {
        id: e.id,
        type: e.type,
        reason: e.reason,
        vendorId: e.vendorId,
        vendorName: e.vendor?.name ?? null,
        vendorType: e.vendor?.type ?? null,
        description: e.description,
        amount: e.amount,
        amountPaid: ledger.amountPaid,
        remaining: ledger.remaining,
        paymentDate: ledger.paymentDate,
        paymentStatus: ledger.paymentStatus,
        createdAt: e.createdAt.toISOString(),
      }
    }),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── GET /sites/:id/expenses/summary ──────────────────

const getExpensesSummaryRoute = createRoute({
  method: 'get',
  path: '/{id}/expenses/summary',
  tags: ['Expenses'],
  summary: 'Get expense summary',
  description: 'Returns aggregated expense data: total expenses and breakdown by type (GENERAL vs VENDOR).',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              totalExpenses: z.number(),
              breakdown: z.array(z.object({
                type: z.string(),
                total: z.number(),
              })),
            }),
          }),
        },
      },
      description: 'Expense summary',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getExpensesSummaryRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.siteExpenseSummary(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const [totalExpenses, breakdown] = await Promise.all([
    getSiteTotalExpenses(site.id),
    prisma.expense.groupBy({
      by: ['type'],
      where: { siteId: site.id },
      _sum: { amount: true },
    }),
  ])

  const responseData = {
    totalExpenses,
    breakdown: breakdown.map((b) => ({
      type: b.type,
      total: b._sum.amount ?? 0,
    })),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.SITE_DETAIL)
  return jsonOk(c, responseData) as any
})

// ── POST /sites/:id/expenses ─────────────────────────

const createExpenseRoute = createRoute({
  method: 'post',
  path: '/{id}/expenses',
  tags: ['Expenses'],
  summary: 'Add an expense',
  description: 'Record a general or vendor expense against a site. For VENDOR type, vendorId is required.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: createExpenseSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              expense: z.object({
                id: z.string(),
                type: z.string(),
                reason: z.string().nullable(),
                vendorId: z.string().nullable(),
                description: z.string().nullable(),
                amount: z.number(),
                amountPaid: z.number(),
                remaining: z.number(),
                paymentDate: z.string().datetime().nullable(),
                paymentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETED']),
                createdAt: z.string().datetime(),
              }),
              siteRemainingFund: z.number(),
            }),
          }),
        },
      },
      description: 'Expense added',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(createExpenseRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = createExpenseSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { company, site } = await getSiteForUser(id, auth.userId)
  if (!company || !site) return jsonError(c, 'Site not found', 404) as any

  const { type, reason, vendorId, description, amount, amountPaid = 0, idempotencyKey } = parsed.data

  // Validate vendor if type is VENDOR
  if (type === 'VENDOR') {
    if (!vendorId) return jsonError(c, 'vendorId is required for vendor expenses', 400) as any
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, companyId: company.id },
    })
    if (!vendor) return jsonError(c, 'Vendor not found', 404) as any
  }

  if (amountPaid > amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  const result = await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        siteId: site.id,
        type,
        reason: type === 'GENERAL' ? reason : null,
        vendorId: type === 'VENDOR' ? vendorId : null,
        description: type === 'VENDOR' ? description : null,
        amount,
      },
    })

    let paymentDate: string | null = null
    if (amountPaid > 0) {
      const payment = await createLedgerEntry({
        companyId: company.id,
        siteId: site.id,
        walletType: 'SITE',
        direction: 'OUT',
        movementType: 'EXPENSE_PAYMENT',
        amount: new Prisma.Decimal(amountPaid),
        idempotencyKey: idempotencyKey ?? `expense-create:${expense.id}:${Date.now()}`,
        note: 'Initial payment upon recording expense',
        expenseId: expense.id,
      }, tx)
      paymentDate = payment.postedAt.toISOString()
    }

    const paidTotal = await getExpensePaidTotal(expense.id, tx)
    const remaining = await getExpenseRemaining(expense.id, tx)
    const paymentStatus = deriveExpensePaymentStatus(paidTotal, expense.amount)
    const siteRemainingFund = await getSiteLedgerNetCash(site.id, tx)

    return { expense, paidTotal, remaining, paymentStatus, paymentDate, siteRemainingFund }
  }, LEDGER_TX_OPTIONS)

  const expense = result.expense

  await invalidateExpenseCaches(company.id, site.id)
  if (expense.vendorId) {
    await invalidateVendorCaches(company.id, expense.vendorId)
  }

  return jsonOk(c, {
    expense: {
      id: expense.id,
      type: expense.type,
      reason: expense.reason,
      vendorId: expense.vendorId,
      description: expense.description,
      amount: expense.amount,
      amountPaid: result.paidTotal,
      remaining: result.remaining,
      paymentDate: result.paymentDate,
      paymentStatus: result.paymentStatus,
      createdAt: expense.createdAt.toISOString(),
    },
    siteRemainingFund: result.siteRemainingFund,
  }, 201) as any
})

// ── PATCH /sites/:id/expenses/:expenseId/payment ────────

const updateExpensePaymentRoute = createRoute({
  method: 'patch',
  path: '/{id}/expenses/{expenseId}/payment',
  tags: ['Expenses'],
  summary: 'Record a payment against an expense (additive)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), expenseId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            amount: z.number().positive(),
            note: z.string().optional(),
            idempotencyKey: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              expense: z.object({ id: z.string(), amountPaid: z.number(), remaining: z.number(), paymentStatus: z.string() }),
              payment: z.object({ id: z.string(), amount: z.number(), createdAt: z.string().datetime() }),
            }),
          }),
        },
      },
      description: 'Payment recorded',
    },
    400: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Invalid payload' },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Expense not found' },
  },
})

siteRoutes.openapi(updateExpensePaymentRoute, async (c) => {
  const auth = c.get('auth')
  const { id, expenseId } = c.req.valid('param')
  const parsed = c.req.valid('json')
  
  const { site, company } = await getSiteForUser(id, auth.userId)
  if (!site || !company) return jsonError(c, 'Site not found', 404) as any

  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, siteId: site.id, isDeleted: false },
  })
  if (!expense) return jsonError(c, 'Expense not found', 404) as any

  const { amount, note, idempotencyKey } = parsed
  const currentPaid = await getExpensePaidTotal(expenseId)
  const newTotal = currentPaid + amount

  if (newTotal > expense.amount) {
    return jsonError(c, 'AMOUNT_EXCEEDS_LIMIT', 400) as any
  }

  const result = await prisma.$transaction(async (tx: any) => {
    const payment = await createLedgerEntry({
      companyId: company.id,
      siteId: site.id,
      walletType: 'SITE',
      direction: 'OUT',
      movementType: 'EXPENSE_PAYMENT',
      amount: new Prisma.Decimal(amount),
      idempotencyKey: idempotencyKey ?? `expense-payment:${expenseId}:${Date.now()}`,
      note: note || 'Payment for expense',
      expenseId,
    }, tx)

    const amountPaid = await getExpensePaidTotal(expenseId, tx)
    const remaining = await getExpenseRemaining(expenseId, tx)
    const paymentStatus = deriveExpensePaymentStatus(amountPaid, expense.amount)

    return { payment, amountPaid, remaining, paymentStatus }
  }, LEDGER_TX_OPTIONS)

  await invalidateExpenseCaches(company.id, site.id)
  if (expense.vendorId) {
    await invalidateVendorCaches(company.id, expense.vendorId)
  }

  return jsonOk(c, {
    expense: { id: expense.id, amountPaid: result.amountPaid, remaining: result.remaining, paymentStatus: result.paymentStatus },
    payment: { id: result.payment.id, amount: Number(result.payment.amount), createdAt: result.payment.postedAt },
  }) as any
})

// ── GET /sites/:id/expenses/:expenseId/payments ─────────

const getExpensePaymentsRoute = createRoute({
  method: 'get',
  path: '/{id}/expenses/{expenseId}/payments',
  tags: ['Payments'],
  summary: 'Get payment history for an expense',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), expenseId: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              payments: z.array(z.object({
                id: z.string(),
                amount: z.number(),
                note: z.string().nullable(),
                createdAt: z.string().datetime(),
              })),
            }),
          }),
        },
      },
      description: 'Payment history',
    },
    404: { content: { 'application/json': { schema: errorResponseSchema } }, description: 'Not found' },
  },
})

siteRoutes.openapi(getExpensePaymentsRoute, async (c) => {
  const auth = c.get('auth')
  const { id, expenseId } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const payments = await prisma.payment.findMany({
    where: { expenseId, siteId: site.id, companyId: site.companyId },
    orderBy: { postedAt: 'desc' },
  })

  return jsonOk(c, {
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      note: payment.note,
      createdAt: payment.postedAt,
    })),
  }) as any
})

// ── DELETE /sites/:id/expenses/:expenseId (soft delete) ─

const deleteExpenseRoute = createRoute({
  method: 'delete',
  path: '/{id}/expenses/{expenseId}',
  tags: ['Expenses'],
  summary: 'Soft-delete an expense',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), expenseId: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ message: z.string() }),
          }),
        },
      },
      description: 'Expense soft-deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Expense not found',
    },
  },
})

siteRoutes.openapi(deleteExpenseRoute, async (c) => {
  const auth = c.get('auth')
  const { id, expenseId } = c.req.valid('param')
  const { site, company } = await getSiteForUser(id, auth.userId)
  if (!site || !company) return jsonError(c, 'Site not found', 404) as any

  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, siteId: site.id, isDeleted: false },
  })
  if (!expense) return jsonError(c, 'Expense not found', 404) as any

  await prisma.expense.update({ where: { id: expenseId }, data: { isDeleted: true } })
  await invalidateExpenseCaches(company.id, site.id)
  if (expense.vendorId) {
    await invalidateVendorCaches(company.id, expense.vendorId)
  }

  return jsonOk(c, { message: 'Expense removed' }) as any
})

// ══════════════════════════════════════════════════════
// FLOORS & FLATS
// ══════════════════════════════════════════════════════

// ── GET /sites/:id/floors ────────────────────────────

const getFloorsRoute = createRoute({
  method: 'get',
  path: '/{id}/floors',
  tags: ['Floors & Flats'],
  summary: 'List floors with flats',
  description: 'Returns all floors of a site with their flats, flat statuses, and customer info for booked/sold flats.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              floors: z.array(z.object({
                id: z.string(),
                floorNumber: z.number(),
                floorName: z.string().nullable(),
                flats: z.array(z.object({
                  id: z.string(),
                  flatNumber: z.number().nullable(),
                  customFlatId: z.string().nullable(),
                  status: z.string(),
                  flatType: z.string(),
                  customer: z.object({
                    id: z.string(),
                    name: z.string(),
                    phone: z.string().nullable(),
                    sellingPrice: z.number(),
                    bookingAmount: z.number(),
                    amountPaid: z.number(),
                    remaining: z.number(),
                    customerType: z.string(),
                  }).nullable(),
                })),
              })),
            }),
          }),
        },
      },
      description: 'Floors with flats and customer info',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getFloorsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.siteFloors(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

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
    floors: floors.map((f) => ({
      id: f.id,
      floorNumber: f.floorNumber,
      floorName: f.floorName,
      flats: f.flats.map((fl) => ({
        id: fl.id,
        flatNumber: fl.flatNumber,
        customFlatId: fl.customFlatId,
        status: fl.status,
        flatType: fl.flatType,
        customer: fl.customer
          ? (() => {
              const amountPaid = sumLedgerAmounts(fl.customer.ledgerEntries)

              return {
                id: fl.customer.id,
                name: fl.customer.name,
                phone: fl.customer.phone,
                sellingPrice: fl.customer.sellingPrice,
                bookingAmount: fl.customer.bookingAmount,
                amountPaid,
                remaining: fl.customer.sellingPrice - amountPaid,
                customerType: fl.customer.customerType,
              }
            })()
          : null,
      })),
    })),
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

// ── PUT /sites/:id/floors/:floorId/flats/:flatId ────

const updateFlatRoute = createRoute({
  method: 'put',
  path: '/{id}/floors/{floorId}/flats/{flatId}',
  tags: ['Floors & Flats'],
  summary: 'Update flat status',
  description: 'Manually update a flat\'s status to AVAILABLE, BOOKED, or SOLD.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string(), floorId: z.string(), flatId: z.string() }),
    body: {
      content: { 'application/json': { schema: updateFlatSchema } },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              flat: z.object({
                id: z.string(),
                flatNumber: z.number().nullable(),
                customFlatId: z.string().nullable(),
                status: z.string(),
              }),
            }),
          }),
        },
      },
      description: 'Flat updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Bad request',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Flat not found',
    },
  },
})

siteRoutes.openapi(updateFlatRoute, async (c) => {
  const auth = c.get('auth')
  const { id, floorId, flatId } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = updateFlatSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const flat = await prisma.flat.findFirst({
    where: { id: flatId, floorId, siteId: site.id },
  })
  if (!flat) return jsonError(c, 'Flat not found', 404) as any

  const updated = await prisma.flat.update({
    where: { id: flatId },
    data: { status: parsed.data.status },
  })

  return jsonOk(c, {
    flat: {
      id: updated.id,
      flatNumber: updated.flatNumber,
      customFlatId: updated.customFlatId,
      status: updated.status,
    },
  }) as any
})

// ══════════════════════════════════════════════════════
// SITE INVESTORS
// ══════════════════════════════════════════════════════

// ── GET /sites/:id/investors ─────────────────────────

const getSiteInvestorsRoute = createRoute({
  method: 'get',
  path: '/{id}/investors',
  tags: ['Investors'],
  summary: 'List site equity investors',
  description: 'Returns all equity investors linked to this site with their total invested amount and transaction history.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              investors: z.array(z.object({
                id: z.string(),
                name: z.string(),
                phone: z.string().nullable(),
                equityPercentage: z.number().nullable(),
                totalInvested: z.number(),
                totalReturned: z.number(),
                createdAt: z.string().datetime(),
              })),
              totalInvested: z.number(),
            }),
          }),
        },
      },
      description: 'Site equity investors',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getSiteInvestorsRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const { site } = await getSiteForUser(id, auth.userId)
  if (!site) return jsonError(c, 'Site not found', 404) as any

  const cacheKey = CacheKeys.siteInvestors(site.id)
  const cached = await cacheService.get<any>(cacheKey)
  if (cached) return jsonOk(c, cached) as any

  const investors = await prisma.investor.findMany({
    where: { siteId: site.id, type: 'EQUITY', isDeleted: false },
    include: {
      transactions: {
        where: { isDeleted: false },
        select: {
          kind: true,
          ledgerEntries: {
            select: { amount: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const investorRows = investors.map((investor) => {
    const totals = calculateInvestorLedgerTotals(investor.transactions)

    return {
      id: investor.id,
      name: investor.name,
      phone: investor.phone,
      equityPercentage: investor.equityPercentage,
      totalInvested: totals.principalInTotal,
      totalReturned: totals.totalReturned,
      isClosed: investor.isClosed,
      createdAt: investor.createdAt,
    }
  })

  const totalInvested = investorRows.reduce((sum, investor) => sum + investor.totalInvested, 0)

  const responseData = {
    investors: investorRows,
    totalInvested,
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})

