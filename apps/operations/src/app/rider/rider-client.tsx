"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraIcon, CheckCircle2Icon, PhoneCallIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { useOperationsSession } from "@/components/admin/operations-access-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatMoment, operationsRequester } from "@/lib/operations-request";
import { t } from "@/i18n/runtime";

/**
 * The rider's phone screen. One page, big buttons, thumb-sized targets: a rider
 * is standing at a gate in the sun, not sitting at a desk.
 *
 * It shows only what is needed to find the customer. There is no order total, no
 * commission, no product cost, and no delivery code -- the code exists only in
 * the customer's SMS, and the rider types in what the customer reads out.
 */

type RiderDelivery = {
  orderId: string;
  orderNumber: string;
  packageCode: string | null;
  status: string;
  itemCount: number;
  items: Array<{ title: string; sizeLabel: string | null }>;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  deliveryNote: string | null;
  nodeName: string | null;
  dispatchedAt: string | null;
  deliveryAttemptCount: number;
  codeAttemptsRemaining: number;
  codeLocked: boolean;
  failureReason: string | null;
  completedAt: string | null;
  /** This delivery's pay, 50 or 100 KSh; null on parcels handed over before fees existed. */
  riderFeeKsh: number | null;
};

type RiderBoard = {
  rider: { id: string; name: string };
  counts: { awaitingDelivery: number; completedToday: number; failedToday: number };
  /** The rider's own pay (2026-10-14 weekly payouts). Older API builds omit it. */
  pay?: {
    earnedThisWeekKsh: number;
    earnedThisWeekCount: number;
    unsettledKsh: number;
    unsettledCount: number;
    settledThisWeekKsh: number;
    lastPayout: { amountKsh: number; mpesaCode: string; paidAt: string; itemCount: number } | null;
  };
  deliveries: RiderDelivery[];
};

