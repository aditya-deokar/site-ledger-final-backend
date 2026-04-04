import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { LedgerError } from '../../services/ledger.service.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { allocateFundSchema, errorResponseSchema, transferSchema } from './sites.schema.js'
import {
  allocateFundForUser,
  getSiteFundForUser,
  getSiteFundHistoryForUser,
  transferFundsForUser,
  withdrawFundForUser,
} from './site-funds.service.js'

type SiteRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

async function withTransferHandling<T>(action: () => Promise<T>) {
  return action().catch((err: unknown) => {
    if (err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS') {
      return { error: err.code, status: 400 as const }
    }

    throw err
  })
}

export function registerSiteFundRoutes(siteRoutes: SiteRouteApp) {
  const allocateFundRoute = createRoute({
    method: 'post',
    path: '/{id}/fund',
    tags: ['Site Fund'],
    summary: 'Allocate fund to site',
    description:
      'Transfer funds from company available fund to a site. Fails if the requested amount exceeds company available fund. Uses a transaction to prevent race conditions.',
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

    const result = await withTransferHandling(() => allocateFundForUser(id, auth.userId, parsed.data))
    if (!result) return jsonError(c, 'Site not found', 404) as any
    if ('error' in result) return jsonError(c, result.error, result.status) as any

    return jsonOk(
      c,
      {
        allocation: {
          id: result.transfer.companyEntry.id,
          amount: Number(result.transfer.companyEntry.amount),
          createdAt: result.transfer.companyEntry.postedAt,
        },
        companyAvailableFund: result.companyAvailableFund,
        siteAllocatedFund: result.siteAllocatedFund,
      },
      201,
    ) as any
  })

  const withdrawFundRoute = createRoute({
    method: 'post',
    path: '/{id}/withdraw',
    tags: ['Site Fund'],
    summary: 'Withdraw fund from site to company',
    description:
      'Pull unspent money back from a site into the company wallet by posting a ledger transfer. Fails if the requested amount exceeds the current site balance.',
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

    const result = await withTransferHandling(() => withdrawFundForUser(id, auth.userId, parsed.data))
    if (!result) return jsonError(c, 'Site not found', 404) as any
    if ('error' in result) return jsonError(c, result.error, result.status) as any

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

    const result = await withTransferHandling(() => transferFundsForUser(id, auth.userId, parsed.data))
    if (!result) return jsonError(c, 'Site not found', 404) as any
    if ('error' in result) return jsonError(c, result.error, result.status) as any

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
    description: "Returns the site's allocated fund, total expenses, remaining fund, and a history of all fund allocations.",
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
                allocations: z.array(
                  z.object({
                    id: z.string(),
                    amount: z.number(),
                    note: z.string().nullable(),
                    createdAt: z.string().datetime(),
                  }),
                ),
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

    const responseData = await getSiteFundForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })

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
                history: z.array(
                  z.object({
                    id: z.string(),
                    type: z.enum(['ALLOCATION', 'WITHDRAWAL']),
                    amount: z.number(),
                    note: z.string().nullable(),
                    runningBalance: z.number(),
                    createdAt: z.string().datetime(),
                  }),
                ),
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

    const responseData = await getSiteFundHistoryForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })
}
