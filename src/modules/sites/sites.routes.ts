import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { createSiteSchema, errorResponseSchema } from './sites.schema.js'
import { siteReportSchema } from './site-report.schema.js'
import {
  createSiteForUser,
  deleteSiteForUser,
  getSiteDetailForUser,
  getSitesForUser,
  toggleSiteForUser,
} from './sites.service.js'
import { getSiteReportForUser } from './site-report.service.js'
import { registerSiteFundRoutes } from './site-funds.routes.js'
import { registerSiteExpenseRoutes } from './site-expenses.routes.js'
import { registerSiteStructureRoutes } from './site-structures.routes.js'
import { registerSiteInvestorRoutes } from './site-investors.routes.js'

export const siteRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

siteRoutes.use('*', requireJwt)

const createSiteRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Sites'],
  summary: 'Create a new site',
  description:
    'Create a construction site with name, address, floor count, and flat count. Floors and flats are auto-generated with flats distributed evenly across floors.',
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

  const site = await createSiteForUser(auth.userId, parsed.data)
  if (!site) return jsonError(c, 'No company found. Create one first.', 404) as any

  return jsonOk(
    c,
    {
      site: {
        id: site.id,
        name: site.name,
        address: site.address,
        totalFloors: site.totalFloors,
        totalFlats: site.totalFlats,
        slug: site.slug,
        createdAt: site.createdAt,
      },
    },
    201,
  ) as any
})

const getSitesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Sites'],
  summary: 'List all sites',
  description:
    'Returns sites for the company. By default returns only active sites. Pass `showArchived=true` to include archived sites, or `showArchived=only` to list only archived sites. Each site includes a fund breakdown: `partnerAllocatedFund`, `investorAllocatedFund`, `allocatedFund`, `totalExpenses`, `customerPayments`, `remainingFund`, and `isActive`.',
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
              sites: z.array(
                z.object({
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
                }),
              ),
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
  const { showArchived } = c.req.valid('query')

  const responseData = await getSitesForUser(auth.userId, showArchived)
  if (!responseData) return jsonError(c, 'No company found. Create one first.', 404) as any

  return jsonOk(c, responseData) as any
})

const getSiteRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Sites'],
  summary: 'Get site details',
  description:
    'Returns full site details with fund breakdown (`partnerAllocatedFund`, `investorAllocatedFund`, `allocatedFund`, `totalExpenses`, `customerPayments`, `remainingFund`) and flat status summary (available/booked/sold count).',
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

  const responseData = await getSiteDetailForUser(id, auth.userId)
  if (!responseData) return jsonError(c, 'Site not found', 404) as any

  return jsonOk(c, responseData) as any
})

const getSiteReportRoute = createRoute({
  method: 'get',
  path: '/{id}/report',
  tags: ['Sites'],
  summary: 'Get complete site report',
  description:
    'Returns a consolidated site report snapshot with overview, financials, inventory, customer bookings, expenses, investors, fund history, and recent activity.',
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
              report: siteReportSchema,
            }),
          }),
        },
      },
      description: 'Complete site report',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Site not found',
    },
  },
})

siteRoutes.openapi(getSiteReportRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const report = await getSiteReportForUser(id, auth.userId)
  if (!report) return jsonError(c, 'Site not found', 404) as any

  return jsonOk(c, { report }) as any
})

const toggleSiteRoute = createRoute({
  method: 'patch',
  path: '/{id}/toggle',
  tags: ['Sites'],
  summary: 'Archive or restore a site',
  description:
    'Toggles the site `isActive` flag. Active ? archived, archived ? active. Archived sites are hidden from the default site list.',
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

  const updated = await toggleSiteForUser(id, auth.userId)
  if (!updated) return jsonError(c, 'Site not found', 404) as any

  return jsonOk(c, {
    id: updated.id,
    name: updated.name,
    isActive: updated.isActive,
    message: updated.isActive ? `Site "${updated.name}" restored` : `Site "${updated.name}" archived`,
  }) as any
})

const deleteSiteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Sites'],
  summary: 'Permanently delete a site',
  description:
    'Permanently deletes the site and all associated data (floors, flats, funds, expenses). Vendors are NOT affected (they are company-level). Pass `keepCustomers=true` to preserve customer financial records; otherwise customers are deleted with the site.',
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

  const deletedSite = await deleteSiteForUser(id, auth.userId, keepCustomers)
  if (!deletedSite) return jsonError(c, 'Site not found', 404) as any

  return jsonOk(c, { message: `Site "${deletedSite.name}" permanently deleted` }) as any
})

registerSiteFundRoutes(siteRoutes)
registerSiteExpenseRoutes(siteRoutes)
registerSiteStructureRoutes(siteRoutes)
registerSiteInvestorRoutes(siteRoutes)
