import { Prisma } from '@prisma/client'
import { z } from '@hono/zod-openapi'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { getEmployeeForUser } from './employee-access.service.js'
import {
  employeeStatusToDb,
  mapEmployee,
  mapEmployeeDocument,
} from './employees.mapper.js'
import type {
  createEmployeeSchema,
  employeeListQuerySchema,
  updateEmployeeSchema,
  uploadDocumentSchema,
} from './employees.schema.js'

type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>
type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>
type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>
type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>

export type EmployeeServiceError = {
  error: string
  status: number
}

export function isEmployeeServiceError(result: unknown): result is EmployeeServiceError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof result.error === 'string' &&
    'status' in result &&
    typeof result.status === 'number'
  )
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function formatEmployeeId(sequence: number) {
  return `EMP-${String(sequence).padStart(4, '0')}`
}

async function getNextGeneratedEmployeeId(companyId: string) {
  const existing = await prisma.employee.findMany({
    where: { companyId },
    select: { employeeId: true },
  })

  let maxSequence = 0
  for (const employee of existing) {
    const match = /^EMP-(\d+)$/i.exec(employee.employeeId)
    if (!match) continue
    const value = Number.parseInt(match[1]!, 10)
    if (Number.isFinite(value) && value > maxSequence) {
      maxSequence = value
    }
  }

  return formatEmployeeId(maxSequence + 1)
}

export async function getEmployeesForUser(userId: string, filters: EmployeeListQuery) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const search = filters.search?.trim()
  const employees = await prisma.employee.findMany({
    where: {
      companyId: company.id,
      isDeleted: false,
      ...(filters.department
        ? { department: { equals: filters.department, mode: 'insensitive' } }
        : {}),
      ...(filters.status ? { status: employeeStatusToDb(filters.status) } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { employeeId: { contains: search, mode: 'insensitive' } },
              { designation: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
  })

  const activeCount = employees.filter((employee) => employee.status === 'ACTIVE').length
  const inactiveCount = employees.filter((employee) => employee.status === 'INACTIVE').length
  const terminatedCount = employees.filter((employee) => employee.status === 'TERMINATED').length

  return {
    employees: employees.map(mapEmployee),
    total: employees.length,
    summary: {
      active: activeCount,
      inactive: inactiveCount,
      terminated: terminatedCount,
    },
  }
}

export async function createEmployeeForUser(userId: string, data: CreateEmployeeInput) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const requestedEmployeeId = data.employeeId?.trim()
  const buildCreateData = (employeeId: string) => ({
    companyId: company.id,
    name: data.name,
    email: data.email,
    phone: data.phone,
    address: data.address,
    photo: data.photo,
    employeeId,
    designation: data.designation,
    department: data.department,
    dateOfJoining: data.dateOfJoining,
    salary: data.salary,
    status: employeeStatusToDb(data.status ?? 'active'),
  })

  if (requestedEmployeeId) {
    try {
      const employee = await prisma.employee.create({
        data: buildCreateData(requestedEmployeeId),
      })

      return { employee: mapEmployee(employee) }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { error: 'Employee ID already exists for this company', status: 409 }
      }

      throw error
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const generatedEmployeeId = await getNextGeneratedEmployeeId(company.id)

    try {
      const employee = await prisma.employee.create({
        data: buildCreateData(generatedEmployeeId),
      })

      return { employee: mapEmployee(employee) }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        continue
      }

      throw error
    }
  }

  return { error: 'Unable to generate unique employee ID. Please retry.', status: 409 }
}

export async function getEmployeeDetailForUser(employeeId: string, userId: string) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return null

  const [documentsCount, attendanceCount, transactionCount] = await Promise.all([
    prisma.employeeDocument.count({ where: { employeeId } }),
    prisma.attendance.count({ where: { employeeId } }),
    prisma.employeeTransaction.count({ where: { employeeId } }),
  ])

  return {
    employee: mapEmployee(employee),
    stats: {
      documentsCount,
      attendanceCount,
      transactionCount,
    },
  }
}

export async function updateEmployeeForUser(
  employeeId: string,
  userId: string,
  data: UpdateEmployeeInput,
) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return null

  try {
    const updated = await prisma.employee.update({
      where: { id: employeeId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.photo !== undefined ? { photo: data.photo } : {}),
        ...(data.employeeId !== undefined ? { employeeId: data.employeeId } : {}),
        ...(data.designation !== undefined ? { designation: data.designation } : {}),
        ...(data.department !== undefined ? { department: data.department } : {}),
        ...(data.dateOfJoining !== undefined ? { dateOfJoining: data.dateOfJoining } : {}),
        ...(data.salary !== undefined ? { salary: data.salary } : {}),
        ...(data.status !== undefined ? { status: employeeStatusToDb(data.status) } : {}),
      },
    })

    return { employee: mapEmployee(updated) }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { error: 'Employee ID already exists for this company', status: 409 }
    }

    throw error
  }
}

export async function deleteEmployeeForUser(employeeId: string, userId: string) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return null

  await prisma.employee.update({
    where: { id: employeeId },
    data: { isDeleted: true, status: 'TERMINATED' },
  })

  return {
    message: `Employee "${employee.name}" removed`,
  }
}

export async function getEmployeeDocumentsForUser(employeeId: string, userId: string) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return null

  const documents = await prisma.employeeDocument.findMany({
    where: { employeeId: employee.id },
    orderBy: { uploadedAt: 'desc' },
  })

  return {
    documents: documents.map(mapEmployeeDocument),
  }
}

export async function uploadEmployeeDocumentForUser(
  employeeId: string,
  userId: string,
  data: UploadDocumentInput,
) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return null

  const document = await prisma.employeeDocument.create({
    data: {
      employeeId: employee.id,
      documentType: data.documentType,
      documentName: data.documentName,
      fileUrl: data.fileUrl ?? null,
      keyValueData: data.keyValueData ?? undefined,
    },
  })

  return {
    document: mapEmployeeDocument(document),
  }
}

export async function deleteEmployeeDocumentForUser(
  employeeId: string,
  documentId: string,
  userId: string,
) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return { error: 'Employee not found', status: 404 }

  const document = await prisma.employeeDocument.findFirst({
    where: {
      id: documentId,
      employeeId: employee.id,
    },
  })

  if (!document) return { error: 'Document not found', status: 404 }

  await prisma.employeeDocument.delete({ where: { id: document.id } })

  return {
    message: `Document "${document.documentName}" deleted`,
  }
}

export async function getDocumentDownloadForUser(documentId: string, userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const document = await prisma.employeeDocument.findFirst({
    where: {
      id: documentId,
      employee: {
        companyId: company.id,
        isDeleted: false,
      },
    },
  })

  if (!document) return { error: 'Document not found', status: 404 }
  if (!document.fileUrl) return { error: 'Document has no file URL to download', status: 400 }

  return {
    document: mapEmployeeDocument(document),
    downloadUrl: document.fileUrl,
  }
}
