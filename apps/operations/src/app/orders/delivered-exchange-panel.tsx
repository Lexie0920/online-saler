"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRightIcon } from "lucide-react";

import { hasPermission, type OperationsSession } from "@/components/admin/operations-access";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { operationsFetch } from "@/lib/operations-api";
import { compressPhoto, photoSlotsLeft } from "@/lib/return-photo";
import { t } from "@/i18n/runtime";
import { ReturnPhotoStrip, type ReturnPhoto } from "./after-sales-panel";

/**
 * The exchange card for an order the customer already has (completed, within 3 days).
 *
 * The customer brings the old garment to the counter and takes the new one. Steps:
 * request (the new garment is held), photograph and receive the old garment, then a
 * different person approves, which swaps the order line and puts the old garment back
 * on a shelf. The server decides every rule; this card collects the inputs and shows
 * the server's message when something is refused.
 */

type ExchangeStatus = "COMPLETED" | "AWAITING_RETURN" | "PENDING_REVIEW" | "REJECTED" | "CANCELLED";
type ExchangeRow = {
  id: string;
  orderItemId: string;
  kind: "STANDARD" | "RETURN_TO_EXCHANGE";
  status: ExchangeStatus;
  oldPriceKsh: number;
  newPriceKsh: number;
  topUpKsh: number;
  discountKsh: number;
  reason: string;
  photos: ReturnPhoto[];
  createdAt: string;
};
type ExchangeOrder = {
  id: string;
  status: string;
  items: Array<{ id: string; unitPriceKsh: number; snapshot?: { title: string; barcode?: string | null } | null }>;
};

