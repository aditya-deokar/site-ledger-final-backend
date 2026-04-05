import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'

export async function getSiteForUser(siteId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { company: null, site: null }

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId: company.id },
  })
  return { company, site }
}
