"use client";

import { useState } from "react";
import { ArrowLeftRightIcon } from "lucide-react";

import { hasPermission, type OperationsSession } from "@/components/admin/operations-access";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { operationsFetch } from "@/lib/operations-api";
import { t } from "@/i18n/runtime";

/**
 * The 换货 card on the order page: swap one garment on a paid order for another.
 *
 * Step 1 covers a paid order that has not started picking, and a new garment at
 * exactly the same price. The server decides everything; this card only collects
 * which item, the new barcode and the reason, and shows the server's message when
 * the swap is refused.
 */

type ExchangeOrder = {
  id: string;
  status: string;
  items: Array<{ id: string; unitPriceKsh: number; snapshot?: { title: string; barcode?: string | null } | null }>;
};

export function ExchangePanel({ order, session, onOrderChanged }: { order: ExchangeOrder; session: OperationsSession | null; onOrderChanged: () => Promise<void> }) {
  const accessToken = session?.accessToken ?? "";
  const [orderItemId, setOrderItemId] = useState(order.items[0]?.id ?? "");
  const [newBarcode, setNewBarcode] = useState("");
  const [reason, setReason] = useState("");
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpCode, setTopUpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  if (!hasPermission(session, "orders.after-sale") || order.status !== "PAID") return null;

  async function submit() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = await operationsFetch(`/api-proxy/operations/orders/${encodeURIComponent(order.id)}/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ orderItemId, newBarcode: newBarcode.trim(), reason: reason.trim(), topUpAmountKsh: topUpAmount.trim() ? Number(topUpAmount) : undefined, topUpMpesaCode: topUpCode.trim() || undefined })
      });
      const text = await response.text();
      let result: { message?: unknown } = {};
      try { result = text ? JSON.parse(text) : {}; } catch { result = {}; }
      if (!response.ok) {
        const message = Array.isArray(result.message) ? result.message.join("；") : result.message;
        throw new Error(typeof message === "string" ? message : t("换货失败 ({status})", { status: response.status }));
      }
      setSuccess(t("已换货。拣货单已更新为新衣服。"));
      setNewBarcode("");
      setReason("");
      setTopUpAmount("");
      setTopUpCode("");
      await onOrderChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("换货失败，请刷新后再试。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ArrowLeftRightIcon className="size-4" />{t("换货")}</CardTitle>
        <CardDescription>{t("把订单里的一件衣服换成另一件同价或更贵的衣服。只适用于已付款、还没开始拣货的订单。换更便宜的请走退货退款；已送达的订单暂不支持。")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t("要换掉的衣服")}
          <select className="border-input bg-background h-9 rounded-md border px-2" value={orderItemId} onChange={(event) => setOrderItemId(event.target.value)}>
            {order.items.map((item) => (
              <option key={item.id} value={item.id}>{item.snapshot?.title ?? item.id} · {item.snapshot?.barcode ?? ""} · KSh {item.unitPriceKsh}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("新衣服的条码")}
          <Input value={newBarcode} onChange={(event) => setNewBarcode(event.target.value)} placeholder={t("扫码或输入新衣服的条码")} />
        </label>
        <div className="rounded-md border p-3 text-sm">
          <p className="text-muted-foreground mb-2">{t("新衣服更贵时，先向顾客收取差价（M-Pesa），再填写下面两项。同价换货留空。")}</p>
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
        <label className="flex flex-col gap-1 text-sm">
          {t("换货原因")}
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
        </label>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {success ? <Alert><AlertDescription>{success}</AlertDescription></Alert> : null}
        <div>
          <Button disabled={busy || !orderItemId || newBarcode.trim().length === 0 || reason.trim().length < 3} onClick={() => void submit()}>
            {t("确认换货")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
