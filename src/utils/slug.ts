import { prisma } from '../db/prisma.js'

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name)
  let slug = base
  let counter = 2

  while (await prisma.site.findUnique({ where: { slug } })) {
    slug = `${base}-${counter}`
    counter++
  }

  return slug
}
