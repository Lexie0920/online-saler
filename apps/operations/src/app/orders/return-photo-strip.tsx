"use client";

import { useEffect, useState } from "react";

import { operationsFetch } from "@/lib/operations-api";
import { t } from "@/i18n/runtime";

export type ReturnPhoto = { id: string; contentType: string; sizeBytes: number; createdAt: string };

/** The photos are private, so each one is fetched with the employee's session and shown from memory. */
export function ReturnPhotoStrip({ orderId, returnId, photos, token }: { orderId: string; returnId: string; photos: ReturnPhoto[]; token: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">{t("退回商品照片（{count}）", { count: photos.length })}</p>
      <div className="flex flex-wrap gap-2">
        {photos.map((photo, index) => <ReturnPhotoThumb key={photo.id} orderId={orderId} returnId={returnId} photoId={photo.id} token={token} label={t("退回商品照片 {number}", { number: index + 1 })} />)}
      </div>
    </div>
  );
}

function ReturnPhotoThumb({ orderId, returnId, photoId, token, label }: { orderId: string; returnId: string; photoId: string; token: string; label: string }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;
    void (async () => {
      try {
        const response = await operationsFetch(`/api-proxy/operations/orders/${encodeURIComponent(orderId)}/after-sales/${encodeURIComponent(returnId)}/photos/${encodeURIComponent(photoId)}/content`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error("photo");
        objectUrl = URL.createObjectURL(await response.blob());
        if (cancelled) URL.revokeObjectURL(objectUrl); else setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [orderId, returnId, photoId, token]);
  if (failed) return <div className="flex size-24 items-center justify-center rounded-md border text-center text-muted-foreground text-xs">{t("照片读取失败")}</div>;
  if (!url) return <div className="size-24 animate-pulse rounded-md border bg-muted" aria-label={label} />;
  return <a href={url} target="_blank" rel="noreferrer" aria-label={label}><img src={url} alt={label} className="size-24 rounded-md border object-cover" /></a>;
}
