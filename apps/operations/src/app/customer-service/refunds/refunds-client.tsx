"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";

import { useOperationsSession } from "@/components/admin/operations-access-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ReturnPhotoStrip } from "@/app/orders/after-sales-panel";
import { t } from "@/i18n/runtime";

import {
  REFUND_STATUS_LABELS,
  money,
  serviceDeskRequest,
  when,
  type RefundRequestRow,
  type RefundRequestStatus
} from "../service-desk-api";

/**
 * The refund queue, from both sides of the desk.
 *
 * Customer service sees where its requests have got to and can withdraw one it
 * raised by mistake. Finance approves or rejects, then -- separately, after
 * actually paying the customer in the M-Pesa portal -- records the reference.
 * Nothing on this page moves money by itself.
 */
export function CustomerServiceRefundsPage() {
  const { session, hasPermission } = useOperationsSession();
  const accessToken = session?.accessToken ?? "";
  const canApprove = hasPermission("customer-service.refund-approve");
  const canRecord = canApprove && hasPermission("orders.refund");
  const canCancel = hasPermission("customer-service.refund-request");

  const [requests, setRequests] = useState<RefundRequestRow[]>([]);
  const [status, setStatus] = useState<string>("PENDING_APPROVAL");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recording, setRecording] = useState<{ id: string; externalReference: string; evidenceNote: string; refundedAt: string } | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setBusy(true);
    setError("");
    try {
      setRequests(await serviceDeskRequest<RefundRequestRow[]>(accessToken, "/operations/customer-service/refund-requests", {
        query: { status: status || undefined }
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取退款申请。"));
    } finally {
      setBusy(false);
    }
  }, [accessToken, status]);

  useEffect(() => { void load(); }, [load]);

  async function act(path: string, body: unknown, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await serviceDeskRequest(accessToken, path, { method: "POST", body: JSON.stringify(body) });
      setMessage(success);
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("操作失败。"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-sm">{t("客户服务")}</p>
          <h1 className="font-semibold text-2xl tracking-tight">{t("退款审批")}</h1>
          <p className="max-w-3xl text-muted-foreground text-sm">
            {t("客服提出申请，财务审批，批准之后财务先在 M-Pesa 实际打款，再回到这里登记参考号。系统本身不会发起任何转账。")}
          </p>
          <p className="max-w-3xl text-muted-foreground text-sm">
            {t("退货产生的退款申请会在仓库验收退货后自动出现，附带验收照片。批准之后，退款要在订单页的退货卡片里登记，这样佣金和退货状态才会一起更新。")}
          </p>
        </div>
        <div className="flex gap-2">
          <NativeSelect value={status} onChange={(event) => setStatus(event.target.value)}>
            <NativeSelectOption value="">{t("全部")}</NativeSelectOption>
            {(Object.keys(REFUND_STATUS_LABELS) as RefundRequestStatus[]).map((key) => (
              <NativeSelectOption key={key} value={key}>{t(REFUND_STATUS_LABELS[key])}</NativeSelectOption>
            ))}
          </NativeSelect>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            <RefreshCwIcon data-icon="inline-start" />
            {t("刷新")}
          </Button>
        </div>
      </div>

      {message ? <StatusMessage>{message}</StatusMessage> : null}
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}

      <Card>
        <CardHeader><CardTitle>{t("退款申请")} ({requests.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {[t("状态"), t("订单"), t("顾客"), t("金额"), t("原因"), t("申请人"), t("审批人"), t("M-Pesa 参考号"), t("操作")].map((header) => (
                  <TableHead key={header}>{header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-28 text-center text-muted-foreground">{t("没有符合条件的退款申请。")}</TableCell>
                </TableRow>
              ) : requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>
                    <Badge variant={request.status === "PENDING_APPROVAL" ? "destructive" : request.status === "REFUNDED" ? "outline" : "secondary"}>
                      {t(REFUND_STATUS_LABELS[request.status] ?? request.status)}
                    </Badge>
                    <div className="mt-1 text-muted-foreground text-xs">{when(request.requestedAt)}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {request.order ? (
                      <Link href={`/customer-service/orders/${request.order.id}`} className="underline">{request.order.orderNumber}</Link>
                    ) : "-"}
                    <div className="text-muted-foreground">{money(request.order?.totalKsh)}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div>{request.order?.customer?.displayName || t("访客顾客")}</div>
                    <div className="font-mono text-muted-foreground">{request.order?.customer?.phone ?? "-"}</div>
                  </TableCell>
                  <TableCell className="font-medium">{money(request.amountKsh)}</TableCell>
                  <TableCell className="max-w-56 text-xs">
                    <div>{request.reason}</div>
                    {request.afterSaleReturn && request.order ? (
                      <div className="mt-2">
                        {request.afterSaleReturn.photos.length > 0
                          ? <ReturnPhotoStrip orderId={request.order.id} returnId={request.afterSaleReturn.id} photos={request.afterSaleReturn.photos} token={accessToken} />
                          : <p className="text-muted-foreground">{t("这笔退货验收时没有拍照（较早的记录）。")}</p>}
                      </div>
                    ) : null}
                    {request.reviewNote ? <div className="text-muted-foreground">{t("审批意见")}: {request.reviewNote}</div> : null}
                  </TableCell>
                  {/* A lapsed deposit hold is raised by the expiry sweep, not
                      by a person. Showing "-" reads like missing data; naming
                      the system says the debt is real and nobody forgot it. */}
                  <TableCell className="text-xs">{request.requestedByAdminUser?.name ?? t("系统自动")}</TableCell>
                  <TableCell className="text-xs">
                    {request.reviewedByAdminUser?.name ?? "-"}
                    {request.reviewedAt ? <div className="text-muted-foreground">{when(request.reviewedAt)}</div> : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {request.refundRecord?.externalReference ?? "-"}
                    {request.refundRecord ? <div className="text-muted-foreground">{when(request.refundRecord.refundedAt)}</div> : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {canApprove && request.status === "PENDING_APPROVAL" ? (
                        <>
                          <Button size="sm" disabled={busy} onClick={() => {
                            const reviewNote = window.prompt(t("批准理由？"));
                            if (!reviewNote) return;
                            void act(`/operations/customer-service/refund-requests/${request.id}/review`, { approved: true, reviewNote }, t("退款申请已批准。"));
                          }}>{t("批准")}</Button>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                            const reviewNote = window.prompt(t("驳回理由？"));
                            if (!reviewNote) return;
                            void act(`/operations/customer-service/refund-requests/${request.id}/review`, { approved: false, reviewNote }, t("退款申请已驳回。"));
                          }}>{t("驳回")}</Button>
                        </>
                      ) : null}
                      {request.afterSaleReturn && request.order && request.status === "APPROVED" ? (
                        <Link href={`/orders/${request.order.id}`} className="text-xs underline">{t("退货退款请在订单页登记")}</Link>
                      ) : null}
                      {canRecord && request.status === "APPROVED" && !request.afterSaleReturn ? (
                        <Button size="sm" disabled={busy} onClick={() => setRecording({
                          id: request.id, externalReference: "", evidenceNote: "", refundedAt: new Date().toISOString().slice(0, 16)
                        })}>{t("登记已打款")}</Button>
                      ) : null}
                      {canCancel && request.status === "PENDING_APPROVAL" ? (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => {
                          const reason = window.prompt(t("撤回理由？"));
                          if (!reason) return;
                          void act(`/operations/customer-service/refund-requests/${request.id}/cancel`, { reason }, t("退款申请已撤回。"));
                        }}>{t("撤回")}</Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {recording ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("登记已执行的退款")}</CardTitle>
            <CardDescription>{t("先在 M-Pesa 后台实际打款，再回来登记。参考号必须和对账单一致。")}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>{t("M-Pesa 参考号")}</FieldLabel>
                <Input value={recording.externalReference} onChange={(event) => setRecording({ ...recording, externalReference: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>{t("实际打款时间")}</FieldLabel>
                <Input type="datetime-local" value={recording.refundedAt} onChange={(event) => setRecording({ ...recording, refundedAt: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>{t("核验凭证说明")}</FieldLabel>
                <Textarea value={recording.evidenceNote} onChange={(event) => setRecording({ ...recording, evidenceNote: event.target.value })} />
              </Field>
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={busy || !recording.externalReference.trim() || !recording.evidenceNote.trim()}
                  onClick={() => void act(
                    `/operations/customer-service/refund-requests/${recording.id}/complete`,
                    {
                      externalReference: recording.externalReference,
                      evidenceNote: recording.evidenceNote,
                      refundedAt: new Date(recording.refundedAt).toISOString()
                    },
                    t("退款已登记。")
                  ).then((ok) => { if (ok) setRecording(null); })}
                >
                  {t("登记")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setRecording(null)}>{t("取消")}</Button>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function StatusMessage({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <div className={cn("rounded-lg border p-3 text-sm", tone === "danger" ? "border-destructive/30 bg-destructive/10 text-destructive" : "bg-muted")}>
      {children}
    </div>
  );
}
