import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { errorResponseSchema } from './sites.schema.js'
import { getSiteInvestorsForUser } from './site-investors.service.js'

type SiteRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

export function registerSiteInvestorRoutes(siteRoutes: SiteRouteApp) {
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
                investors: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    phone: z.string().nullable(),
                    equityPercentage: z.number().nullable(),
                    totalInvested: z.number(),
                    totalReturned: z.number(),
                    createdAt: z.string().datetime(),
                  }),
                ),
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

    const responseData = await getSiteInvestorsForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })
}
