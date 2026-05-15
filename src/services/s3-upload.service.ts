import { createHash, createHmac, randomUUID } from 'crypto'
import { loadEnv } from '../config/env.js'

const env = loadEnv()

const MAX_COMPANY_LOGO_BYTES = 5 * 1024 * 1024
const MAX_VENDOR_DOCUMENT_BYTES = 10 * 1024 * 1024
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])
const ALLOWED_VENDOR_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

export class LogoUploadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'LogoUploadError'
  }
}

function sha256Hex(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function hmacSha256(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value).digest()
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function toDateStamp(date: Date) {
  return toAmzDate(date).slice(0, 8)
}

function encodeKeyPath(key: string) {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

function getFileExtension(file: File) {
  const fromName = file.name.match(/(\.[a-zA-Z0-9]+)$/)?.[1]?.toLowerCase()
  if (fromName) return fromName

  switch (file.type) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'application/pdf':
      return '.pdf'
    default:
      return ''
  }
}

function getS3Host(bucket: string, region: string) {
  return `${bucket}.s3.${region}.amazonaws.com`
}

function buildPublicUrl(key: string, bucket: string, region: string) {
  const encodedKey = encodeKeyPath(key)

  if (env.S3_PUBLIC_BASE_URL) {
    return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${encodedKey}`
  }

  return `https://${getS3Host(bucket, region)}/${encodedKey}`
}

function getObjectUrl(key: string, bucket: string, region: string) {
  return `https://${getS3Host(bucket, region)}/${encodeKeyPath(key)}`
}

function assertS3Config() {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION || !env.S3_BUCKET) {
    throw new LogoUploadError(
      'S3 upload is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and S3_BUCKET in the backend .env.',
      500,
    )
  }

  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION,
    bucket: env.S3_BUCKET,
  }
}

type S3UploadOptions = {
  allowedMimeTypes: Set<string>
  maxBytes: number
  invalidTypeMessage: string
  emptyMessage: string
  tooLargeMessage: string
  keyPrefix: string
  uploadFailureLabel: string
  loadFailureLabel: string
}

const companyLogoUploadOptions: S3UploadOptions = {
  allowedMimeTypes: ALLOWED_MIME_TYPES,
  maxBytes: MAX_COMPANY_LOGO_BYTES,
  invalidTypeMessage: 'Only PNG, JPG, JPEG, and WEBP logo files are supported.',
  emptyMessage: 'The selected logo file is empty.',
  tooLargeMessage: 'Logo file must be 5 MB or smaller.',
  keyPrefix: 'company-logos',
  uploadFailureLabel: 'logo',
  loadFailureLabel: 'logo',
}

const vendorDocumentUploadOptions: S3UploadOptions = {
  allowedMimeTypes: ALLOWED_VENDOR_DOCUMENT_MIME_TYPES,
  maxBytes: MAX_VENDOR_DOCUMENT_BYTES,
  invalidTypeMessage: 'Only PDF, PNG, JPG, JPEG, and WEBP vendor documents are supported.',
  emptyMessage: 'The selected vendor document is empty.',
  tooLargeMessage: 'Vendor document must be 10 MB or smaller.',
  keyPrefix: 'vendor-documents',
  uploadFailureLabel: 'vendor document',
  loadFailureLabel: 'vendor document',
}

function validateFile(file: File, options: S3UploadOptions) {
  if (!options.allowedMimeTypes.has(file.type)) {
    throw new LogoUploadError(options.invalidTypeMessage, 400)
  }

  if (file.size <= 0) {
    throw new LogoUploadError(options.emptyMessage, 400)
  }

  if (file.size > options.maxBytes) {
    throw new LogoUploadError(options.tooLargeMessage, 400)
  }
}

