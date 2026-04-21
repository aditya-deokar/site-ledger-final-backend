import { z } from '@hono/zod-openapi'
import { prisma } from '../../db/prisma.js'
import { getCompanyForUser } from '../../shared/access/company-access.js'
import { getEmployeeForUser } from './employee-access.service.js'
import {
  attendanceStatusToDb,
  mapAttendance,
  normalizeDateOnly,
} from './employees.mapper.js'
import type {
  attendanceHistoryQuerySchema,
  markAttendanceSchema,
} from './employees.schema.js'

type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>
type AttendanceHistoryQuery = z.infer<typeof attendanceHistoryQuerySchema>

function getMonthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(year, month, 1))
  return { start, end }
}

function computeAttendanceSummary(
  employeeId: string,
  month: number,
  year: number,
  rows: Array<{ status: 'PRESENT' | 'ABSENT' | 'HALF_DAY' }>,
) {
  const presentDays = rows.filter((row) => row.status === 'PRESENT').length
  const absentDays = rows.filter((row) => row.status === 'ABSENT').length
  const halfDays = rows.filter((row) => row.status === 'HALF_DAY').length
  const totalDays = rows.length
  const workDays = presentDays + (halfDays * 0.5)
  const attendancePercentage = totalDays > 0 ? Number(((workDays / totalDays) * 100).toFixed(2)) : 0

  return {
    employeeId,
    month,
    year,
    totalDays,
    presentDays,
    absentDays,
    halfDays,
    workDays,
    attendancePercentage,
  }
}

export async function markAttendanceForUser(userId: string, data: MarkAttendanceInput) {
  const { company, employee } = await getEmployeeForUser(data.employeeId, userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }
  if (!employee) return { error: 'Employee not found', status: 404 }

  const dateOnly = normalizeDateOnly(data.date)
  const attendance = await prisma.attendance.upsert({
    where: {
      employeeId_date: {
        employeeId: employee.id,
        date: dateOnly,
      },
    },
    update: {
      status: attendanceStatusToDb(data.status),
      checkInTime: data.checkInTime ?? null,
      checkOutTime: data.checkOutTime ?? null,
      reasonOfAbsenteeism: data.reasonOfAbsenteeism ?? null,
      markedBy: userId,
    },
    create: {
      employeeId: employee.id,
      date: dateOnly,
      status: attendanceStatusToDb(data.status),
      checkInTime: data.checkInTime ?? null,
      checkOutTime: data.checkOutTime ?? null,
      reasonOfAbsenteeism: data.reasonOfAbsenteeism ?? null,
      markedBy: userId,
    },
  })

  return {
    attendance: mapAttendance(attendance),
  }
}

export async function getAttendanceForEmployeeForUser(
  employeeId: string,
  userId: string,
  filters: AttendanceHistoryQuery,
) {
  const { employee } = await getEmployeeForUser(employeeId, userId)
  if (!employee) return null

  const now = new Date()
  const month = filters.month ?? (now.getUTCMonth() + 1)
  const year = filters.year ?? now.getUTCFullYear()
  const range = getMonthRange(year, month)

  const attendance = await prisma.attendance.findMany({
    where: {
      employeeId: employee.id,
      date: {
        gte: range.start,
        lt: range.end,
      },
    },
    orderBy: { date: 'desc' },
  })

  const summary = computeAttendanceSummary(
    employee.id,
    month,
    year,
    attendance.map((row) => ({ status: row.status })),
  )

  return {
    attendance: attendance.map(mapAttendance),
    summary,
  }
}

export async function getTodayAttendanceForUser(userId: string) {
  const company = await getCompanyForUser(userId)
  if (!company) return { error: 'No company found. Create one first.', status: 404 }

  const today = normalizeDateOnly(new Date())
  const tomorrow = new Date(today.getTime() + (24 * 60 * 60 * 1000))

  const employees = await prisma.employee.findMany({
    where: { companyId: company.id, isDeleted: false },
    select: { id: true, name: true, employeeId: true, status: true },
    orderBy: { name: 'asc' },
  })

  const attendanceRows = await prisma.attendance.findMany({
    where: {
      employee: {
        companyId: company.id,
        isDeleted: false,
      },
      date: {
        gte: today,
        lt: tomorrow,
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const byEmployeeId = new Map(attendanceRows.map((row) => [row.employeeId, row]))

  const items = employees.map((employee) => {
    const attendance = byEmployeeId.get(employee.id)
    return {
      employee: {
        id: employee.id,
        employeeId: employee.employeeId,
        name: employee.name,
      },
      attendance: attendance ? mapAttendance(attendance) : null,
    }
  })

  const present = attendanceRows.filter((row) => row.status === 'PRESENT').length
  const absent = attendanceRows.filter((row) => row.status === 'ABSENT').length
  const halfDay = attendanceRows.filter((row) => row.status === 'HALF_DAY').length

  return {
    date: today.toISOString(),
    attendance: items,
    summary: {
      totalEmployees: employees.length,
      markedCount: attendanceRows.length,
      present,
      absent,
      halfDay,
    },
  }
}
