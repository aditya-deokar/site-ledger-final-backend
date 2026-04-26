import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { prisma } from '../db/prisma.js'
import {
  hashPassword,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
  verifyRefreshToken,
  verifyRecaptcha,
} from '../services/auth.service.js'
import {
  EMAIL_VALIDATION_REGEX,
  VERIFICATION_CODE_LENGTH,
} from '../constants/auth.constants.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import { getPasswordValidationMessage } from '../utils/password-policy.js'
import { randomBytes } from 'crypto'

import { VerificationService } from '../services/verification.service.js'
import { VerificationType } from '@prisma/client'

export const authRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

const getValidationErrorMessage = (error: z.ZodError<unknown>, fallback = 'Invalid request body') =>
  error.issues[0]?.message || fallback

const signUpSchema = z.object({
  email: z.string().regex(EMAIL_VALIDATION_REGEX, 'Invalid email format'),
  password: z.string().min(1, 'Password is required.'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  recaptchaToken: z.string().optional(),
})

const signInSchema = z.object({
  email: z.string().regex(EMAIL_VALIDATION_REGEX, 'Invalid email format'),
  password: z.string().min(1, 'Password is required.'),
  recaptchaToken: z.string().optional(),
})

const resetPasswordBodySchema = z.object({
  token: z.string().min(1, 'Reset token is required.'),
  newPassword: z.string().min(1, 'Password is required.'),
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
  summary: 'Request signup verification',
  description: 'Initiates signup process by sending a 6-digit verification code to the user email.',
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
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            data: z.object({ message: z.string() }),
          }),
        },
      },
      description: 'Verification code sent',
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
    return jsonError(c, getValidationErrorMessage(parsed.error), 400) as any
  }

  const { email, password, recaptchaToken } = parsed.data
  const firstName = parsed.data.firstName?.trim() || undefined
  const lastName = parsed.data.lastName?.trim() || undefined
  const passwordError = getPasswordValidationMessage(password)

  if (passwordError) {
    return jsonError(c, passwordError, 400) as any
  }

  try {
    // const isHuman = await verifyRecaptcha(recaptchaToken)
    // if (!isHuman) {
    //   return jsonError(c, 'Invalid captcha. Please try again.', 400) as any
    // }

    const existing = await prisma.user.findUnique({
      where: { email },
    })

    if (existing) {
      return jsonError(c, 'Email already in use', 400) as any
    }

    const passwordHash = await hashPassword(password)
    
    // Store pending data and send code
    await VerificationService.sendVerificationCode(email, VerificationType.SIGNUP, {
      passwordHash,
      firstName,
      lastName,
    })

    return jsonOk(c, { message: 'A 6-digit verification code has been sent to your email.' }) as any
  } catch {
    return jsonError(c, 'Failed to initiate signup', 500) as any
  }
})

const verifySignUpSchema = z.object({
  email: z.string().regex(EMAIL_VALIDATION_REGEX, 'Invalid email format'),
  code: z.string().length(VERIFICATION_CODE_LENGTH),
})

const verifySignUpRoute = createRoute({
  method: 'post',
  path: '/signup/verify',
  tags: ['Auth'],
  summary: 'Verify signup code',
  description: 'Verifies the 6-digit code and creates the user account.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: verifySignUpSchema,
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
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid or expired code',
    },
  },
})

authRoutes.openapi(verifySignUpRoute, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = verifySignUpSchema.safeParse(body)

  if (!parsed.success) {
    return jsonError(c, getValidationErrorMessage(parsed.error, 'Invalid verification code'), 400) as any
  }

  const { email, code } = parsed.data

  try {
    const verification = await VerificationService.verifyCode(email, code, VerificationType.SIGNUP)
    
    if (!verification.success) {
      return jsonError(c, verification.message || 'Verification failed', 400) as any
    }

    const { passwordHash, firstName, lastName } = verification.payload as any

    // Check again if user was created while verifying
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      await VerificationService.cleanup(email, VerificationType.SIGNUP)
      return jsonError(c, 'User already exists', 400) as any
    }

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName,
        lastName,
      },
    })

    const accessToken = signAccessToken({ sub: user.id, email: user.email })
    const refreshToken = signRefreshToken({ sub: user.id })

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    })

    // Cleanup code
    await VerificationService.cleanup(email, VerificationType.SIGNUP)

    return jsonOk(
      c,
      {
        accessToken,
        refreshToken,
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
  } catch {
    return jsonError(c, 'Failed to verify signup', 500) as any
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
  description: 'Authenticate with email and password. Returns access and refresh tokens.',
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
              accessToken: z.string(),
              refreshToken: z.string(),
            }),
          }),
        },
      },
      description: 'Authentication successful, JWT tokens returned',
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
    return jsonError(c, getValidationErrorMessage(parsed.error), 400) as any
  }

  try {
    // const isHuman = await verifyRecaptcha(parsed.data.recaptchaToken)
    // if (!isHuman) {
    //   return jsonError(c, 'Invalid captcha. Please try again.', 400) as any
    // }

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

    const accessToken = signAccessToken({ sub: user.id, email: user.email })
    const refreshToken = signRefreshToken({ sub: user.id })

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    })

    return jsonOk(c, {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        createdAt: user.createdAt,
      },
    }) as any
  } catch (error) {
    console.error('SignIn Error:', error)
    return jsonError(c, 'An error occurred while connecting to the database. Please try again.', 500) as any
  }
})


