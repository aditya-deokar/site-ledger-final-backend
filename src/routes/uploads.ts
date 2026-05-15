import { OpenAPIHono } from '@hono/zod-openapi'
import type { AuthContext } from '../types/auth.js'
import { requireJwt } from '../middlewares/jwt.js'
import { jsonError, jsonOk } from '../utils/response.js'
import {
  LogoUploadError,
  buildCompanyLogoProxyUrl,
  buildVendorDocumentProxyUrl,
  getCompanyLogoFromS3,
  getVendorDocumentFromS3,
  uploadCompanyLogoToS3,
  uploadVendorDocumentToS3,
} from '../services/s3-upload.service.js'

export const uploadRoutes = new OpenAPIHono<{ Variables: AuthContext['Variables'] }>()

uploadRoutes.post('/company-logo', requireJwt, async (c) => {
  const auth = c.get('auth')
  const formData = await c.req.raw.formData().catch(() => null)

  if (!formData) {
    return jsonError(c, 'Expected a multipart/form-data request body.', 400)
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return jsonError(c, 'A logo file is required in the "file" form field.', 400)
  }

  try {
    const upload = await uploadCompanyLogoToS3(file, auth.userId)
    return jsonOk(c, {
      ...upload,
      url: buildCompanyLogoProxyUrl(upload.key, new URL(c.req.url).origin),
    }, 201) as any
  } catch (error) {
    if (error instanceof LogoUploadError) {
      return jsonError(c, error.message, error.status) as any
    }

    if (error instanceof Error) {
      return jsonError(c, error.message, 500) as any
    }

    return jsonError(c, 'Failed to upload logo.', 500) as any
  }
})

uploadRoutes.get('/company-logo', async (c) => {
  const key = c.req.query('key')
  if (!key) {
    return jsonError(c, 'Missing logo key.', 400)
  }

  try {
    const response = await getCompanyLogoFromS3(key)
    return new Response(response.body, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'Content-Length': response.headers.get('content-length') ?? '',
        'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
        ETag: response.headers.get('etag') ?? '',
      },
    })
  } catch (error) {
    if (error instanceof LogoUploadError) {
      return jsonError(c, error.message, error.status) as any
    }

    if (error instanceof Error) {
      return jsonError(c, error.message, 500) as any
    }

    return jsonError(c, 'Failed to load logo.', 500) as any
  }
})

uploadRoutes.post('/vendor-document', requireJwt, async (c) => {
  const auth = c.get('auth')
  const formData = await c.req.raw.formData().catch(() => null)

  if (!formData) {
    return jsonError(c, 'Expected a multipart/form-data request body.', 400)
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return jsonError(c, 'A document file is required in the "file" form field.', 400)
  }

  try {
    const upload = await uploadVendorDocumentToS3(file, auth.userId)
    return jsonOk(c, {
      ...upload,
      url: buildVendorDocumentProxyUrl(upload.key, new URL(c.req.url).origin),
    }, 201) as any
  } catch (error) {
    if (error instanceof LogoUploadError) {
      return jsonError(c, error.message, error.status) as any
    }

    if (error instanceof Error) {
      return jsonError(c, error.message, 500) as any
    }

    return jsonError(c, 'Failed to upload vendor document.', 500) as any
  }
})

uploadRoutes.get('/vendor-document', async (c) => {
  const key = c.req.query('key')
  if (!key) {
    return jsonError(c, 'Missing vendor document key.', 400)
  }

  try {
    const response = await getVendorDocumentFromS3(key)
    return new Response(response.body, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'Content-Length': response.headers.get('content-length') ?? '',
        'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
        ETag: response.headers.get('etag') ?? '',
      },
    })
  } catch (error) {
    if (error instanceof LogoUploadError) {
      return jsonError(c, error.message, error.status) as any
    }

    if (error instanceof Error) {
      return jsonError(c, error.message, 500) as any
    }

    return jsonError(c, 'Failed to load vendor document.', 500) as any
  }
})
