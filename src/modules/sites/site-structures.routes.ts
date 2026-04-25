import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../../types/auth.js'
import { jsonError, jsonOk } from '../../utils/response.js'
import {
  createWingSchema,
  createFlatSchema,
  createFloorSchema,
  errorResponseSchema,
  updateWingSchema,
  updateFlatDetailsSchema,
  updateFlatSchema,
  updateFloorSchema,
} from './sites.schema.js'
import {
  createFlatForUser,
  createFloorInWingForUser,
  createWingForUser,
  deleteWingForUser,
  getWingsForUser,
  deleteFlatForUser,
  deleteFloorForUser,
  getFloorsForUser,
  updateWingForUser,
  updateFlatDetailsForUser,
  updateFlatForUser,
  updateFloorForUser,
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
                  wingId: z.string().nullable(),
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

    const floor = await createFloorInWingForUser(id, auth.userId, parsed.data)
    if (!floor) return jsonError(c, 'Site not found', 404) as any
    if ('error' in floor) return jsonError(c, floor.error, floor.status) as any

    return jsonOk(
      c,
      {
        floor: {
          id: floor.id,
          floorNumber: floor.floorNumber,
          floorName: floor.floorName,
          wingId: floor.wingId,
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
                  unitType: z.string().nullable(),
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
          unitType: flat.unitType,
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
                    wingId: z.string().nullable(),
                    wingName: z.string().nullable(),
                    flats: z.array(
                      z.object({
                        id: z.string(),
                        flatNumber: z.number().nullable(),
                        customFlatId: z.string().nullable(),
                        unitType: z.string().nullable(),
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

  const listWingsRoute = createRoute({
    method: 'get',
    path: '/{id}/wings',
    tags: ['Floors & Flats'],
    summary: 'List wings for a site',
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
                wings: z.array(
                  z.object({
                    id: z.string(),
                    siteId: z.string(),
                    name: z.string(),
                    code: z.string().nullable(),
                    isActive: z.boolean(),
                    floorsCount: z.number(),
                    createdAt: z.string().datetime(),
                    updatedAt: z.string().datetime(),
                  }),
                ),
              }),
            }),
          },
        },
        description: 'Wing list',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Site not found',
      },
    },
  })

  siteRoutes.openapi(listWingsRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')

    const responseData = await getWingsForUser(id, auth.userId)
    if (!responseData) return jsonError(c, 'Site not found', 404) as any

    return jsonOk(c, responseData) as any
  })

  const createWingRoute = createRoute({
    method: 'post',
    path: '/{id}/wings',
    tags: ['Floors & Flats'],
    summary: 'Create a wing for a site',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { 'application/json': { schema: createWingSchema } },
      },
    },
    responses: {
      201: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                wing: z.object({
                  id: z.string(),
                  siteId: z.string(),
                  name: z.string(),
                  code: z.string().nullable(),
                  isActive: z.boolean(),
                }),
              }),
            }),
          },
        },
        description: 'Wing created',
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

  siteRoutes.openapi(createWingRoute, async (c) => {
    const auth = c.get('auth')
    const { id } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = createWingSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const wing = await createWingForUser(id, auth.userId, parsed.data)
    if (!wing) return jsonError(c, 'Site not found', 404) as any
    if ('error' in wing) return jsonError(c, wing.error, wing.status) as any

    return jsonOk(c, { wing }, 201) as any
  })

  const updateWingRoute = createRoute({
    method: 'patch',
    path: '/{id}/wings/{wingId}',
    tags: ['Floors & Flats'],
    summary: 'Update wing details',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), wingId: z.string() }),
      body: {
        content: { 'application/json': { schema: updateWingSchema } },
      },
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                wing: z.object({
                  id: z.string(),
                  siteId: z.string(),
                  name: z.string(),
                  code: z.string().nullable(),
                  isActive: z.boolean(),
                }),
              }),
            }),
          },
        },
        description: 'Wing updated',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Bad request',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Wing not found',
      },
    },
  })

  siteRoutes.openapi(updateWingRoute, async (c) => {
    const auth = c.get('auth')
    const { id, wingId } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = updateWingSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const wing = await updateWingForUser(id, wingId, auth.userId, parsed.data)
    if (!wing) return jsonError(c, 'Site not found', 404) as any
    if ('error' in wing) return jsonError(c, wing.error, wing.status) as any

    return jsonOk(c, { wing }) as any
  })

  const deleteWingRoute = createRoute({
    method: 'delete',
    path: '/{id}/wings/{wingId}',
    tags: ['Floors & Flats'],
    summary: 'Delete a wing',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), wingId: z.string() }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                deletedWingId: z.string(),
              }),
            }),
          },
        },
        description: 'Wing deleted',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Cannot delete wing',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Wing not found',
      },
    },
  })

  siteRoutes.openapi(deleteWingRoute, async (c) => {
    const auth = c.get('auth')
    const { id, wingId } = c.req.valid('param')

    const deleted = await deleteWingForUser(id, wingId, auth.userId)
    if (!deleted) return jsonError(c, 'Site not found', 404) as any
    if ('error' in deleted) return jsonError(c, deleted.error ?? 'Could not delete wing', deleted.status) as any

    return jsonOk(c, {
      deletedWingId: deleted.id,
    }) as any
  })

  const updateFloorRoute = createRoute({
    method: 'patch',
    path: '/{id}/floors/{floorId}',
    tags: ['Floors & Flats'],
    summary: 'Update floor details',
    description: 'Update the floor name for a site floor.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), floorId: z.string() }),
      body: {
        content: { 'application/json': { schema: updateFloorSchema } },
      },
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                floor: z.object({
                  id: z.string(),
                  floorNumber: z.number(),
                  floorName: z.string().nullable(),
                  wingId: z.string().nullable(),
                }),
              }),
            }),
          },
        },
        description: 'Floor updated',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Bad request',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Floor not found',
      },
    },
  })

  siteRoutes.openapi(updateFloorRoute, async (c) => {
    const auth = c.get('auth')
    const { id, floorId } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = updateFloorSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const updated = await updateFloorForUser(id, floorId, auth.userId, parsed.data)
    if (!updated) return jsonError(c, 'Site not found', 404) as any
    if ('error' in updated) return jsonError(c, updated.error, updated.status) as any

    return jsonOk(c, {
      floor: {
        id: updated.id,
        floorNumber: updated.floorNumber,
        floorName: updated.floorName,
        wingId: updated.wingId,
      },
    }) as any
  })

  const deleteFloorRoute = createRoute({
    method: 'delete',
    path: '/{id}/floors/{floorId}',
    tags: ['Floors & Flats'],
    summary: 'Delete a floor',
    description: 'Deletes a floor only when it has no flats.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), floorId: z.string() }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                deletedFloorId: z.string(),
              }),
            }),
          },
        },
        description: 'Floor deleted',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Cannot delete floor',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Floor not found',
      },
    },
  })

  siteRoutes.openapi(deleteFloorRoute, async (c) => {
    const auth = c.get('auth')
    const { id, floorId } = c.req.valid('param')

    const deleted = await deleteFloorForUser(id, floorId, auth.userId)
    if (!deleted) return jsonError(c, 'Site not found', 404) as any
    if ('error' in deleted) return jsonError(c, deleted.error ?? 'Could not delete floor', deleted.status) as any

    return jsonOk(c, {
      deletedFloorId: deleted.id,
    }) as any
  })

  const updateFlatRoute = createRoute({
    method: 'put',
    path: '/{id}/floors/{floorId}/flats/{flatId}',
    tags: ['Floors & Flats'],
    summary: 'Update flat status',
    description: "Reset an unassigned flat to AVAILABLE. BOOKED and SOLD are controlled by customer booking and payment ledgers.",
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

  const updateFlatDetailsRoute = createRoute({
    method: 'patch',
    path: '/{id}/flats/{flatId}',
    tags: ['Floors & Flats'],
    summary: 'Update flat details',
    description: 'Update a flat unit ID. Flat type can only be changed while the unit is still available and unassigned.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), flatId: z.string() }),
      body: {
        content: { 'application/json': { schema: updateFlatDetailsSchema } },
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
                  customFlatId: z.string().nullable(),
                  unitType: z.string().nullable(),
                  flatType: z.string(),
                  status: z.string(),
                }),
              }),
            }),
          },
        },
        description: 'Flat details updated',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Cannot edit flat',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Flat not found',
      },
    },
  })

  siteRoutes.openapi(updateFlatDetailsRoute, async (c) => {
    const auth = c.get('auth')
    const { id, flatId } = c.req.valid('param')
    const body = await c.req.json().catch(() => null)
    const parsed = updateFlatDetailsSchema.safeParse(body)
    if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

    const updated = await updateFlatDetailsForUser(id, flatId, auth.userId, parsed.data)
    if (!updated) return jsonError(c, 'Site not found', 404) as any
    if ('error' in updated) return jsonError(c, updated.error, updated.status) as any

    return jsonOk(c, {
      flat: {
        id: updated.id,
        customFlatId: updated.customFlatId,
        unitType: updated.unitType,
        flatType: updated.flatType,
        status: updated.status,
      },
    }) as any
  })

  const deleteFlatRoute = createRoute({
    method: 'delete',
    path: '/{id}/flats/{flatId}',
    tags: ['Floors & Flats'],
    summary: 'Delete a flat',
    description: 'Deletes a flat only when it is available and not linked to a customer.',
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string(), flatId: z.string() }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              ok: z.literal(true),
              data: z.object({
                deletedFlatId: z.string(),
              }),
            }),
          },
        },
        description: 'Flat deleted',
      },
      400: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Cannot delete flat',
      },
      404: {
        content: { 'application/json': { schema: errorResponseSchema } },
        description: 'Flat not found',
      },
    },
  })

  siteRoutes.openapi(deleteFlatRoute, async (c) => {
    const auth = c.get('auth')
    const { id, flatId } = c.req.valid('param')

    const deleted = await deleteFlatForUser(id, flatId, auth.userId)
    if (!deleted) return jsonError(c, 'Site not found', 404) as any
    if ('error' in deleted) return jsonError(c, deleted.error ?? 'Could not delete flat', deleted.status) as any

    return jsonOk(c, {
      deletedFlatId: deleted.id,
    }) as any
  })
}
