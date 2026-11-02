"use client";

import { operationsFetch } from "@/lib/operations-api";
import { t } from "@/i18n/runtime";

/**
 * One typed fetch for every customer service screen, plus the shapes the API
 * actually returns. Kept apart from the components so the case queue, the order
 * view and the refund queue cannot drift into three different ideas of a case.
 */

const API_PROXY_URL = "/api-proxy";

export type RequestOptions = RequestInit & {
  query?: Record<string, string | undefined>;
};

export async function serviceDeskRequest<T>(accessToken: string, path: string, options?: RequestOptions): Promise<T> {
  const url = new URL(`${API_PROXY_URL}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  const headers = new Headers(options?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await operationsFetch(url.toString(), { ...options, headers });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text || `Request failed: ${response.status}` };
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? String((body as { message?: unknown }).message)
      : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export type CaseStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
export type CasePriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type EscalationTarget = "FULFILLMENT" | "FINANCE" | "ADMIN";
export type RefundRequestStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "REFUNDED" | "CANCELLED";

export type CaseRow = {
  id: string;
  title: string;
  description?: string | null;
  issueType: string;
  caseType: string;
  priority: CasePriority;
  status: CaseStatus;
  escalated: boolean;
  escalatedTo?: EscalationTarget | null;
  escalationNote?: string | null;
  slaDueAt?: string | null;
  overdue?: boolean;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  assignedAdminUser?: { id: string; name: string } | null;
  createdByAdminUser?: { id: string; name: string } | null;
  afterSaleReturn?: { id: string; status: string } | null;
  refundRequests?: Array<{ id: string; status: RefundRequestStatus; amountKsh: number }>;
  customer?: { id: string; displayName?: string | null; email?: string | null; phone?: string | null } | null;
  order?: { id: string; orderNumber: string; status: string; totalKsh: number } | null;
  notes: Array<{ id: string; body: string; createdAt: string; authorAdminUser?: { name: string } | null }>;
};

export type Dashboard = {
  openCases: number;
  newToday: number;
  inProgress: number;
  resolvedToday: number;
  overdue: number;
  escalated: number;
  unassigned: number;
  paymentIssues: number;
  deliveryIssues: number;
  afterSales: number;
  pendingRefundRequests: number;
  byPriority: Partial<Record<CasePriority, number>>;
};

export type GlobalSearchResult = {
  search: string;
  customers: Array<{
    id: string;
    displayName?: string | null;
    email?: string | null;
    phone?: string | null;
    defaultAddress?: string | null;
    status: string;
    whatsAppUrl: string | null;
    _count: { orders: number; customerServiceCases: number };
    orders: Array<{
      id: string;
      orderNumber: string;
      status: string;
      totalKsh: number;
      createdAt: string;
      fulfillmentMethod: string;
      fulfillment?: { status: string; currentHolderLabel?: string | null } | null;
    }>;
  }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    totalKsh: number;
    createdAt: string;
    fulfillmentMethod: string;
    customer: { id: string; displayName?: string | null; phone?: string | null; email?: string | null };
    fulfillment?: { status: string; currentHolderLabel?: string | null } | null;
    _count: { customerServiceCases: number };
  }>;
};

export type Order360 = {
  customer: {
    id: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    whatsappPhone?: string | null;
    whatsAppUrl: string | null;
    defaultAddress?: string | null;
    status: string;
  };
  order: {
    id: string;
    orderNumber: string;
    status: string;
    fulfillmentMethod: string;
    deliveryAddress?: string | null;
    deliveryNote?: string | null;
    itemSubtotalKsh: number;
    deliveryFeeKsh: number;
    totalKsh: number;
    createdAt: string;
    node?: { id: string; code: string; name: string; address?: string | null; phone?: string | null } | null;
    items: Array<{
      id: string;
      title?: string | null;
      barcode?: string | null;
      sizeLabel?: string | null;
      imageUrl?: string | null;
      quantity: number;
      lineTotalKsh: number;
    }>;
  };
  payment: {
    status?: string | null;
    paidAt?: string | null;
    transactionReference?: string | null;
    amountKsh?: number | null;
    phone?: string | null;
    resultDescription?: string | null;
    attempts: Array<{
      status: string;
      amountKsh: number;
      phone: string;
      requestedAt: string;
      completedAt?: string | null;
      transactionReference?: string | null;
      resultDescription?: string | null;
    }>;
  };
  fulfillment: {
    status: string;
    node?: { id: string; code: string; name: string; phone?: string | null } | null;
    rider?: { id: string | null; name: string; phone?: string | null; type?: string | null } | null;
    holder: { type: string; label?: string | null };
    exceptionReason?: string | null;
    exceptionNote?: string | null;
    deliveryAttemptCount: number;
    deliveryFailureReason?: string | null;
    deliveryCodeSentCount: number;
    deliveryCodeIssuedAt?: string | null;
    customerCodeLockedAt?: string | null;
    completedAt?: string | null;
    latestUpdateAt: string;
  } | null;
  promoter?: {
    id: string;
    code: string;
    displayName?: string | null;
    phone?: string | null;
    status: string;
    source?: string | null;
    campaign?: string | null;
  } | null;
  cases: CaseRow[];
  notes: Array<{ id: string; body: string; createdAt: string; authorAdminUser?: { name: string } | null }>;
  returns: Array<{
    id: string;
    status: string;
    reason: string;
    requestedAt: string;
    returnNode?: { id: string; code: string; name: string } | null;
    orderItem?: { snapshot?: { title?: string | null; barcode?: string | null } | null } | null;
  }>;
  refundRequests: RefundRequestRow[];
  refunds: Array<{ id: string; amountKsh: number; externalReference: string; refundedAt: string }>;
  timeline: Array<{
    at: string;
    channel: "PAYMENT" | "FULFILLMENT" | "CUSTOMER_SERVICE";
    action: string;
    detail?: string | null;
    actor?: string | null;
  }>;
};

export type RefundRequestRow = {
  id: string;
  status: RefundRequestStatus;
  kind: string;
  amountKsh: number;
  reason: string;
  requestedAt: string;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  completedAt?: string | null;
  order?: { id: string; orderNumber: string; totalKsh: number; customer?: { displayName?: string | null; phone?: string | null } | null } | null;
  serviceCase?: { id: string; title: string; status: string } | null;
  /** Set when the refund is for a returned item; the photos were taken when it was accepted. */
  afterSaleReturn?: { id: string; status: string; photos: Array<{ id: string; contentType: string; sizeBytes: number; createdAt: string }> } | null;
  requestedByAdminUser?: { name: string } | null;
  reviewedByAdminUser?: { name: string } | null;
  refundRecord?: { externalReference: string; refundedAt: string; amountKsh: number } | null;
};

export type Assignee = { id: string; name: string; openCases: number };

export type CaseOptions = {
  groups: Array<{ group: string; caseTypes: string[] }>;
  slaHours: Record<CasePriority, number>;
};

export function money(value: number | null | undefined): string {
  if (typeof value !== "number") return "-";
  return `${Math.round(value).toLocaleString("en-KE")} KSh`;
}

export function when(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}

/** "2 小时后" / "已逾期 3 小时" — how an agent reads a deadline. */
export function slaLabel(slaDueAt: string | null | undefined, overdue?: boolean): string {
  if (!slaDueAt) return "-";
  const due = new Date(slaDueAt).getTime();
  if (!Number.isFinite(due)) return "-";
  const diffHours = Math.round(Math.abs(due - Date.now()) / 3_600_000);
  if (overdue || due <= Date.now()) return t("已逾期 {hours} 小时", { hours: diffHours });
  return t("剩余 {hours} 小时", { hours: diffHours });
}

export const CASE_TYPE_LABELS: Record<string, string> = {
  PAYMENT_FAILED: "支付失败",
  PAID_BUT_ORDER_MISSING: "已付款但没有订单",
  DUPLICATE_PAYMENT: "重复付款",
  PAYMENT_PENDING: "支付卡在处理中",
  WRONG_AMOUNT: "金额不对",
  ORDER_LATE: "配送延迟",
  CUSTOMER_UNREACHABLE: "联系不上顾客",
  WRONG_ADDRESS: "地址错误",
  RIDER_ISSUE: "骑手问题",
  PACKAGE_MISSING: "包裹丢失",
  DELIVERY_CODE_NOT_RECEIVED: "没收到配送码",
  WRONG_ITEM: "发错商品",
  DAMAGED_ITEM: "商品破损",
  MISSING_ITEM: "商品缺件",
  SIZE_ISSUE: "尺码问题",
  PRODUCT_NOT_AS_EXPECTED: "实物与描述不符",
  RETURN_REQUEST: "退货申请",
  EXCHANGE_REQUEST: "换货申请",
  REFUND_REQUEST: "退款申请",
  OTHER: "其他"
};

export const CASE_GROUP_LABELS: Record<string, string> = {
  PAYMENT: "支付",
  DELIVERY: "配送",
  PRODUCT: "商品",
  AFTER_SALES: "售后",
  OTHER: "其他"
};

export const PRIORITY_LABELS: Record<CasePriority, string> = {
  URGENT: "紧急",
  HIGH: "高",
  NORMAL: "普通",
  LOW: "低"
};

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  OPEN: "未处理",
  IN_PROGRESS: "处理中",
  RESOLVED: "已解决",
  CLOSED: "已关闭"
};

export const ESCALATION_LABELS: Record<EscalationTarget, string> = {
  FULFILLMENT: "履约",
  FINANCE: "财务",
  ADMIN: "管理员"
};

export const REFUND_STATUS_LABELS: Record<RefundRequestStatus, string> = {
  PENDING_APPROVAL: "待审批",
  APPROVED: "已批准，待打款",
  REJECTED: "已驳回",
  REFUNDED: "已退款",
  CANCELLED: "已撤回"
};