async function uploadFileToS3(file: File, userId: string, options: S3UploadOptions) {
  validateFile(file, options)
  const { accessKeyId, secretAccessKey, sessionToken, region, bucket } = assertS3Config()
  const extension = getFileExtension(file)
  const key = `${options.keyPrefix}/${userId}/${Date.now()}-${randomUUID()}${extension}`
  const encodedKey = encodeKeyPath(key)
  const host = getS3Host(bucket, region)
  const uploadUrl = `https://${host}/${encodedKey}`
  const contentType = file.type || 'application/octet-stream'
  const payload = new Uint8Array(await file.arrayBuffer())
  const payloadHash = sha256Hex(payload)
  const now = new Date()
  const amzDate = toAmzDate(now)
  const dateStamp = toDateStamp(now)
  const service = 's3'

  const canonicalHeadersRecord: Record<string, string> = {
    'content-type': contentType,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }

  if (sessionToken) {
    canonicalHeadersRecord['x-amz-security-token'] = sessionToken
  }

  const sortedHeaderEntries = Object.entries(canonicalHeadersRecord).sort(([a], [b]) => a.localeCompare(b))
  const canonicalHeaders = sortedHeaderEntries.map(([name, value]) => `${name}:${value.trim()}\n`).join('')
  const signedHeaders = sortedHeaderEntries.map(([name]) => name).join(';')
  const canonicalRequest = [
    'PUT',
    `/${encodedKey}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = getSigningKey(secretAccessKey, dateStamp, region, service)
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = [
    'AWS4-HMAC-SHA256',
    `Credential=${accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(' ')

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
    },
    body: payload,
  })

  if (!response.ok) {
    const responseText = await response.text().catch(() => '')
    throw new LogoUploadError(
      `Failed to upload ${options.uploadFailureLabel} to S3${responseText ? `: ${responseText}` : '.'}`,
      502,
    )
  }

  return {
    key,
    url: buildPublicUrl(key, bucket, region),
  }
}

export async function uploadCompanyLogoToS3(file: File, userId: string) {
  return uploadFileToS3(file, userId, companyLogoUploadOptions)
}

export async function uploadVendorDocumentToS3(file: File, userId: string) {
  return uploadFileToS3(file, userId, vendorDocumentUploadOptions)
}

export function extractCompanyLogoKey(value?: string | null) {
  if (!value) return null

  if (value.startsWith('company-logos/')) {
    return value
  }

  try {
    const parsed = new URL(value)
    const proxiedKey = parsed.searchParams.get('key')
    if (proxiedKey) {
      return proxiedKey
    }

    const pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    if (pathname.startsWith('company-logos/')) {
      return pathname
    }
  } catch {
    return null
  }

  return null
}

export function buildCompanyLogoProxyUrl(key: string, requestOrigin: string) {
  return `${requestOrigin}/api/uploads/company-logo?key=${encodeURIComponent(key)}`
}

export function buildVendorDocumentProxyUrl(key: string, requestOrigin: string) {
  return `${requestOrigin}/api/uploads/vendor-document?key=${encodeURIComponent(key)}`
}

export function resolveCompanyLogoUrl(value: string | null | undefined, requestOrigin: string) {
  const key = extractCompanyLogoKey(value)
  if (!key) {
    return value ?? null
  }

  return buildCompanyLogoProxyUrl(key, requestOrigin)
}

async function getFileFromS3(key: string, options: S3UploadOptions) {
  const { accessKeyId, secretAccessKey, sessionToken, region, bucket } = assertS3Config()
  const host = getS3Host(bucket, region)
  const objectUrl = getObjectUrl(key, bucket, region)
  const payloadHash = sha256Hex('')
  const now = new Date()
  const amzDate = toAmzDate(now)
  const dateStamp = toDateStamp(now)
  const service = 's3'

  const canonicalHeadersRecord: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }

  if (sessionToken) {
    canonicalHeadersRecord['x-amz-security-token'] = sessionToken
  }

  const sortedHeaderEntries = Object.entries(canonicalHeadersRecord).sort(([a], [b]) => a.localeCompare(b))
  const canonicalHeaders = sortedHeaderEntries.map(([name, value]) => `${name}:${value.trim()}\n`).join('')
  const signedHeaders = sortedHeaderEntries.map(([name]) => name).join(';')
  const canonicalRequest = [
    'GET',
    `/${encodeKeyPath(key)}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = getSigningKey(secretAccessKey, dateStamp, region, service)
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = [
    'AWS4-HMAC-SHA256',
    `Credential=${accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(' ')

  const response = await fetch(objectUrl, {
    method: 'GET',
    headers: {
      Authorization: authorization,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
    },
  })

  if (!response.ok) {
    const responseText = await response.text().catch(() => '')
    throw new LogoUploadError(
      `Failed to load ${options.loadFailureLabel} from S3${responseText ? `: ${responseText}` : '.'}`,
      response.status === 404 ? 404 : 502,
    )
  }

  return response
}

export async function getCompanyLogoFromS3(key: string) {
  return getFileFromS3(key, companyLogoUploadOptions)
}

export async function getVendorDocumentFromS3(key: string) {
  return getFileFromS3(key, vendorDocumentUploadOptions)
}
