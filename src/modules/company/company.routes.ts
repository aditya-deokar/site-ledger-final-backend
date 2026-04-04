import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { createCompanySchema, errorResponseSchema, updateCompanySchema } from './company.schema.js'
import {
  createCompanyForUser,
  getCompanyActivityForUser,
  getCompanyExpensesForUser,
  getCompanySummaryForUser,
  updateCompanyForUser,
  deleteCompanyForUser,
  isCompanyServiceError,
} from './company.service.js'
import { registerCompanyWithdrawalRoutes } from './company-withdrawals.routes.js'
import { registerCompanyPartnerRoutes } from './company-partners.routes.js'

export const companyRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

companyRoutes.use('*', requireJwt)

const createCompanyRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Company'],
  summary: 'Create a company',
  description: 'Create a new company for the authenticated user. Each user can have only one company.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: createCompanySchema },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              company: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
            }),
          }),
        },
      },
      description: 'Company created successfully',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input or company already exists',
    },
  },
})

companyRoutes.openapi(createCompanyRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createCompanySchema.safeParse(body)

  if (!parsed.success) {
    return jsonError(c, 'Invalid request body', 400) as any
  }

  const result = await createCompanyForUser(auth.userId, parsed.data)
  if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result, 201) as any
})

const getCompanyRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Company'],
  summary: 'Get company details',
  description:
    'Returns the company profile with all partners and a full fund breakdown: `partner_fund` (sum of partner investments), `investor_fund` (sum of fixed-rate investor transactions), `total_fund` (partner + investor), and `available_fund` (total minus funds allocated to sites).',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              company: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
              partner_fund: z.number(),
              investor_fund: z.number(),
              total_fund: z.number(),
              available_fund: z.number(),
              partners: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  email: z.string().nullable(),
                  phone: z.string().nullable(),
                  investmentAmount: z.number(),
                  stakePercentage: z.number(),
                }),
              ),
            }),
          }),
        },
      },
      description: 'Company details with partners and fund summary',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found for this user',
    },
  },
})

companyRoutes.openapi(getCompanyRoute, async (c) => {
  const auth = c.get('auth')
  const result = await getCompanySummaryForUser(auth.userId)
  if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const updateCompanyRoute = createRoute({
  method: 'put',
  path: '/',
  tags: ['Company'],
  summary: 'Update company details',
  description: 'Update the company name and/or address.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: updateCompanySchema },
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
              company: z.object({
                id: z.string(),
                name: z.string(),
                address: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
            }),
          }),
        },
      },
      description: 'Company updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(updateCompanyRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = updateCompanySchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await updateCompanyForUser(auth.userId, parsed.data)
  if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const deleteCompanyRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: ['Company'],
  summary: 'Delete company',
  description: 'Permanently delete the company and all associated data (sites, vendors, partners, customers, investors).',
  security: [{ bearerAuth: [] }],
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
      description: 'Company deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(deleteCompanyRoute, async (c) => {
  const auth = c.get('auth')
  const result = await deleteCompanyForUser(auth.userId)
  if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const getActivityRoute = createRoute({
  method: 'get',
  path: '/activity',
  tags: ['Company'],
  summary: 'Get recent company activity',
  description: 'Returns a paginated unified feed of recent events. Use ?cursor=ISO_DATE for next page.',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              activities: z.array(
                z.object({
                  id: z.string(),
                  type: z.enum(['withdrawal', 'site_fund', 'investor_tx', 'expense']),
                  amount: z.number(),
                  description: z.string(),
                  date: z.string().datetime(),
                }),
              ),
              nextCursor: z.string().nullable(),
            }),
          }),
        },
      },
      description: 'Recent activity',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(getActivityRoute, async (c) => {
  const auth = c.get('auth')
  const { cursor, limit } = c.req.valid('query')

  const result = await getCompanyActivityForUser(auth.userId, { cursor, limit })
  if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

const getCompanyExpensesRoute = createRoute({
  method: 'get',
  path: '/expenses',
  tags: ['Company'],
  summary: 'Get all company expenses across sites',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.coerce.number().min(1).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({
              expenses: z.array(
                z.object({
                  id: z.string(),
                  type: z.string(),
                  reason: z.string().nullable(),
                  description: z.string().nullable(),
                  amount: z.number(),
                  siteName: z.string(),
                  vendorName: z.string().nullable(),
                  createdAt: z.string().datetime(),
                }),
              ),
              total: z.number(),
              page: z.number(),
              totalPages: z.number(),
            }),
          }),
        },
      },
      description: 'Company expenses',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

companyRoutes.openapi(getCompanyExpensesRoute, async (c) => {
  const auth = c.get('auth')
  const { page, limit } = c.req.valid('query')

  const result = await getCompanyExpensesForUser(auth.userId, { page, limit })
  if (isCompanyServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result) as any
})

registerCompanyWithdrawalRoutes(companyRoutes)
registerCompanyPartnerRoutes(companyRoutes)
