"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { buildShareLink, SHARE_CHANNELS, type ShareChannel } from "../../affiliate/affiliate-platform";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";

const channelLabels: Record<ShareChannel, "affiliate.shareDialog.whatsapp" | "affiliate.shareDialog.status" | "affiliate.shareDialog.tiktok" | "affiliate.shareDialog.facebook"> = {
  WHATSAPP: "affiliate.shareDialog.whatsapp",
  STATUS: "affiliate.shareDialog.status",
  TIKTOK: "affiliate.shareDialog.tiktok",
  FACEBOOK: "affiliate.shareDialog.facebook",
};

/**
 * Share a page (a collection) in one step: pick where it is going, edit the text,
 * copy the link or the whole message. The link is tagged with the channel, so
 * Results can show where clicks came from. No campaign has to be created first.
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
  const [copied, setCopied] = useState<"link" | "message" | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (open) { setChannel("WHATSAPP"); setCopied(null); setFailed(false); }
  }, [open, path]);
  useEffect(() => { setCaption(t("affiliate.shareDialog.defaultCaption", { title })); }, [open, title, t]);

  const link = typeof window === "undefined" ? "" : new URL(buildShareLink(path, affiliateCode, channel), window.location.origin).toString();

  async function copy(kind: "link" | "message") {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(kind === "link" ? link : `${caption}\n${link}`);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setFailed(true);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-h-[90vh] max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("affiliate.shareDialog.title", { title })}</SheetTitle>
          <SheetDescription>{t("affiliate.shareDialog.body")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("affiliate.shareDialog.channel")}>
            {SHARE_CHANNELS.map((value) => (
              <Button key={value} size="sm" variant={channel === value ? "default" : "outline"} aria-pressed={channel === value} onClick={() => setChannel(value)}>
                {t(channelLabels[value])}
              </Button>
            ))}
          </div>
          <Textarea value={caption} onChange={(event) => setCaption(event.target.value)} aria-label={t("affiliate.shareDialog.caption")} rows={3} />
          <p className="break-all rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{link}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy("message")}>{copied === "message" ? <Check /> : <Copy />} {t("affiliate.shareDialog.copyMessage")}</Button>
            <Button variant="outline" onClick={() => void copy("link")}>{copied === "link" ? <Check /> : <Copy />} {t("affiliate.shareDialog.copyLink")}</Button>
          </div>
          {failed ? <p className="text-sm text-destructive" role="alert">{t("affiliate.shareDialog.copyFailed")}</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
