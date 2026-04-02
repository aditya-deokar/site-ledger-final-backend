import { createMiddleware } from 'hono/factory'
import { randomUUID } from 'crypto'

export const requestId = createMiddleware(async (c, next) => {
  const id = c.req.header('X-Request-ID') || randomUUID()
  c.set('requestId', id)
  c.header('X-Request-ID', id)
  await next()
})
