"use client";

import Link from "next/link";
import type { useStorefrontI18n } from "../../i18n/use-storefront-i18n";
import { Button } from "../../components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { SiteHeader } from "../components/site-header";

export type Translate = ReturnType<typeof useStorefrontI18n>["t"];

/** A Nairobi calendar date (UTC+3), e.g. 2026-10-12. */
export function payoutDay(iso: string) {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function MetricCard({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return <Card><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle className="text-2xl font-semibold">{value}</CardTitle>{note ? <p className="text-xs text-muted-foreground">{note}</p> : null}</CardHeader></Card>;
}
export function MetricLine({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border bg-muted/60 p-3"><small className="text-muted-foreground">{label}</small><strong className="mt-1 block text-sm font-medium">{value}</strong></div>;
}
export function SectionHeading({ title, body }: { title: string; body: string }) {
  return <header><h2 className="text-xl font-semibold tracking-tight">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{body}</p></header>;
}
export function Notice({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border bg-card px-3 py-2 text-sm" role="status">{children}</p>;
}
export function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action: string }) {
  return (
    <Empty className="border bg-card">
      <EmptyHeader><EmptyMedia variant="icon">{icon}</EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{body}</EmptyDescription></EmptyHeader>
      <EmptyContent><Button asChild variant="outline"><Link href="/">{action}</Link></Button></EmptyContent>
    </Empty>
  );
}
export function CenterMessage({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <main className="affiliateConsole min-h-screen bg-muted/50">
      <SiteHeader />
      <div className="mx-auto max-w-xl px-5 py-24">
        <Empty className="border bg-card">
          <EmptyHeader><EmptyMedia variant="icon">{icon}</EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{body}</EmptyDescription></EmptyHeader>
          {action ? <EmptyContent>{action}</EmptyContent> : null}
        </Empty>
      </div>
    </main>
  );
}
/** "Mon 2 Nov" for a Nairobi date (YYYY-MM-DD). */
export function payoutDayLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}
export function money(value: number) { return `KSh ${value.toLocaleString("en-KE")}`; }
export function errorMessage(caught: unknown, t: Translate) { return caught instanceof Error ? caught.message : t("affiliate.actionFailed"); }
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copyText(value: string) { await navigator.clipboard.writeText(value); }
