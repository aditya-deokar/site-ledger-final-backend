import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { requireJwt } from '../../middlewares/jwt.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  createInvestorSchema,
  errorResponseSchema,
  investorResponseSchema,
  transactionResponseSchema,
  updateInvestorSchema,
  investorTypeEnum,
} from './investors.schema.js'
import {
  createInvestorForUser,
  deleteInvestorForUser,
  getInvestorDetailForUser,
  getInvestorsForUser,
  updateInvestorForUser,
} from './investors.service.js'
import { registerInvestorTransactionRoutes } from './investor-transactions.routes.js'

export const investorRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

investorRoutes.use('*', requireJwt)

function isInvestorServiceError(result: unknown): result is { error: string; status: number } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

const getInvestorsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Investors'],
  summary: 'List all investors',
  description:
    'Returns all investors for the company. Filter by type with `?type=EQUITY` or `?type=FIXED_RATE`, and search by investor name, phone, or site name with `?search=`.',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: investorTypeEnum.optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ investors: z.array(investorResponseSchema) }),
          }),
        },
      },
      description: 'List of investors',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No company found',
    },
  },
})

investorRoutes.openapi(getInvestorsRoute, async (c) => {
  const auth = c.get('auth')
  const { type, search } = c.req.valid('query')

  const responseData = await getInvestorsForUser(auth.userId, { type, search })
  if (!responseData) return jsonError(c, 'No company found. Create one first.', 404) as any

  return jsonOk(c, responseData) as any
})

const createInvestorRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Investors'],
  summary: 'Create an investor',
  description:
    'Create an equity investor (linked to a site) or a fixed-rate investor (linked to the company). Equity investors add funds directly to the site when they invest. Fixed-rate investors add to company available fund.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: createInvestorSchema } } },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ investor: investorResponseSchema }),
          }),
        },
      },
      description: 'Investor created',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Company or site not found',
    },
  },
})

investorRoutes.openapi(createInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const body = await c.req.json().catch(() => null)
  const parsed = createInvestorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await createInvestorForUser(auth.userId, parsed.data)
  if (isInvestorServiceError(result)) return jsonError(c, result.error, result.status) as any

  return jsonOk(c, result, 201) as any
})

const getInvestorRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Investors'],
  summary: 'Get investor profile',
  description: 'Returns investor details and full transaction history.',
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
              investor: investorResponseSchema,
              transactions: z.array(transactionResponseSchema),
            }),
          }),
        },
      },
      description: 'Investor profile with transaction history',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(getInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const responseData = await getInvestorDetailForUser(id, auth.userId)
  if (!responseData) return jsonError(c, 'Investor not found', 404) as any

  return jsonOk(c, responseData) as any
})

const updateInvestorRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Investors'],
  summary: 'Update investor details',
  description: 'Update investor name, phone, equity percentage, or fixed rate.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: updateInvestorSchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ investor: investorResponseSchema }),
          }),
        },
      },
      description: 'Investor updated',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid input',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(updateInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')
  const body = await c.req.json().catch(() => null)
  const parsed = updateInvestorSchema.safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const result = await updateInvestorForUser(id, auth.userId, parsed.data)
  if (!result) return jsonError(c, 'Investor not found', 404) as any

  return jsonOk(c, result) as any
})

const deleteInvestorRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Investors'],
  summary: 'Delete an investor',
  description: 'Remove an investor and all their transaction records. Fund values are recomputed automatically.',
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
            data: z.object({ message: z.string() }),
          }),
        },
      },
      description: 'Investor deleted',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Investor not found',
    },
  },
})

investorRoutes.openapi(deleteInvestorRoute, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.valid('param')

  const result = await deleteInvestorForUser(id, auth.userId)
  if (!result) return jsonError(c, 'Investor not found', 404) as any

  return jsonOk(c, result) as any
})

registerInvestorTransactionRoutes(investorRoutes)
