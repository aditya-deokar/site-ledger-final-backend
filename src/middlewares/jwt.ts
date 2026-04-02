import type { MiddlewareHandler } from 'hono'
import type { AuthContext } from '../types/auth.js'
import { jsonError } from '../utils/response.js'
import { verifyToken } from '../services/auth.service.js'

export const requireJwt: MiddlewareHandler<AuthContext> = async (c, next) => {
  const auth = c.req.header('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null

  if (!token) {
    return jsonError(c, 'Unauthorized', 401)
  }

  try {
    const payload = verifyToken(token) as { sub?: string; email?: string }
    if (!payload?.sub) {
      return jsonError(c, 'Unauthorized', 401)
    }
    c.set('auth', { userId: payload.sub, email: payload.email })
    return next()
  } catch {
    return jsonError(c, 'Unauthorized', 401)
  }
}
