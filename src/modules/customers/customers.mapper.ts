import { sumDirectionalLedgerAmounts } from '../../services/customer-ledger.service.js'

type LedgerEntry = {
  amount: number | string | { toString(): string }
  direction: 'IN' | 'OUT'
}

type CustomerFlat = {
  flatNumber: number | null
  customFlatId?: string | null
  status: string
  floor: {
    floorNumber: number | null
    floorName?: string | null
  } | null
} | null

type CustomerForResponse = {
  id: string
  name: string
  phone: string | null
  email: string | null
  sellingPrice: number
  bookingAmount: number
  dealStatus: 'ACTIVE' | 'CANCELLED'
  customerType: string | null
  flatId: string | null
  createdAt: Date
  cancelledAt?: Date | null
  cancellationReason?: string | null
  cancelledByUserId?: string | null
  cancelledFromFlatStatus?: 'AVAILABLE' | 'BOOKED' | 'SOLD' | null
  cancelledFlatId?: string | null
  cancelledFlatDisplay?: string | null
  cancelledFloorNumber?: number | null
  cancelledFloorName?: string | null
  ledgerEntries: LedgerEntry[]
  flat: CustomerFlat
}

function getAmountPaid(ledgerEntries: LedgerEntry[]) {
  return sumDirectionalLedgerAmounts(ledgerEntries)
}

function getCustomerFlatState(customer: CustomerForResponse) {
  return {
    flatId: customer.dealStatus === 'ACTIVE' ? customer.flatId : null,
    flatNumber: customer.flat?.flatNumber ?? null,
    floorNumber: customer.flat?.floor?.floorNumber ?? null,
    flatStatus: customer.flat?.status ?? null,
    customFlatId: customer.flat?.customFlatId ?? null,
    floorName: customer.flat?.floor?.floorName ?? null,
  }
}

function getCustomerCancellationState(customer: CustomerForResponse) {
  return {
    cancelledAt: customer.cancelledAt ?? null,
    cancellationReason: customer.cancellationReason ?? null,
    cancelledByUserId: customer.cancelledByUserId ?? null,
    cancelledFromFlatStatus: customer.cancelledFromFlatStatus ?? null,
    cancelledFlatId: customer.cancelledFlatId ?? null,
    cancelledFlatDisplay: customer.cancelledFlatDisplay ?? null,
    cancelledFloorNumber: customer.cancelledFloorNumber ?? null,
    cancelledFloorName: customer.cancelledFloorName ?? null,
  }
}

function mapCustomerCore(customer: CustomerForResponse) {
  const amountPaid = getAmountPaid(customer.ledgerEntries)

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    sellingPrice: customer.sellingPrice,
    bookingAmount: customer.bookingAmount,
    amountPaid,
    remaining: customer.sellingPrice - amountPaid,
    dealStatus: customer.dealStatus,
    customerType: customer.customerType,
    ...getCustomerFlatState(customer),
    ...getCustomerCancellationState(customer),
    createdAt: customer.createdAt,
  }
}

export function mapCompanyCustomerSummary(customer: CustomerForResponse & {
  siteId: string | null
  site: { id: string; name: string } | null
}) {
  return {
    ...mapCustomerCore(customer),
    siteId: customer.siteId,
    siteName: customer.site?.name ?? null,
  }
}

export function mapSiteCustomerResponse(customer: CustomerForResponse) {
  return mapCustomerCore(customer)
}

export function mapFlatCustomerResponse(customer: CustomerForResponse) {
  return mapCustomerCore(customer)
}

export function mapBookingCustomerResponse(input: {
  customer: {
    id: string
    name: string
    phone: string | null
    email: string | null
    sellingPrice: number
    bookingAmount: number
    dealStatus: 'ACTIVE' | 'CANCELLED'
    customerType: string | null
    flatId: string | null
    createdAt: Date
    cancelledAt?: Date | null
    cancellationReason?: string | null
    cancelledByUserId?: string | null
    cancelledFromFlatStatus?: 'AVAILABLE' | 'BOOKED' | 'SOLD' | null
    cancelledFlatId?: string | null
    cancelledFlatDisplay?: string | null
    cancelledFloorNumber?: number | null
    cancelledFloorName?: string | null
  }
  flatNumber: number | null
  floorNumber: number
  flatStatus: string
  customFlatId?: string | null
  floorName?: string | null
  amountPaid: number
  remaining: number
}) {
  return {
    id: input.customer.id,
    name: input.customer.name,
    phone: input.customer.phone,
    email: input.customer.email,
    sellingPrice: input.customer.sellingPrice,
    bookingAmount: input.customer.bookingAmount,
    amountPaid: input.amountPaid,
    remaining: input.remaining,
    dealStatus: input.customer.dealStatus,
    customerType: input.customer.customerType,
    flatId: input.customer.flatId,
    flatNumber: input.flatNumber,
    floorNumber: input.floorNumber,
    flatStatus: input.flatStatus,
    customFlatId: input.customFlatId ?? null,
    floorName: input.floorName ?? null,
    cancelledAt: input.customer.cancelledAt ?? null,
    cancellationReason: input.customer.cancellationReason ?? null,
    cancelledByUserId: input.customer.cancelledByUserId ?? null,
    cancelledFromFlatStatus: input.customer.cancelledFromFlatStatus ?? null,
    cancelledFlatId: input.customer.cancelledFlatId ?? null,
    cancelledFlatDisplay: input.customer.cancelledFlatDisplay ?? null,
    cancelledFloorNumber: input.customer.cancelledFloorNumber ?? null,
    cancelledFloorName: input.customer.cancelledFloorName ?? null,
    createdAt: input.customer.createdAt,
  }
}

export function mapUpdatedCustomerResponse(input: {
  customer: CustomerForResponse
  amountPaid: number
  remaining: number
}) {
  const flatState = getCustomerFlatState(input.customer)
  const cancellationState = getCustomerCancellationState(input.customer)

  return {
    id: input.customer.id,
    name: input.customer.name,
    phone: input.customer.phone,
    email: input.customer.email,
    sellingPrice: input.customer.sellingPrice,
    bookingAmount: input.customer.bookingAmount,
    amountPaid: input.amountPaid,
    remaining: input.remaining,
    dealStatus: input.customer.dealStatus,
    customerType: input.customer.customerType,
    ...flatState,
    ...cancellationState,
    createdAt: input.customer.createdAt,
  }
}

export function mapCustomerPaymentHistoryItem(payment: {
  id: string
  amount: number | string | { toString(): string }
  direction: 'IN' | 'OUT'
  movementType: string
  paymentMode: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI' | null
  referenceNumber: string | null
  note: string | null
  postedAt: Date
}) {
  return {
    id: payment.id,
    amount: Number(payment.amount),
    direction: payment.direction,
    movementType: payment.movementType,
    paymentMode: payment.paymentMode,
    referenceNumber: payment.referenceNumber,
    note: payment.note,
    createdAt: payment.postedAt,
  }
}
