import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import { hashPassword, signToken, verifyPassword } from '../services/auth.service.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { randomBytes } from 'crypto'

export const authRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
})

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

const signUpResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    user: z.object({
      id: z.string(),
      email: z.string().email(),
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
      createdAt: z.string().datetime(),
    }),
  }),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  details: z
    .array(
      z.object({
        message: z.string().optional(),
        code: z.string().optional(),
      }),
    )
    .optional(),
})

const signUpRoute = createRoute({
  method: 'post',
  path: '/signup',
  tags: ['Auth'],
  summary: 'Register a new user',
  description: 'Create a new user account with email and password. Returns the created user profile.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: signUpSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: signUpResponseSchema,
        },
      },
      description: 'User registered successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid input or email already in use',
    },
  },
})

authRoutes.openapi(signUpRoute, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = signUpSchema.safeParse(body)

  if (!parsed.success) {
    return jsonError(c, 'Invalid request body', 400) as any
  }

  try {
    const existing = await prisma.user.findUnique({
      where: { email: parsed.data.email },
    })

    if (existing) {
      return jsonError(c, 'Email already in use', 400) as any
    }

    const passwordHash = await hashPassword(parsed.data.password)
    const user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        passwordHash,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
      },
    })

    const token = signToken({ sub: user.id, email: user.email })

    return jsonOk(
      c,
      {
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          createdAt: user.createdAt,
        },
      },
      201,
    ) as any
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create user'
    return jsonError(c, message, 400) as any
  }
})

const meResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    user: z.object({
      id: z.string(),
      email: z.string().email(),
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
      createdAt: z.string().datetime(),
    }),
  }),
})

const signInRoute = createRoute({
  method: 'post',
  path: '/signin',
  tags: ['Auth'],
  summary: 'Sign in',
  description: 'Authenticate with email and password. Returns a JWT token valid for 7 days.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: signInSchema,
        },
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
              token: z.string(),
            }),
          }),
        },
      },
      description: 'Authentication successful, JWT token returned',
    },
    401: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid email or password',
    },
  },
})

authRoutes.openapi(signInRoute, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = signInSchema.safeParse(body)

  if (!parsed.success) {
    return jsonError(c, 'Invalid request body', 400) as any
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  })

  if (!user) {
    return jsonError(c, 'Invalid credentials', 401) as any
  }

  const ok = await verifyPassword(parsed.data.password, user.passwordHash)
  if (!ok) {
    return jsonError(c, 'Invalid credentials', 401) as any
  }

  const token = signToken({ sub: user.id, email: user.email })
  return jsonOk(c, { token }) as any
})

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Auth'],
  summary: 'Get current user profile',
  description: 'Returns the authenticated user\'s profile details using the JWT token.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: meResponseSchema,
        },
      },
      description: 'Current user profile',
    },
    401: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid or missing token',
    },
  },
})

authRoutes.openapi(meRoute, async (c) => {
  return requireJwt(c, async () => {
    const auth = c.get('auth')
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
    })

    if (!user) {
      return jsonError(c, 'Unauthorized', 401) as any
    }

    return jsonOk(c, {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        createdAt: user.createdAt,
      },
    }) as any
  }) as any
})

// ── POST /auth/forgot-password ────────────────────────

const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/forgot-password',
  tags: ['Auth'],
  summary: 'Request password reset',
  description: 'Generates a password reset token valid for 1 hour. Returns the token directly (use it in `/reset-password`). In production you would email this token to the user.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ email: z.string().email() }),
        },
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
              message: z.string(),
              resetToken: z.string(),
            }),
          }),
        },
      },
      description: 'Reset token generated',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Email not found',
    },
  },
})

authRoutes.openapi(forgotPasswordRoute, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = z.object({ email: z.string().email() }).safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (!user) return jsonError(c, 'No account found with that email', 404) as any

  const resetToken = randomBytes(32).toString('hex')
  const expiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetToken: resetToken, passwordResetExpiry: expiry },
  })

  return jsonOk(c, {
    message: 'Password reset token generated. Use it in /reset-password within 1 hour.',
    resetToken,
  }) as any
})

// ── POST /auth/reset-password ─────────────────────────

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/reset-password',
  tags: ['Auth'],
  summary: 'Reset password using token',
  description: 'Resets the user\'s password using a valid reset token from `/forgot-password`. Token is single-use and expires after 1 hour.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            token: z.string().min(1),
            newPassword: z.string().min(8),
          }),
        },
      },
    },
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
      description: 'Password reset successfully',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid or expired token',
    },
  },
})

authRoutes.openapi(resetPasswordRoute, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = z.object({ token: z.string().min(1), newPassword: z.string().min(8) }).safeParse(body)
  if (!parsed.success) return jsonError(c, 'Invalid request body', 400) as any

  const { token, newPassword } = parsed.data

  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken: token,
      passwordResetExpiry: { gt: new Date() },
    },
  })

  if (!user) return jsonError(c, 'Invalid or expired reset token', 400) as any

  const passwordHash = await hashPassword(newPassword)

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpiry: null,
    },
  })

  return jsonOk(c, { message: 'Password reset successfully. You can now sign in.' }) as any
})