const FAILURE_REASONS = [
  { value: "NO_ANSWER", label: "顾客没有应答" },
  { value: "PHONE_UNREACHABLE", label: "电话打不通" },
  { value: "WRONG_ADDRESS", label: "地址不对 / 找不到" },
  { value: "CUSTOMER_REQUESTED_LATER", label: "顾客要求改时间" },
  { value: "CUSTOMER_REFUSED", label: "顾客拒收" },
  { value: "OTHER", label: "其他" }
] as const;

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export function RiderDeliveriesPage() {
  const { session, hasPermission } = useOperationsSession();
  const accessToken = session?.accessToken ?? "";
  const isRider = hasPermission("rider.deliveries");

  const [board, setBoard] = useState<RiderBoard | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, { dataUrl: string; contentType: string }>>({});
  const [mode, setMode] = useState<Record<string, "deliver" | "drop-off" | "failed">>({});

  const request = useMemo(() => operationsRequester(accessToken), [accessToken]);

  const load = useCallback(async () => {
    if (!accessToken || !isRider) return;
    setLoading(true);
    setError("");
    try {
      setBoard(await request<RiderBoard>("/operations/rider/deliveries"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取你的配送单。"));
    } finally {
      setLoading(false);
    }
  }, [accessToken, isRider, request]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(orderId: string, path: string, body: Record<string, unknown>, success: string) {
    setBusyId(orderId);
    setError("");
    setMessage("");
    try {
      await request(`/operations/rider/deliveries/${orderId}/${path}`, { method: "POST", body: JSON.stringify(body) });
      setMessage(success);
      // A used code must never linger in a field where the next tap could resend it.
      setCodes((current) => ({ ...current, [orderId]: "" }));
      setPhotos((current) => ({ ...current, [orderId]: undefined as never }));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("操作失败，请再试一次。"));
    } finally {
      setBusyId("");
    }
  }

  if (!isRider) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("这个页面是给骑手的")}</CardTitle>
          <CardDescription>{t("你的账号没有骑手权限。如果你是骑手，请让门店员工在门店骑手名单里把你的登录账号绑定上。")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* One line, on a bike, in daylight. A rider needs the number still to do
          and nothing else: yesterday's tally is a manager's question, and the
          screen it was taking up is the screen the next address goes on. */}
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <p className="font-bold text-2xl tabular-nums">
            {board?.counts.awaitingDelivery ?? 0}
            <span className="ml-2 font-normal text-base text-muted-foreground">{t("待配送")}</span>
          </p>
          <p className="truncate text-muted-foreground text-sm">{board?.rider.name ?? "—"}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCwIcon className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {board?.pay ? (
        <div className="flex flex-col gap-0.5 rounded-md border px-3 py-2 text-sm" aria-label={t("骑手费结算")}>
          <p>
            {t("本周已结算 KSh {settled} · 待结算 KSh {unsettled}（{count} 单）", {
              settled: board.pay.settledThisWeekKsh,
              unsettled: board.pay.unsettledKsh,
              count: board.pay.unsettledCount
            })}
          </p>
          {board.pay.lastPayout ? (
            <p className="text-muted-foreground text-xs">
              {t("上次到账 KSh {amount} · M-Pesa {code} · {date}", {
                amount: board.pay.lastPayout.amountKsh,
                code: board.pay.lastPayout.mpesaCode,
                date: formatMoment(board.pay.lastPayout.paidAt)
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-destructive text-sm px-1">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-600 px-1">{message}</p> : null}

      {board && board.deliveries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t("现在没有配送单。门店派单以后会出现在这里。")}
          </CardContent>
        </Card>
      ) : null}

      {board?.deliveries.map((delivery) => {
        const current = mode[delivery.orderId] ?? "deliver";
        const busy = busyId === delivery.orderId;
        const code = codes[delivery.orderId] ?? "";
        const photo = photos[delivery.orderId];
        const failed = delivery.status === "DELIVERY_FAILED";
        const returning = delivery.status === "RETURNING_TO_NODE";

        return (
          <Card key={delivery.orderId}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-lg font-mono">{delivery.orderNumber}</CardTitle>
                {failed ? <Badge variant="destructive">{t("配送失败")}</Badge> : null}
                {returning ? <Badge variant="outline">{t("正在送回门店")}</Badge> : null}
                {delivery.deliveryAttemptCount > 1 ? (
                  <Badge variant="outline">{t("第")} {delivery.deliveryAttemptCount} {t("次尝试")}</Badge>
                ) : null}
              </div>
              <CardDescription>
                {delivery.itemCount} {t("件")}
                {delivery.nodeName ? ` · ${delivery.nodeName}` : ""}
                {delivery.dispatchedAt ? ` · ${formatMoment(delivery.dispatchedAt)}` : ""}
              </CardDescription>
              {delivery.riderFeeKsh ? (
                // Earned once the customer's code closes the delivery.
                <p className="font-semibold text-base">{t("本单骑手费 KSh {fee}", { fee: delivery.riderFeeKsh })}</p>
              ) : null}
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
              <div className="rounded-lg border p-3 text-sm flex flex-col gap-1">
                <span className="font-semibold text-base">{delivery.customerName ?? t("顾客")}</span>
                <span className="text-muted-foreground">{delivery.deliveryAddress ?? t("地址未填写")}</span>
                {delivery.deliveryNote ? <span className="text-muted-foreground">{delivery.deliveryNote}</span> : null}
                <span className="text-muted-foreground text-xs">
                  {delivery.items.map((item) => `${item.title}${item.sizeLabel ? ` (${item.sizeLabel})` : ""}`).join("、")}
                </span>
              </div>

              {delivery.customerPhone ? (
                <Button asChild variant="outline" className="h-12 text-base">
                  <a href={`tel:${delivery.customerPhone}`}>
                    <PhoneCallIcon /> {t("打给顾客")} {delivery.customerPhone}
                  </a>
                </Button>
              ) : null}

              {returning ? (
                <p className="text-sm text-muted-foreground">
                  {t("把包裹交回门店，店员扫码签收后这单会回到待派单。")}
                </p>
              ) : failed ? (
                <Button
                  className="h-12 text-base"
                  disabled={busy}
                  onClick={() => void act(delivery.orderId, "return", { note: notes[delivery.orderId] ?? "" }, t("已标记为正在送回门店。"))}
                >
                  {t("我现在把货送回门店")}
                </Button>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                    <ModeTab active={current === "deliver"} onClick={() => setMode((v) => ({ ...v, [delivery.orderId]: "deliver" }))}>
                      {t("送达")}
                    </ModeTab>
                    <ModeTab active={current === "drop-off"} onClick={() => setMode((v) => ({ ...v, [delivery.orderId]: "drop-off" }))}>
                      {t("代收")}
                    </ModeTab>
                    <ModeTab active={current === "failed"} onClick={() => setMode((v) => ({ ...v, [delivery.orderId]: "failed" }))}>
                      {t("没送成")}
                    </ModeTab>
                  </div>

                  {current === "failed" ? (
                    <div className="flex flex-col gap-3">
                      <NativeSelect
                        value={reasons[delivery.orderId] ?? "NO_ANSWER"}
                        onChange={(event) => setReasons((v) => ({ ...v, [delivery.orderId]: event.target.value }))}
                      >
                        {FAILURE_REASONS.map((reason) => (
                          <NativeSelectOption key={reason.value} value={reason.value}>{t(reason.label)}</NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Textarea
                        className="min-h-16"
                        placeholder={t("说明（可选）")}
                        value={notes[delivery.orderId] ?? ""}
                        onChange={(event) => setNotes((v) => ({ ...v, [delivery.orderId]: event.target.value }))}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("顾客已经付过钱了，这单不会取消。标记失败以后把货送回门店，门店会重新派单。")}
                      </p>
                      <Button
                        variant="destructive"
                        className="h-12 text-base"
                        disabled={busy}
                        onClick={() => void act(delivery.orderId, "failed", {
                          reason: reasons[delivery.orderId] ?? "NO_ANSWER",
                          note: notes[delivery.orderId] ?? ""
                        }, t("已记录配送失败。"))}
                      >
                        <TriangleAlertIcon /> {t("提交配送失败")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {current === "drop-off" ? (
                        <>
                          <p className="text-xs text-muted-foreground">
                            {t("顾客本人不在，但同意放在保安、前台或门口。必须拍一张放置位置的照片，而且顾客要通过电话或 WhatsApp 把 4 位数字报给你——两个都有才能完成。")}
                          </p>
                          <PhotoPicker
                            photo={photo}
                            onPick={(value) => setPhotos((v) => ({ ...v, [delivery.orderId]: value }))}
                            onError={setError}
                          />
                          <Input
                            placeholder={t("放在哪里（例如：交给 A 座保安）")}
                            value={notes[delivery.orderId] ?? ""}
                            onChange={(event) => setNotes((v) => ({ ...v, [delivery.orderId]: event.target.value }))}
                          />
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {t("先把货交给顾客，再请顾客报出他订单页上的 4 位数字。没有这个号码不能完成订单。")}
                        </p>
                      )}

                      <Input
                        className="h-14 text-center text-2xl tracking-[0.5em] font-mono"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        placeholder="••••"
                        value={code}
                        onChange={(event) => setCodes((v) => ({ ...v, [delivery.orderId]: event.target.value.replace(/\D/g, "").slice(0, 4) }))}
                      />
                      {delivery.codeLocked ? (
                        <p className="text-sm text-destructive">
                          {t("这单因为多次输错已经锁住了。打电话给门店，让他们给顾客重发一个新号码。")}
                        </p>
                      ) : delivery.codeAttemptsRemaining < 5 ? (
                        <p className="text-sm text-amber-600">
                          {t("还剩")} {delivery.codeAttemptsRemaining} {t("次机会，用完这单会锁住。")}
                        </p>
                      ) : null}

                      <Button
                        className="h-12 text-base"
                        disabled={busy || delivery.codeLocked || code.length !== 4 || (current === "drop-off" && !photo)}
                        onClick={() => {
                          if (current === "drop-off") {
                            void act(delivery.orderId, "drop-off", {
                              code,
                              photoBase64: photo?.dataUrl ?? "",
                              photoContentType: photo?.contentType ?? "",
                              dropOffNote: notes[delivery.orderId] ?? ""
                            }, t("代收完成，订单已关闭。"));
                            return;
                          }
                          void act(delivery.orderId, "complete", { code }, t("送达完成，订单已关闭。"));
                        }}
                      >
                        <CheckCircle2Icon /> {current === "drop-off" ? t("照片 + 号码，完成代收") : t("核对号码并完成")}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border py-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md py-2 text-sm font-medium transition-colors ${active ? "bg-background shadow-sm" : "text-muted-foreground"}`}
    >
      {children}
    </button>
  );
}

/**
 * Opens the phone's camera directly. The picture never leaves the request that
 * completes the drop-off, so there is no half-finished upload to clean up.
 */
function PhotoPicker({
  photo,
  onPick,
  onError
}: {
  photo?: { dataUrl: string; contentType: string };
  onPick: (value: { dataUrl: string; contentType: string }) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (file.size > MAX_PHOTO_BYTES) {
            onError(t("照片太大了，请重拍一张。"));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => onError(t("照片读取失败，请重拍。"));
          reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            if (!result) {
              onError(t("照片读取失败，请重拍。"));
              return;
            }
            onPick({ dataUrl: result, contentType: file.type || "image/jpeg" });
          };
          reader.readAsDataURL(file);
        }}
      />
      <Button type="button" variant="outline" className="h-12 text-base" onClick={() => input.current?.click()}>
        <CameraIcon /> {photo ? t("重拍放置位置") : t("拍放置位置照片")}
      </Button>
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo.dataUrl} alt={t("放置位置")} className="h-40 w-full rounded-lg border object-cover" />
      ) : null}
    </div>
  );
}