const refreshRoute = createRoute({
  method: 'post',
  path: '/refresh',
  tags: ['Auth'],
  summary: 'Refresh access token',
  description: 'Exchange a valid refresh token for a new access token.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            refreshToken: z.string(),
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
            data: z.object({
              accessToken: z.string(),
              refreshToken: z.string(),
            }),
          }),
        },
      },
      description: 'Token refreshed successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid or expired refresh token',
    },
  },
})

authRoutes.openapi(refreshRoute, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = z.object({ refreshToken: z.string() }).safeParse(body)

  if (!parsed.success) {
    return jsonError(c, getValidationErrorMessage(parsed.error, 'Refresh token required'), 400) as any
  }

  try {
    const payload = verifyRefreshToken(parsed.data.refreshToken) as { sub: string }
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
    })

    if (!user || user.refreshToken !== parsed.data.refreshToken) {
      return jsonError(c, 'Invalid refresh token', 401) as any
    }

    const accessToken = signAccessToken({ sub: user.id, email: user.email })
    const newRefreshToken = signRefreshToken({ sub: user.id })

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    })

    return jsonOk(c, { accessToken, refreshToken: newRefreshToken }) as any
  } catch {
    return jsonError(c, 'Invalid or expired refresh token', 401) as any
  }
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

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: ['Auth'],
  summary: 'Logout user',
  description: 'Clears the refresh token from the database for the authenticated user.',
  security: [{ bearerAuth: [] }],
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
      description: 'Logout successful',
    },
    401: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid or missing token',
    },
  },
})

authRoutes.openapi(logoutRoute, async (c) => {
  return requireJwt(c, async () => {
    const auth = c.get('auth')
    await prisma.user.update({
      where: { id: auth.userId },
      data: { refreshToken: null },
    })

    return jsonOk(c, { message: 'Logged out successfully' }) as any
  }) as any
})

// ── POST /auth/forgot-password ────────────────────────


// ── POST /auth/forgot-password ────────────────────────

const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/forgot-password',
  tags: ['Auth'],
  summary: 'Request password reset code',
  description: 'Generates a 6-digit reset code and sends it to the user email.',
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
            }),
          }),
        },
      },
      description: 'Reset code sent',
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
  if (!parsed.success) return jsonError(c, getValidationErrorMessage(parsed.error), 400) as any

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (!user) return jsonError(c, 'No account found with that email', 404) as any

  const resetToken = randomBytes(32).toString('hex')
  const expiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  // Store the code and the future reset token in payload
  await VerificationService.sendVerificationCode(parsed.data.email, VerificationType.PASSWORD_RESET, {
    resetToken,
    expiry,
  })

  return jsonOk(c, {
    message: 'A 6-digit password reset code has been sent to your email.',
  }) as any
})

// ── POST /auth/forgot-password/verify ─────────────────

const verifyResetCodeRoute = createRoute({
  method: 'post',
  path: '/forgot-password/verify',
  tags: ['Auth'],
  summary: 'Verify reset code',
  description: 'Verifies the 6-digit code and returns a secure reset token.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().email(),
            code: z.string().length(VERIFICATION_CODE_LENGTH),
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
            data: z.object({
              resetToken: z.string(),
            }),
          }),
        },
      },
      description: 'Code verified, token returned',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Invalid or expired code',
    },
  },
})

authRoutes.openapi(verifyResetCodeRoute, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = z.object({
    email: z.string().email(),
    code: z.string().length(VERIFICATION_CODE_LENGTH),
  }).safeParse(body)

  if (!parsed.success) return jsonError(c, getValidationErrorMessage(parsed.error), 400) as any

  const { email, code } = parsed.data

  try {
    const verification = await VerificationService.verifyCode(email, code, VerificationType.PASSWORD_RESET)
    
    if (!verification.success) {
      return jsonError(c, verification.message || 'Verification failed', 400) as any
    }

    const { resetToken, expiry } = verification.payload as any

    // Update user with the token so they can proceed to reset-password page
    await prisma.user.update({
      where: { email },
      data: {
        passwordResetToken: resetToken,
        passwordResetExpiry: expiry,
      },
    })

    // Cleanup code
    await VerificationService.cleanup(email, VerificationType.PASSWORD_RESET)

    return jsonOk(c, { resetToken }) as any
  } catch (err) {
    return jsonError(c, 'Failed to verify reset code', 500) as any
  }
})

// ── POST /auth/reset-password ─────────────────────────

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/reset-password',
  tags: ['Auth'],
  summary: 'Reset password using token',
  description: 'Resets the user\'s password using a valid reset token from `/forgot-password/verify`.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: resetPasswordBodySchema,
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
  const parsed = resetPasswordBodySchema.safeParse(body)
  if (!parsed.success) return jsonError(c, getValidationErrorMessage(parsed.error), 400) as any

  const { token, newPassword } = parsed.data
  const passwordError = getPasswordValidationMessage(newPassword)

  if (passwordError) {
    return jsonError(c, passwordError, 400) as any
  }

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
