import { Context } from 'hono'

export function jsonOk(c: Context, data: unknown, status = 200) {
  return c.json({ ok: true, data }, status as any)
}

export function jsonError(c: Context, message: string, status = 400) {
  return c.json({ ok: false, error: message }, status as any)
}