async function call<T>(path: string, token: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const response = await operationsFetch(`/api-proxy/operations/orders/${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let result: { message?: unknown } = {};
  try { result = text ? JSON.parse(text) : {}; } catch { result = {}; }
  if (!response.ok) {
    const message = Array.isArray(result.message) ? result.message.join("；") : result.message;
    throw new Error(typeof message === "string" ? message : t("换货操作失败 ({status})", { status: response.status }));
  }
  return result as T;
}

const STATUS_LABEL: Record<ExchangeStatus, string> = {
  COMPLETED: "已完成",
  AWAITING_RETURN: "等待收回旧衣服",
  PENDING_REVIEW: "等待审核",
  REJECTED: "审核未通过",
  CANCELLED: "已取消"
};

export function DeliveredExchangePanel({ order, session, onOrderChanged }: { order: ExchangeOrder; session: OperationsSession | null; onOrderChanged: () => Promise<void> }) {
  const token = session?.accessToken ?? "";
  const canView = hasPermission(session, "orders.view");
  const canOperate = hasPermission(session, "orders.after-sale");
  const canApprove = canOperate && hasPermission(session, "action.customer-service.approve");
  const [rows, setRows] = useState<ExchangeRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [orderItemId, setOrderItemId] = useState(order.items[0]?.id ?? "");
  const [newBarcode, setNewBarcode] = useState("");
  const [reason, setReason] = useState("");
  const [returnToExchange, setReturnToExchange] = useState(false);
  const [discountReason, setDiscountReason] = useState("");
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpCode, setTopUpCode] = useState("");

  const load = useCallback(async () => {
    if (!token || !canView) return;
    try {
      const result = await call<{ exchanges: ExchangeRow[] }>(`${encodeURIComponent(order.id)}/exchanges`, token, "GET");
      setRows(result.exchanges);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取换货记录。"));
    }
  }, [token, canView, order.id]);
  useEffect(() => { void load(); }, [load]);

  if (order.status !== "COMPLETED" || !canView) return null;

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await action();
      setSuccess(done);
      await load();
      await onOrderChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("换货操作失败，请刷新后再试。"));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    await run(async () => {
      await call(`${encodeURIComponent(order.id)}/exchanges`, token, "POST", {
        orderItemId,
        newBarcode: newBarcode.trim(),
        reason: reason.trim(),
        returnToExchange,
        discountReason: returnToExchange ? discountReason.trim() : undefined,
        topUpAmountKsh: topUpAmount.trim() ? Number(topUpAmount) : undefined,
        topUpMpesaCode: topUpCode.trim() || undefined
      });
      setNewBarcode(""); setReason(""); setReturnToExchange(false); setDiscountReason(""); setTopUpAmount(""); setTopUpCode("");
    }, t("已登记换货，新衣服已预留。请顾客把旧衣服交回柜台。"));
  }

  const titleOf = (itemId: string) => order.items.find((item) => item.id === itemId)?.snapshot?.title ?? itemId;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ArrowLeftRightIcon className="size-4" />{t("已送达订单换货")}</CardTitle>
        <CardDescription>{t("订单完成后 3 天内可换。顾客把旧衣服交回柜台并拍照，另一位有审核权限的同事批准后，旧衣服重新上架，新衣服交给顾客。")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length > 0 ? (
          <div className="flex flex-col gap-3">
            {rows.map((row) => (
              <ExchangeRowCard key={row.id} row={row} orderId={order.id} title={titleOf(row.orderItemId)} token={token} canOperate={canOperate} canApprove={canApprove} busy={busy} run={run} />
            ))}
          </div>
        ) : null}
        {canOperate ? (
          <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
            <p className="font-medium">{t("登记新的换货")}</p>
            <label className="flex flex-col gap-1">
              {t("要换掉的衣服")}
              <select className="border-input bg-background h-9 rounded-md border px-2" value={orderItemId} onChange={(event) => setOrderItemId(event.target.value)}>
                {order.items.map((item) => <option key={item.id} value={item.id}>{item.snapshot?.title ?? item.id} · KSh {item.unitPriceKsh}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              {t("新衣服的条码")}
              <Input value={newBarcode} onChange={(event) => setNewBarcode(event.target.value)} placeholder={t("扫码或输入新衣服的条码")} />
            </label>
            <label className="flex flex-col gap-1">
              {t("换货原因")}
              <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
            </label>
            {canApprove ? (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={returnToExchange} onChange={(event) => setReturnToExchange(event.target.checked)} />
                  {t("退货转换货（差价减免 KSh 80，每单一次）")}
                </label>
                {returnToExchange ? <Input value={discountReason} onChange={(event) => setDiscountReason(event.target.value)} placeholder={t("为什么按退货转换货处理")} /> : null}
              </div>
            ) : null}
            <div className="rounded-md border p-3">
              <p className="text-muted-foreground mb-2">{t("顾客需要补差价时，先收款（M-Pesa），再填写金额和交易码。无需补款留空。")}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  {t("补差价金额（KSh）")}
                  <Input inputMode="numeric" value={topUpAmount} onChange={(event) => setTopUpAmount(event.target.value.replace(/[^0-9]/g, ""))} />
                </label>
                <label className="flex flex-col gap-1">
                  {t("补差价的 M-Pesa 交易码")}
                  <Input value={topUpCode} onChange={(event) => setTopUpCode(event.target.value)} />
                </label>
              </div>
            </div>
            <div>
              <Button disabled={busy || !orderItemId || newBarcode.trim().length === 0 || reason.trim().length < 3 || (returnToExchange && discountReason.trim().length < 3)} onClick={() => void submit()}>{t("登记换货")}</Button>
            </div>
          </div>
        ) : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {success ? <Alert><AlertDescription>{success}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

function ExchangeRowCard(props: {
  row: ExchangeRow;
  orderId: string;
  title: string;
  token: string;
  canOperate: boolean;
  canApprove: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const { row, orderId, title, token, canOperate, canApprove, busy, run } = props;
  const [photos, setPhotos] = useState<ReturnPhoto[]>(row.photos);
  const [uploading, setUploading] = useState(0);
  const [photoError, setPhotoError] = useState("");
  const [scanned, setScanned] = useState("");
  const [note, setNote] = useState("");
  const [shelf, setShelf] = useState("");
  const base = `${encodeURIComponent(orderId)}/exchanges/${encodeURIComponent(row.id)}`;

  async function addPhotos(files: FileList | null) {
    if (!files) return;
    setPhotoError("");
    const picked = Array.from(files).slice(0, photoSlotsLeft(photos.length));
    for (const file of picked) {
      setUploading((count) => count + 1);
      try {
        const blob = await compressPhoto(file);
        const response = await operationsFetch(`/api-proxy/operations/orders/${base}/photos`, {
          method: "POST",
          headers: { "Content-Type": blob.type || "image/jpeg", Authorization: `Bearer ${token}` },
          body: blob
        });
        const result = await response.json().catch(() => ({})) as { photo?: ReturnPhoto; message?: unknown };
        if (!response.ok || !result.photo) {
          const message = Array.isArray(result.message) ? result.message.join("；") : result.message;
          throw new Error(typeof message === "string" ? message : t("照片上传失败，请重试。"));
        }
        const added = result.photo;
        setPhotos((current) => [...current, added]);
      } catch (caught) {
        setPhotoError(caught instanceof Error ? caught.message : t("照片上传失败，请重试。"));
      } finally {
        setUploading((count) => count - 1);
      }
    }
  }

  const open = row.status === "AWAITING_RETURN" || row.status === "PENDING_REVIEW" || row.status === "REJECTED";
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        <Badge variant="outline">{t(STATUS_LABEL[row.status])}</Badge>
        {row.kind === "RETURN_TO_EXCHANGE" ? <Badge variant="secondary">{t("退货转换货")}</Badge> : null}
      </div>
      <p className="text-muted-foreground">
        {t("原价 KSh {old}，新衣服 KSh {new}，顾客补款 KSh {topUp}，减免 KSh {discount}", { old: row.oldPriceKsh, new: row.newPriceKsh, topUp: row.topUpKsh, discount: row.discountKsh })}
      </p>
      <p>{row.reason}</p>

      {photos.length > 0 ? <ReturnPhotoStrip orderId={orderId} returnId={row.id} photos={photos} token={token} basePath="exchanges" /> : null}

      {row.status === "AWAITING_RETURN" && canOperate ? (
        <div className="flex flex-col gap-2">
          {photoSlotsLeft(photos.length) > 0 ? <Input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || uploading > 0} onChange={(event) => { void addPhotos(event.target.files); event.target.value = ""; }} /> : null}
          <p role="status">{uploading > 0 ? t("上传中…") : t("已上传 {count} 张", { count: photos.length })}</p>
          {photoError ? <p className="text-destructive">{photoError}</p> : null}
          <Input value={scanned} onChange={(event) => setScanned(event.target.value)} placeholder={t("扫码旧衣服的条码")} />
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder={t("验收说明")} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || uploading > 0 || photos.length < 1 || !scanned.trim() || note.trim().length < 3} onClick={() => void run(() => call(`${base}/receive`, token, "POST", { receivedBarcode: scanned.trim(), note: note.trim() }), t("已收回旧衣服，等待审核。"))}>{t("确认收回旧衣服")}</Button>
          </div>
        </div>
      ) : null}

      {row.status === "PENDING_REVIEW" && canApprove ? (
        <div className="flex flex-col gap-2">
          <Input value={shelf} onChange={(event) => setShelf(event.target.value)} placeholder={t("旧衣服放回的货架编号")} />
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder={t("审核说明")} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !shelf.trim() || note.trim().length < 3} onClick={() => void run(() => call(`${base}/review`, token, "POST", { approved: true, note: note.trim(), locationCode: shelf.trim() }), t("已批准，订单已换成新衣服，旧衣服已重新上架。"))}>{t("批准换货")}</Button>
            <Button variant="outline" disabled={busy || note.trim().length < 3} onClick={() => void run(() => call(`${base}/review`, token, "POST", { approved: false, note: note.trim() }), t("已标记为审核未通过，新衣服仍预留，请客服联系顾客。"))}>{t("不通过")}</Button>
          </div>
        </div>
      ) : null}

      {open && canOperate ? (
        <div className="flex flex-col gap-2">
          {row.status === "AWAITING_RETURN" ? null : <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder={t("取消原因")} />}
          <div>
            <Button variant="outline" disabled={busy || note.trim().length < 3} onClick={() => void run(() => call(`${base}/cancel`, token, "POST", { note: note.trim() }), row.topUpKsh > 0 ? t("已取消，新衣服已释放。顾客补的 KSh {amount} 需手动退回。", { amount: row.topUpKsh }) : t("已取消，新衣服已释放。"))}>{t("取消换货并释放新衣服")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
