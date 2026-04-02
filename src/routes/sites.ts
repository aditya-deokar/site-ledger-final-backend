import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getCompanyForUser } from '../utils/company.js'
import { generateUniqueSlug } from '../utils/slug.js'
import {
  getSitePartnerAllocatedFund,
  getSiteWithdrawnFund,
  getSiteEquityInvestorFund,
  getSiteEquityReturned,
  getSiteAllocatedFund,
  getSiteTotalExpenses,
  getSiteTotalExpensesBilled,
  getSiteCustomerPayments,
  getSiteRemainingFund,
} from '../utils/fund.js'
import { invalidateSiteFundCaches, invalidateExpenseCaches, invalidateSiteListCaches } from '../services/cache-invalidation.js'
import { cacheService } from '../services/cache.service.js'
import { CacheKeys, CacheTTL } from '../config/cache-keys.js'

export const siteRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

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
})

const createExpenseSchema = z.object({
  type: z.enum(['GENERAL', 'VENDOR']),
  reason: z.string().optional(),
  vendorId: z.string().optional(),
  description: z.string().optional(),
  amount: z.number().positive(),
  amountPaid: z.number().min(0).optional().default(0),
  paymentDate: z.string().datetime().optional(),
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
      funds: { select: { amount: true } },
      expenses: { select: { amount: true } },
      customers: { select: { amountPaid: true } },
      investors: { where: { type: 'EQUITY' }, select: { totalInvested: true, totalReturned: true } },
      floors: { select: { flats: { select: { status: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    sites: sites.map((s) => {
      const partnerAllocatedFund = s.funds.filter(f => f.amount > 0).reduce((sum, f) => sum + f.amount, 0)
      const withdrawn = s.funds.filter(f => f.amount < 0).reduce((sum, f) => sum + Math.abs(f.amount), 0)
      const investorAllocatedFund = s.investors.reduce((sum, i) => sum + i.totalInvested, 0)
      const equityReturned = s.investors.reduce((sum, i) => sum + i.totalReturned, 0)
      const allocatedFund = partnerAllocatedFund + investorAllocatedFund
      const totalExpenses = s.expenses.reduce((sum, e) => sum + e.amount, 0)
      const customerPayments = s.customers.reduce((sum, cu) => sum + cu.amountPaid, 0)
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
        remainingFund: allocatedFund - withdrawn - totalExpenses + customerPayments - equityReturned,
        flatsSummary,
        createdAt: s.createdAt,
      }
    }),
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

  const [partnerAllocatedFund, withdrawn, investorAllocatedFund, equityReturned, totalExpenses, totalExpensesBilled, customerPayments, flatCounts, customerFlatsCount, ownerFlatsCount, totalRevenueResult] = await Promise.all([
    getSitePartnerAllocatedFund(site.id),
    getSiteWithdrawnFund(site.id),
    getSiteEquityInvestorFund(site.id),
    getSiteEquityReturned(site.id),
    getSiteTotalExpenses(site.id),
    getSiteTotalExpensesBilled(site.id),
    getSiteCustomerPayments(site.id),
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
      remainingFund: allocatedFund - withdrawn - totalExpenses + customerPayments - equityReturned,
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

  // Use transaction to prevent race conditions
  const result = await prisma.$transaction(async (tx) => {
    // Compute available fund inside transaction (partners + fixed-rate investors - allocated to sites)
    const [partnerFundResult, fixedRateFundResult, allocatedResult] = await Promise.all([
      tx.partner.aggregate({ where: { companyId: company.id }, _sum: { investmentAmount: true } }),
      tx.investorTransaction.aggregate({ where: { investor: { companyId: company.id, type: 'FIXED_RATE' } }, _sum: { amount: true } }),
      tx.siteFund.aggregate({ where: { site: { companyId: company.id } }, _sum: { amount: true } }),
    ])
    const totalFund = (partnerFundResult._sum.investmentAmount ?? 0) + (fixedRateFundResult._sum.amount ?? 0)
    const totalAllocated = allocatedResult._sum.amount ?? 0
    const availableFund = totalFund - totalAllocated

    if (parsed.data.amount > availableFund) {
      throw new Error(`Insufficient company funds. Available: ${availableFund}`)
    }

    const allocation = await tx.siteFund.create({
      data: { siteId: site.id, amount: parsed.data.amount, note: parsed.data.note || 'Fund allocation' },
    })

    const siteAllocatedResult = await tx.siteFund.aggregate({
      where: { siteId: site.id },
      _sum: { amount: true },
    })

    return {
      allocation,
      companyAvailableFund: availableFund - parsed.data.amount,
      siteAllocatedFund: siteAllocatedResult._sum.amount ?? 0,
    }
  })

  await invalidateSiteFundCaches(company.id, site.id)

  return jsonOk(c, {
    allocation: {
      id: result.allocation.id,
      amount: result.allocation.amount,
      createdAt: result.allocation.createdAt,
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
  description: 'Pull unspent money back from a site into the company available fund. Creates a negative SiteFund entry. Fails if the requested amount exceeds the site remaining fund (allocated − expenses + customerPayments). Useful when a site project is complete and leftover funds should return to the company pool.',
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

  // Validate outside transaction to avoid timeout
  const remainingFund = await getSiteRemainingFund(site.id)
  if (parsed.data.amount > remainingFund) {
    return jsonError(c, `Insufficient site funds. Remaining: ${remainingFund}`, 400) as any
  }

  // Only the write inside the transaction
  const withdrawal = await prisma.siteFund.create({
    data: { siteId: site.id, amount: -parsed.data.amount, note: parsed.data.note || 'Fund withdrawal' },
  })

  await invalidateSiteFundCaches(company.id, site.id)

  // Recompute after withdrawal
  const { getCompanyAvailableFund } = await import('../utils/fund.js')
  const [newRemainingFund, companyAvailableFund] = await Promise.all([
    getSiteRemainingFund(site.id),
    getCompanyAvailableFund(company.id),
  ])

  return jsonOk(c, {
    withdrawal: {
      id: withdrawal.id,
      amount: withdrawal.amount,
      createdAt: withdrawal.createdAt,
    },
    siteRemainingFund: newRemainingFund,
    companyAvailableFund,
  }) as any
})

// ── GET /sites/:id/fund ──────────────────────────────

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

  const [allocatedFund, equityReturned, totalExpenses, customerPayments, allocations] = await Promise.all([
    getSiteAllocatedFund(site.id),
    getSiteEquityReturned(site.id),
    getSiteTotalExpenses(site.id),
    getSiteCustomerPayments(site.id),
    prisma.siteFund.findMany({
      where: { siteId: site.id },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const responseData = {
    allocatedFund,
    totalExpenses,
    customerPayments,
    remainingFund: allocatedFund - totalExpenses + customerPayments - equityReturned,
    allocations: allocations.map((a) => ({
      id: a.id,
      amount: a.amount,
      note: a.note,
      createdAt: a.createdAt,
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

  const entries = await prisma.siteFund.findMany({
    where: { siteId: site.id },
    orderBy: { createdAt: 'asc' },
  })

  let runningBalance = 0
  const historyAsc = entries.map((entry) => {
    runningBalance += entry.amount
    return {
      id: entry.id,
      type: entry.amount >= 0 ? 'ALLOCATION' as const : 'WITHDRAWAL' as const,
      amount: Math.abs(entry.amount),
      note: entry.note,
      runningBalance,
      createdAt: entry.createdAt,
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
    include: { vendor: { select: { id: true, name: true, type: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const responseData = {
    expenses: expenses.map((e) => ({
      id: e.id,
      type: e.type,
      reason: e.reason,
      vendorId: e.vendorId,
      vendorName: e.vendor?.name ?? null,
      vendorType: e.vendor?.type ?? null,
      description: e.description,
      amount: e.amount,
      amountPaid: e.amountPaid,
      paymentDate: e.paymentDate ? e.paymentDate.toISOString() : null,
      paymentStatus: e.paymentStatus,
      createdAt: e.createdAt.toISOString(),
    })),
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
  description: 'Record a general or vendor expense against a site. For VENDOR type, vendorId is required. Fails if amount exceeds site remaining fund.',
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
      description: 'Insufficient funds or bad request',
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

  const { type, reason, vendorId, description, amount, amountPaid = 0, paymentDate } = parsed.data

  // Validate vendor if type is VENDOR
  if (type === 'VENDOR') {
    if (!vendorId) return jsonError(c, 'vendorId is required for vendor expenses', 400) as any
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, companyId: company.id },
    })
    if (!vendor) return jsonError(c, 'Vendor not found', 404) as any
  }

  // Check site has enough remaining fund
  const remaining = await getSiteRemainingFund(site.id)
  if (amount > remaining) {
    return jsonError(c, `Insufficient site funds. Remaining: ${remaining}`, 400) as any
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
        amountPaid,
        paymentDate: paymentDate ? new Date(paymentDate) : (amountPaid > 0 ? new Date() : null),
        paymentStatus: amountPaid >= amount ? 'COMPLETED' : amountPaid > 0 ? 'PARTIAL' : 'PENDING',
      },
    })

    if (amountPaid > 0) {
      await tx.payment.create({
        data: {
          companyId: company.id,
          siteId: site.id,
          entityType: 'EXPENSE',
          entityId: expense.id,
          amount: amountPaid,
          note: 'Initial payment upon recording expense',
        },
      })
    }
    return expense
  })

  const expense = result;

  await invalidateExpenseCaches(company.id, site.id)

  return jsonOk(c, {
    expense: {
      id: expense.id,
      type: expense.type,
      reason: expense.reason,
      vendorId: expense.vendorId,
      description: expense.description,
      amount: expense.amount,
      amountPaid: expense.amountPaid,
      paymentDate: expense.paymentDate ? expense.paymentDate.toISOString() : null,
      paymentStatus: expense.paymentStatus,
      createdAt: expense.createdAt.toISOString(),
    },
    siteRemainingFund: remaining - amount,
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
              expense: z.object({ id: z.string(), amountPaid: z.number(), paymentStatus: z.string() }),
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

  const { amount, note } = parsed
  const newTotal = expense.amountPaid + amount

  if (newTotal > expense.amount) {
    return jsonError(c, `Payment of ${amount} would exceed the expense total (${expense.amount}). Remaining: ${expense.amount - expense.amountPaid}`, 400) as any
  }

  const paymentStatus = newTotal >= expense.amount ? 'COMPLETED' : newTotal > 0 ? 'PARTIAL' : 'PENDING'

  const result = await prisma.$transaction(async (tx: any) => {
    const payment = await tx.payment.create({
      data: {
        companyId: company.id,
        siteId: site.id,
        entityType: 'EXPENSE',
        entityId: expenseId,
        amount,
        note: note || 'Payment for expense',
      },
    })

    const updated = await tx.expense.update({
      where: { id: expenseId },
      data: { amountPaid: newTotal, paymentDate: new Date(), paymentStatus },
    })

    return { payment, updated }
  })

  await invalidateExpenseCaches(company.id, site.id)
  if (expense.vendorId) {
    cacheService.del(CacheKeys.vendorTransactions(expense.vendorId))
    cacheService.delByPattern(`${CacheKeys.vendorList(company.id)}:*`)
  }

  return jsonOk(c, {
    expense: { id: result.updated.id, amountPaid: result.updated.amountPaid, paymentStatus: result.updated.paymentStatus },
    payment: { id: result.payment.id, amount: result.payment.amount, createdAt: result.payment.createdAt },
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
    where: { entityType: 'EXPENSE', entityId: expenseId },
    orderBy: { createdAt: 'desc' },
  })

  return jsonOk(c, { payments }) as any
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
        include: { customer: true },
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
          ? {
              id: fl.customer.id,
              name: fl.customer.name,
              phone: fl.customer.phone,
              sellingPrice: fl.customer.sellingPrice,
              bookingAmount: fl.customer.bookingAmount,
              amountPaid: fl.customer.amountPaid,
              remaining: fl.customer.sellingPrice - fl.customer.amountPaid,
              customerType: fl.customer.customerType,
            }
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
    where: { siteId: site.id, type: 'EQUITY' },
    orderBy: { createdAt: 'desc' },
  })

  const totalInvested = investors.reduce((sum, i) => sum + i.totalInvested, 0)

  const responseData = {
    investors: investors.map((i) => ({
      id: i.id,
      name: i.name,
      phone: i.phone,
      equityPercentage: i.equityPercentage,
      totalInvested: i.totalInvested,
      totalReturned: i.totalReturned,
      isClosed: i.isClosed,
      createdAt: i.createdAt,
    })),
    totalInvested,
  }
  await cacheService.set(cacheKey, responseData, CacheTTL.ENTITY_LIST)
  return jsonOk(c, responseData) as any
})
