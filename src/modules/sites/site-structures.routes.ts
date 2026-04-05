import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import { createFlatSchema, createFloorSchema, errorResponseSchema, updateFlatSchema } from './sites.schema.js'
import {
  createFlatForUser,
  createFloorForUser,
  getFloorsForUser,
  updateFlatForUser,
} from './site-structures.service.js'

type SiteRouteApp = OpenAPIHono<{ Variables: AuthContext['Variables'] }>

export function registerSiteStructureRoutes(siteRoutes: SiteRouteApp) {
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

    const floor = await createFloorForUser(id, auth.userId, parsed.data.floorName)
    if (!floor) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(
      c,
      {
        floor: {
          id: floor.id,
          floorNumber: floor.floorNumber,
          floorName: floor.floorName,
        },
      },
      201,
    ) as any
  })

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

    const flat = await createFlatForUser(id, floorId, auth.userId, parsed.data)
    if (!flat) return jsonError(c, 'Site not found', 404) as any
    if ('error' in flat) return jsonError(c, flat.error, flat.status) as any

    return jsonOk(
      c,
      {
        flat: {
          id: flat.id,
          customFlatId: flat.customFlatId,
          status: flat.status,
        },
      },
      201,
    ) as any
  })

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
                floors: z.array(
                  z.object({
                    id: z.string(),
                    floorNumber: z.number(),
                    floorName: z.string().nullable(),
                    flats: z.array(
                      z.object({
                        id: z.string(),
                        flatNumber: z.number().nullable(),
                        customFlatId: z.string().nullable(),
                        status: z.string(),
                        flatType: z.string(),
                        customer: z
                          .object({
                            id: z.string(),
                            name: z.string(),
                            phone: z.string().nullable(),
                            sellingPrice: z.number(),
                            bookingAmount: z.number(),
                            amountPaid: z.number(),
                            remaining: z.number(),
                            customerType: z.string(),
                          })
                          .nullable(),
                      }),
                    ),
                  }),
                ),
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

    const responseData = await getFloorsForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })

  const updateFlatRoute = createRoute({
    method: 'put',
    path: '/{id}/floors/{floorId}/flats/{flatId}',
    tags: ['Floors & Flats'],
    summary: 'Update flat status',
    description: "Manually update a flat's status to AVAILABLE, BOOKED, or SOLD.",
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

    const updated = await updateFlatForUser(id, floorId, flatId, auth.userId, parsed.data.status)
    if (!updated) return jsonError(c, 'Site not found', 404) as any
    if ('error' in updated) return jsonError(c, updated.error, updated.status) as any

    return jsonOk(c, {
      flat: {
        id: updated.id,
        flatNumber: updated.flatNumber,
        customFlatId: updated.customFlatId,
        status: updated.status,
      },
    }) as any
  })
}
