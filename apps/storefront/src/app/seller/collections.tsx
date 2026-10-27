"use client";

import { Archive, LoaderCircle, Plus, Share2, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { affiliateJson, type AffiliateCollection } from "../../affiliate/affiliate-client";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { EmptyState, errorMessage, Notice, type Translate } from "./center-ui";
import { ShareDialog } from "./share-dialog";
import { FolderHeart } from "lucide-react";

/** My collections: groups of pieces the promoter picks to share, each with how it is doing. */
export function Collections({ collections, affiliateCode, refresh, openStatusPack, t }: {
  collections: AffiliateCollection[];
  affiliateCode: string;
  refresh: () => Promise<unknown>;
  openStatusPack: (collectionId: string) => void;
  t: Translate;
}) {
  const [sharing, setSharing] = useState<AffiliateCollection | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusyId("create");
    try {
      await affiliateJson("/api/affiliate/collections", { method: "POST", body: JSON.stringify({ title, description }) });
      setTitle(""); setDescription(""); setShowForm(false); setMessage(t("affiliate.collections.created")); await refresh();
    } catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusyId(null); }
  }

  async function action(collection: AffiliateCollection, nextAction: "PUBLISH" | "ARCHIVE" | "RESTORE" | "DELETE") {
    setBusyId(collection.id); setMessage(null);
    try {
      await affiliateJson(`/api/affiliate/collections/${collection.id}`, nextAction === "DELETE"
        ? { method: "DELETE" }
        : { method: "PATCH", body: JSON.stringify({ action: nextAction }) });
      setMessage(t("affiliate.collections.updated", { title: collection.title })); await refresh();
    } catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusyId(null); }
  }

  async function rename(collection: AffiliateCollection) {
    const nextTitle = window.prompt(t("affiliate.collections.renamePrompt"), collection.title)?.trim();
    if (!nextTitle || nextTitle === collection.title) return;
    setBusyId(collection.id);
    try { await affiliateJson(`/api/affiliate/collections/${collection.id}`, { method: "PATCH", body: JSON.stringify({ title: nextTitle }) }); await refresh(); }
    catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusyId(null); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t("affiliate.collections.myTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("affiliate.collections.myBody")}</p>
        </div>
        <Button variant="outline" onClick={() => setShowForm((value) => !value)}><Plus /> {t("affiliate.collections.new")}</Button>
      </div>
      {showForm ? (
        <Card>
          <CardHeader><CardTitle>{t("affiliate.collections.new")}</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={create}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="collection-title">{t("affiliate.collections.titleField")}</FieldLabel>
                  <Input id="collection-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("affiliate.collections.titlePlaceholder")} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="collection-description">{t("affiliate.collections.descriptionField")}</FieldLabel>
                  <Textarea id="collection-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("affiliate.collections.descriptionPlaceholder")} />
                </Field>
                <Button type="submit" disabled={busyId === "create" || title.trim().length < 3}>
                  {busyId === "create" ? <LoaderCircle className="animate-spin" /> : <Plus />} {t("affiliate.collections.create")}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
      <ShareDialog
        open={Boolean(sharing)}
        onOpenChange={(open) => { if (!open) setSharing(null); }}
        title={sharing?.title ?? ""}
        path={sharing ? `/c/${sharing.slug}` : "/"}
        affiliateCode={affiliateCode}
      />
      {collections.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {collections.map((collection) => {
            const live = collection.status === "PUBLISHED";
            const archived = collection.status === "ARCHIVED";
            return (
              <Card key={collection.id} className="overflow-hidden">
                {collection.products.length ? (
                  <div className="grid grid-cols-4 gap-1 p-3 pb-0" aria-hidden="true">
                    {collection.products.slice(0, 4).map((product) => (
                      <img key={product.id} src={product.image} alt="" loading="lazy" className="aspect-square w-full rounded-md object-cover" />
                    ))}
                  </div>
                ) : null}
                <CardHeader>
                  <CardTitle className="text-base">{collection.title}</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {t("affiliate.collections.itemsLine", { count: collection.itemCount, state: live ? t("affiliate.collections.live") : archived ? t("affiliate.collections.archived") : t("affiliate.collections.notLive") })}
                  </p>
                  {live ? <p className="text-sm text-muted-foreground">{t("affiliate.collections.doing", { clicks: collection.clicks ?? 0, orders: collection.orders ?? 0 })}</p> : null}
                  {!live && !archived && collection.itemCount < 5 ? <p className="text-xs text-muted-foreground">{t("affiliate.collections.needMore", { count: 5 - collection.itemCount })}</p> : null}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {live ? (
                      <>
                        <Button size="sm" onClick={() => setSharing(collection)}><Share2 /> {t("affiliate.shareDialog.button")}</Button>
                        <Button size="sm" variant="outline" onClick={() => openStatusPack(collection.id)}>{t("affiliate.collections.statusPack")}</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busyId === collection.id || (!archived && collection.itemCount < 5)} onClick={() => void action(collection, archived ? "RESTORE" : "PUBLISH")}>
                        {archived ? t("affiliate.collections.restore") : t("affiliate.collections.makeLive")}
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 text-xs">
                    <Button size="sm" variant="ghost" onClick={() => void rename(collection)}>{t("affiliate.collections.rename")}</Button>
                    {live ? <Button size="sm" variant="ghost" onClick={() => void action(collection, "ARCHIVE")}><Archive /> {t("affiliate.collections.archive")}</Button> : null}
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={busyId === collection.id}
                      onClick={() => window.confirm(t("affiliate.collections.deleteConfirm", { title: collection.title })) && void action(collection, "DELETE")}>
                      <Trash2 /> {t("affiliate.collections.delete")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={<FolderHeart />} title={t("affiliate.collections.emptyTitle")} body={t("affiliate.collections.emptyBody")} action={t("affiliate.collections.browse")} />
      )}
    </div>
  );
}
