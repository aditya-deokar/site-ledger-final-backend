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

export function signToken(payload: { sub: string; email: string }) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET)
}
