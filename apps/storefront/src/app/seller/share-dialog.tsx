"use client";

import { Check, Copy, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import { buildShareLink, SHARE_CHANNELS, type ShareChannel } from "../../affiliate/affiliate-platform";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";

const channelNames: Record<ShareChannel, string> = {
  WHATSAPP: "WhatsApp", TIKTOK: "TikTok", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", OTHER: "Other",
};

/**
 * Share a page (a collection or one piece) in one step: pick where it is going,
 * change the caption, send or copy. The link is tagged with the channel, so
 * Results can show where clicks came from. Nothing has to be set up first.
 */
export function ShareDialog({
  open,
  onOpenChange,
  title,
  path,
  affiliateCode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  path: string;
  affiliateCode: string;
}) {
  const { t } = useStorefrontI18n();
  const [channel, setChannel] = useState<ShareChannel>("WHATSAPP");
  const [caption, setCaption] = useState("");
  const [copied, setCopied] = useState<"link" | "caption" | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChannel("WHATSAPP"); setCopied(null); setFailed(false);
    setCaption(t("affiliate.shareDialog.defaultCaption", { title }));
  }, [open, title, path, t]);

  const link = typeof window === "undefined" ? "" : new URL(buildShareLink(path, affiliateCode, channel), window.location.origin).toString();

  async function copy(kind: "link" | "caption") {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(kind === "link" ? link : `${caption}\n${link}`);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setFailed(true);
    }
  }

  function sendToWhatsApp() {
    window.open(`https://wa.me/?text=${encodeURIComponent(`${caption}\n${link}`)}`, "_blank", "noopener,noreferrer");
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border bg-background p-5 shadow-lg">
          <div className="flex items-start justify-between gap-3">
            <DialogPrimitive.Title className="text-lg font-semibold">{t("affiliate.shareDialog.title", { title })}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label={t("affiliate.shareDialog.close")}><X className="size-4" /></DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">{t("affiliate.shareDialog.body")}</DialogPrimitive.Description>
          <div>
            <p className="mb-2 text-sm text-muted-foreground">{t("affiliate.shareDialog.channel")}</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("affiliate.shareDialog.channel")}>
              {SHARE_CHANNELS.map((value: ShareChannel) => (
                <Button key={value} size="sm" className="rounded-full" variant={channel === value ? "default" : "outline"} aria-pressed={channel === value} onClick={() => setChannel(value)}>
                  {channelNames[value]}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="share-caption" className="mb-2 block text-sm text-muted-foreground">{t("affiliate.shareDialog.caption")}</label>
            <Textarea id="share-caption" value={caption} onChange={(event) => setCaption(event.target.value)} rows={3} />
          </div>
          <div className="flex flex-wrap gap-2">
            {channel === "WHATSAPP" ? <Button onClick={sendToWhatsApp}>{t("affiliate.shareDialog.sendWhatsApp")}</Button> : null}
            <Button variant="outline" onClick={() => void copy("link")}>{copied === "link" ? <Check /> : <Copy />} {t("affiliate.shareDialog.copyLink")}</Button>
            <Button variant="outline" onClick={() => void copy("caption")}>{copied === "caption" ? <Check /> : <Copy />} {t("affiliate.shareDialog.copyCaption")}</Button>
          </div>
          {failed ? <p className="text-sm text-destructive" role="alert">{t("affiliate.shareDialog.copyFailed")}</p> : null}
          <p className="text-xs text-muted-foreground">{t("affiliate.shareDialog.counted", { channel: channelNames[channel] })}</p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
