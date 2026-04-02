import type { Context } from 'hono'

export interface AuthContext {
  Variables: {
    auth: {
      userId: string
      email?: string
    }
  }
}

export type AuthContextHandler = Context<AuthContext>
