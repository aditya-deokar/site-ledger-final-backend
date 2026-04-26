import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'

const env = loadEnv()

export async function hashPassword(password: string) {
  const salt = await bcrypt.genSalt(12)
  return bcrypt.hash(password, salt)
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash)
}

export function signAccessToken(payload: { sub: string; email: string }) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '15m' })
}

export function signRefreshToken(payload: { sub: string }) {
  return jwt.sign(payload, env.REFRESH_TOKEN_SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET)
}

export function verifyRefreshToken(token: string) {
  return jwt.verify(token, env.REFRESH_TOKEN_SECRET)
}

export async function verifyRecaptcha(token?: string): Promise<boolean> {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;
  if (!secretKey) {
    console.warn('RECAPTCHA_SECRET_KEY is not set. Skipping verification (unsafe).');
    return true; // Keys not set -> Fail open
  }

  // If frontend detected an invalid site key, it sends BYPASS
  if (token === 'BYPASS') {
    console.warn('Frontend reported invalid site key. Bypassing verification.');
    return true; 
  }

  // If key is set but no token is provided, and it's not a bypass -> Block
  if (!token) return false;

  try {
    const res = await fetch(`https://www.google.com/recaptcha/api/siteverify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `secret=${secretKey}&response=${token}`,
    });
    const data = await res.json();
    
    if (data.success) {
      if (data.score !== undefined && data.score < 0.5) {
        console.warn(`reCAPTCHA v3 score too low: ${data.score}`);
        return false;
      }
      return true;
    }

    // Google returns error-codes if keys are invalid
    const errorCodes = data['error-codes'] || [];
    if (errorCodes.includes('invalid-input-secret') || errorCodes.includes('missing-input-secret')) {
      console.warn('reCAPTCHA secret key is invalid according to Google. Bypassing verification.');
      return true; // Invalid secret key -> Fail open
    }

    // Otherwise, the captcha token itself is invalid (e.g. timeout, duplicate, or bot)
    return false;
  } catch (error) {
    console.error('reCAPTCHA verification network error:', error);
    return true; // Network error -> Fail open
  }
}
