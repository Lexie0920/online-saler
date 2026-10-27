"use client";

import { operationsFetch } from "@/lib/operations-api";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2Icon, CopyIcon, ExternalLinkIcon, RefreshCwIcon, SearchIcon, UserPlusIcon } from "lucide-react";

import { useOperationsSession } from "@/components/admin/operations-access-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadCsv, payoutListFileName, toCsv } from "@/lib/csv-download";
import { cn } from "@/lib/utils";
import { t } from "@/i18n/runtime";

const API_PROXY_URL = "/api-proxy";

export type AffiliateView = "affiliates" | "links" | "clicks" | "orders" | "commissions";
export type CommissionQueueKey = "pending" | "confirmed" | "paid" | "exceptions";

type Summary = {
  activeAffiliates: number;
  disabledAffiliates: number;
  clicks: number;
  attributedOrders: number;
  paidOrders: number;
  pendingCommissions: number;
  confirmedCommissions: number;
  paidCommissions: number;
  attributedSalesKsh: number;
  earnedCommissionKsh: number;
};

type AffiliateRow = {
  id: string;
  affiliateCode: string;
  displayName: string;
  phone?: string | null;
  email?: string | null;
  status: string;
  commissionRateBps?: number | null;
  storefrontShareUrl: string;
  effectiveCommissionRateBps: number;
  stats: {
    paidOrders: number;
    salesKsh: number;
    pendingCommissionKsh: number;
    confirmedCommissionKsh: number;
    paidCommissionKsh: number;
    rejectedCommissionKsh: number;
    lastClickAt?: string | null;
    lastOrderAt?: string | null;
  };
  _count: {
    clicks: number;
    orders: number;
    commissions: number;
  };
};

type CustomerSearchRow = {
  id: string;
  email: string;
  displayName?: string | null;
  phone?: string | null;
  status: string;
  _count: {
    orders: number;
  };
  affiliateProfile?: {
    id: string;
    affiliateCode: string;
    displayName: string;
    status: string;
  } | null;
};

type LinkRow = {
  id: string;
  linkCode: string;
  type: string;
  landingPath: string;
  source?: string | null;
  campaign?: string | null;
  active: boolean;
  shareUrl: string;
  whatsappUrl: string;
  affiliate: {
    affiliateCode: string;
    displayName: string;
  };
  product?: {
    productCode: string;
    title?: string | null;
  } | null;
  _count: {
    clicks: number;
  };
};

type ClickRow = {
  id: string;
  source?: string | null;
  campaign?: string | null;
  landingPath: string;
  clickedAt: string;
  expiresAt: string;
  affiliate: {
    affiliateCode: string;
    displayName: string;
  };
  product?: {
    productCode: string;
    title?: string | null;
  } | null;
  customer?: {
    email: string;
    displayName?: string | null;
  } | null;
};

type AttributedOrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  affiliateSource?: string | null;
  affiliateCampaign?: string | null;
  itemSubtotalKsh: number;
  totalKsh: number;
  createdAt: string;
  affiliate?: {
    affiliateCode: string;
    displayName: string;
  } | null;
  customer: {
    email: string;
    displayName?: string | null;
    phone?: string | null;
  };
  commission?: {
    status: string;
    commissionAmountKsh: number;
  } | null;
  items: Array<{
    snapshot?: {
      title: string;
      barcode?: string | null;
    } | null;
  }>;
};

type CommissionRow = {
  id: string;
  status: string;
  rateBps: number;
  orderSubtotalKsh: number;
  commissionAmountKsh: number;
  holdReason?: string | null;
  note?: string | null;
  createdAt: string;
  confirmedAt?: string | null;
  paidAt?: string | null;
  eligibility?: { eligibleAt: string | null; blockingReason: string | null };
  affiliate: {
    affiliateCode: string;
    displayName: string;
    phone?: string | null;
  };
  order: {
    orderNumber: string;
    status: string;
    customer: {
      email: string;
      displayName?: string | null;
      phone?: string | null;
    };
    items: Array<{
      snapshot?: {
        title: string;
        barcode?: string | null;
      } | null;
    }>;
  };
  attribution?: {
    source?: string | null;
    campaign?: string | null;
  } | null;
};

type AffiliateForm = {
  displayName: string;
  affiliateCode: string;
  phone: string;
  email: string;
  commissionRateBps: string;
};

type LinkForm = {
  affiliateCode: string;
  type: "STORE" | "PRODUCT";
  productCode: string;
  landingPath: string;
  source: string;
  campaign: string;
};

type RequestOptions = RequestInit & {
  query?: Record<string, string | undefined>;
};

const emptyAffiliateForm: AffiliateForm = {
  displayName: "",
  affiliateCode: "",
  phone: "",
  email: "",
  commissionRateBps: ""
};

const emptyLinkForm: LinkForm = {
  affiliateCode: "DL-AFF-001",
  type: "STORE",
  productCode: "",
  landingPath: "/",
  source: "whatsapp",
  campaign: "staging"
};

export function AffiliateCenterPage({
  view,
  commissionQueue
}: {
  view: AffiliateView;
  commissionQueue?: CommissionQueueKey;
}) {
  const { session, hasPermission } = useOperationsSession();
  const adminUserId = session?.adminUser?.id ?? "";
  const accessToken = session?.accessToken ?? "";
  const request = useCallback(<T,>(path: string, options?: RequestOptions): Promise<T> => apiRequest<T>(path, {
    ...options,
    headers: { ...options?.headers, Authorization: `Bearer ${accessToken}` }
  }), [accessToken]);
  const canEdit = hasPermission("action.affiliate.edit");
  const canApprove = hasPermission("action.affiliate.approve");
  const canExport = hasPermission("action.affiliate.export");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [affiliates, setAffiliates] = useState<AffiliateRow[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerRows, setCustomerRows] = useState<CustomerSearchRow[]>([]);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [clicks, setClicks] = useState<ClickRow[]>([]);
  const [orders, setOrders] = useState<AttributedOrderRow[]>([]);
  const [commissions, setCommissions] = useState<CommissionRow[]>([]);
  const [affiliateForm, setAffiliateForm] = useState<AffiliateForm>(emptyAffiliateForm);
  const [linkForm, setLinkForm] = useState<LinkForm>(emptyLinkForm);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const meta = pageMeta(view, commissionQueue);

  const load = useCallback(async () => {
    if (!adminUserId) return;
    setBusy(true);
    setError("");
    try {
      const [nextSummary] = await Promise.all([
        request<Summary>("/operations/affiliate/summary", { query: { adminUserId } }),
        loadViewData()
      ]);
      setSummary(nextSummary);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取推广佣金数据。"));
    } finally {
      setBusy(false);
    }

    async function loadViewData() {
      if (view === "affiliates") setAffiliates(await request<AffiliateRow[]>("/operations/affiliate/affiliates", { query: { adminUserId } }));
      if (view === "links") setLinks(await request<LinkRow[]>("/operations/affiliate/links", { query: { adminUserId } }));
      if (view === "clicks") setClicks(await request<ClickRow[]>("/operations/affiliate/clicks", { query: { adminUserId } }));
      if (view === "orders") setOrders(await request<AttributedOrderRow[]>("/operations/affiliate/attributed-orders", { query: { adminUserId } }));
      if (view === "commissions") {
        setCommissions(await request<CommissionRow[]>("/operations/affiliate/commissions", {
          query: { adminUserId, queue: commissionQueue }
        }));
      }
    }
  }, [adminUserId, commissionQueue, request, view]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createAffiliate() {
    if (!adminUserId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request("/operations/affiliate/affiliates", {
        method: "POST",
        body: JSON.stringify({
          adminUserId,
          ...affiliateForm,
          commissionRateBps: affiliateForm.commissionRateBps.trim() ? Number(affiliateForm.commissionRateBps) : undefined
        })
      });
      setAffiliateForm(emptyAffiliateForm);
      setMessage(t("推广者已创建。"));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("创建推广者失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function searchCustomerAccounts() {
    if (!adminUserId || customerSearch.trim().length < 2) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setCustomerRows(await request<CustomerSearchRow[]>("/operations/affiliate/customers/search", {
        query: { adminUserId, q: customerSearch.trim() }
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Customer search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function enableCustomerAffiliate(customer: CustomerSearchRow) {
    if (!adminUserId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(`/operations/affiliate/customers/${customer.id}/enable-affiliate`, {
        method: "POST",
        body: JSON.stringify({
          adminUserId,
          displayName: customer.displayName || customer.email,
          phone: customer.phone || undefined,
          email: customer.email
        })
      });
      setMessage(t("推广者权限已开通。顾客重新打开商城后会看到推广者中台。"));
      await Promise.all([searchCustomerAccounts(), load()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not enable seller access.");
    } finally {
      setBusy(false);
    }
  }

  async function updateAffiliateStatus(affiliate: AffiliateRow, status: "ACTIVE" | "DISABLED") {
    await action(`/operations/affiliate/affiliates/${affiliate.id}`, {
      method: "PATCH",
      body: JSON.stringify({ adminUserId, status })
    }, status === "ACTIVE" ? t("推广者已启用。") : t("推广者已停用。"));
  }

  async function createLink() {
    if (!adminUserId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request("/operations/affiliate/links", {
        method: "POST",
        body: JSON.stringify({
          adminUserId,
          ...linkForm,
          productCode: linkForm.productCode || undefined,
          landingPath: linkForm.landingPath || undefined,
          source: linkForm.source || undefined,
          campaign: linkForm.campaign || undefined
        })
      });
      setLinkForm(emptyLinkForm);
      setMessage(t("推广链接已生成。"));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("创建推广链接失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function commissionAction(commission: CommissionRow, actionName: "confirm" | "reject" | "paid") {
    const note = actionName === "confirm" ? undefined : window.prompt(actionName === "reject"
      ? t("请输入驳回原因：")
      : t("确认已在外部完成付款后，填写已核实的付款凭证或交易参考号。此操作仅记录付款，不会转账："));
    if (actionName !== "confirm" && !note?.trim()) return;
    await action(`/operations/affiliate/commissions/${commission.id}/${actionName}`, {
      method: "POST",
      body: JSON.stringify({ adminUserId, note })
    }, actionName === "confirm" ? t("佣金已确认。") : actionName === "reject" ? t("佣金已驳回。") : t("已保存外部付款记录及凭证说明。"));
  }

  async function exportPayouts() {
    if (!adminUserId) return;
    setError("");
    setMessage("");
    try {
      const rows = await request<Array<Record<string, unknown>>>("/operations/affiliate/payout-export", { query: { adminUserId } });
      if (rows.length === 0) {
        setMessage(t("目前没有待付款的佣金，没有生成文件。"));
        return;
      }
      downloadCsv(payoutListFileName(), toCsv(rows));
      setMessage(t("付款清单已下载：{count} 笔。", { count: rows.length }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("导出付款清单失败。"));
    }
  }

  async function copy(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1600);
  }

  async function action(path: string, options: RequestInit, success: string) {
    if (!adminUserId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(path, options);
      setMessage(success);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("操作失败。"));
    } finally {
      setBusy(false);
    }
  }

  const metrics = useMemo(() => [
    { label: t("活跃推广者"), value: String(summary?.activeAffiliates ?? 0) },
    { label: t("点击记录"), value: String(summary?.clicks ?? 0) },
    { label: t("归因订单"), value: String(summary?.attributedOrders ?? 0) },
    { label: t("归因销售额"), value: money(summary?.attributedSalesKsh ?? 0) },
    { label: t("待确认佣金"), value: String(summary?.pendingCommissions ?? 0) },
    { label: t("已赚佣金（不含已拒绝）"), value: money(summary?.earnedCommissionKsh ?? 0) }
  ], [summary]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("推广佣金")}
        title={meta.title}
        description={meta.description}
        action={
          <div className="flex gap-2">
            {canExport ? (
              <Button variant="outline" onClick={() => void exportPayouts()}>
                
                {t("导出付款清单")}
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => void load()}>
              <RefreshCwIcon data-icon="inline-start" />
              
              {t("刷新")}
            </Button>
          </div>
        }
      />

      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        {metrics.map((metric) => (
          <Metric key={metric.label} title={metric.label} value={metric.value} />
        ))}
      </section>

      {message ? <StatusMessage>{message}</StatusMessage> : null}
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}

      {view === "affiliates" ? (
        <AffiliatesView
          affiliates={affiliates}
          customerSearch={customerSearch}
          customerRows={customerRows}
          form={affiliateForm}
          canEdit={canEdit}
          copied={copied}
          busy={busy}
          onCustomerSearchChange={setCustomerSearch}
          onSearchCustomers={searchCustomerAccounts}
          onEnableCustomer={enableCustomerAffiliate}
          onFormChange={setAffiliateForm}
          onCreate={createAffiliate}
          onCopy={copy}
          onStatus={updateAffiliateStatus}
        />
      ) : null}
      {view === "links" ? (
        <LinksView
          links={links}
          form={linkForm}
          canEdit={canEdit}
          copied={copied}
          busy={busy}
          onFormChange={setLinkForm}
          onCreate={createLink}
          onCopy={copy}
        />
      ) : null}
      {view === "clicks" ? <ClicksView clicks={clicks} busy={busy} /> : null}
      {view === "orders" ? <OrdersView orders={orders} busy={busy} /> : null}
      {view === "commissions" ? (
        <CommissionsView
          commissions={commissions}
          busy={busy}
          canApprove={canApprove}
          onAction={commissionAction}
        />
      ) : null}
    </div>
  );
}

function AffiliatesView({
  affiliates,
  customerSearch,
  customerRows,
  form,
  canEdit,
  copied,
  busy,
  onCustomerSearchChange,
  onSearchCustomers,
  onEnableCustomer,
  onFormChange,
  onCreate,
  onCopy,
  onStatus
}: {
  affiliates: AffiliateRow[];
  customerSearch: string;
  customerRows: CustomerSearchRow[];
  form: AffiliateForm;
  canEdit: boolean;
  copied: string;
  busy: boolean;
  onCustomerSearchChange: (value: string) => void;
  onSearchCustomers: () => void;
  onEnableCustomer: (customer: CustomerSearchRow) => void;
  onFormChange: (form: AffiliateForm) => void;
  onCreate: () => void;
  onCopy: (value: string, key: string) => void;
  onStatus: (affiliate: AffiliateRow, status: "ACTIVE" | "DISABLED") => void;
}) {
  return (
    <>
      {canEdit ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("从顾客账号开通推广者")}</CardTitle>
            <CardDescription>{t("搜索已用 Google 登录过的顾客账号，直接开通推广者权限。开通后，该顾客前台右上角会从 Join seller 变成推广者中台。")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 md:flex-row">
              <Input
                value={customerSearch}
                onChange={(event) => onCustomerSearchChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onSearchCustomers();
                  }
                }}
                placeholder={t("搜索 Google 邮箱、姓名或手机号")}
              />
              <Button disabled={busy || customerSearch.trim().length < 2} onClick={onSearchCustomers}>
                <SearchIcon data-icon="inline-start" />
                
                {t("搜索账号")}
              </Button>
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("顾客账号")}</TableHead>
                    <TableHead>{t("手机号")}</TableHead>
                    <TableHead>{t("订单数")}</TableHead>
                    <TableHead>{t("推广者状态")}</TableHead>
                    <TableHead>{t("操作")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customerRows.length === 0 ? (
                    <EmptyRow colSpan={5} text={t("输入至少2个字符后搜索顾客账号。")} />
                  ) : customerRows.map((customer) => (
                    <TableRow key={customer.id}>
                      <TableCell>
                        <div className="font-medium">{customer.displayName || customer.email}</div>
                        <div className="text-muted-foreground text-xs">{customer.email}</div>
                      </TableCell>
                      <TableCell>{customer.phone || "-"}</TableCell>
                      <TableCell>{customer._count.orders}</TableCell>
                      <TableCell>
                        {customer.affiliateProfile ? (
                          <div>
                            <StatusBadge status={customer.affiliateProfile.status} />
                            <div className="mt-1 font-mono text-muted-foreground text-xs">{customer.affiliateProfile.affiliateCode}</div>
                          </div>
                        ) : (
                          <Badge variant="outline">{t("未开通")}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant={customer.affiliateProfile?.status === "ACTIVE" ? "outline" : "default"}
                          disabled={busy}
                          onClick={() => void onEnableCustomer(customer)}
                        >
                          <UserPlusIcon data-icon="inline-start" />
                          {customer.affiliateProfile?.status === "ACTIVE" ? t("重新启用") : t("开通推广者")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {canEdit ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("开通推广者")}</CardTitle>
            <CardDescription>{t("每个推广者会获得唯一 Affiliate ID。默认佣金比例使用配置项，可单独覆盖。")}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-4 md:grid-cols-5">
              <Field>
                <FieldLabel>{t("姓名 / 昵称")}</FieldLabel>
                <Input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>Affiliate ID</FieldLabel>
                <Input placeholder={t("可留空自动生成")} value={form.affiliateCode} onChange={(event) => onFormChange({ ...form, affiliateCode: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>{t("手机号")}</FieldLabel>
                <Input value={form.phone} onChange={(event) => onFormChange({ ...form, phone: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>{t("邮箱")}</FieldLabel>
                <Input value={form.email} onChange={(event) => onFormChange({ ...form, email: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>{t("佣金 bps")}</FieldLabel>
                <div className="flex gap-2">
                  <Input aria-label={t("当前推广佣金比例")} value={t("25%（当前统一比例）")} disabled />
                  <Button disabled={busy || !form.displayName.trim()} onClick={onCreate}>{t("创建")}</Button>
                </div>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("推广者")}</TableHead>
                <TableHead>Affiliate ID</TableHead>
                <TableHead>{t("状态")}</TableHead>
                <TableHead>{t("佣金比例")}</TableHead>
                <TableHead>{t("数据")}</TableHead>
                <TableHead>{t("商城分享链接")}</TableHead>
                <TableHead>{t("操作")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {affiliates.length === 0 ? (
                <EmptyRow colSpan={7} text={t("还没有推广者。")} />
              ) : affiliates.map((affiliate) => (
                <TableRow key={affiliate.id}>
                  <TableCell>
                    <div className="font-medium">{affiliate.displayName}</div>
                    <div className="text-muted-foreground text-xs">{affiliate.phone || affiliate.email || "-"}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{affiliate.affiliateCode}</TableCell>
                  <TableCell><StatusBadge status={affiliate.status} /></TableCell>
                  <TableCell>{rateLabel(affiliate.effectiveCommissionRateBps)}</TableCell>
                  <TableCell className="min-w-72 text-sm">
                    <AffiliateStats affiliate={affiliate} />
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-64 items-center gap-2">
                      <a className="truncate text-primary text-xs" href={affiliate.storefrontShareUrl} target="_blank" rel="noreferrer">
                        {affiliate.storefrontShareUrl}
                      </a>
                      <Button size="sm" variant="ghost" onClick={() => void onCopy(affiliate.storefrontShareUrl, affiliate.id)}>
                        {copied === affiliate.id ? <CheckCircle2Icon /> : <CopyIcon />}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    {canEdit ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void onStatus(affiliate, affiliate.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}
                      >
                        {affiliate.status === "ACTIVE" ? t("停用") : t("启用")}
                      </Button>
                    ) : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function LinksView({
  links,
  form,
  canEdit,
  copied,
  busy,
  onFormChange,
  onCreate,
  onCopy
}: {
  links: LinkRow[];
  form: LinkForm;
  canEdit: boolean;
  copied: string;
  busy: boolean;
  onFormChange: (form: LinkForm) => void;
  onCreate: () => void;
  onCopy: (value: string, key: string) => void;
}) {
  return (
    <>
      {canEdit ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("生成推广链接")}</CardTitle>
            <CardDescription>{t("支持商品链接、商城链接和 TikTok / Facebook campaign 参数。")}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              <Field>
                <FieldLabel>Affiliate ID</FieldLabel>
                <Input value={form.affiliateCode} onChange={(event) => onFormChange({ ...form, affiliateCode: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>{t("类型")}</FieldLabel>
                <NativeSelect value={form.type} onChange={(event) => onFormChange({ ...form, type: event.target.value as LinkForm["type"] })}>
                  <NativeSelectOption value="STORE">{t("商城分享")}</NativeSelectOption>
                  <NativeSelectOption value="PRODUCT">{t("商品分享")}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>{t("商品 code")}</FieldLabel>
                <Input disabled={form.type === "STORE"} value={form.productCode} onChange={(event) => onFormChange({ ...form, productCode: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>Source</FieldLabel>
                <Input placeholder="whatsapp / tiktok / facebook" value={form.source} onChange={(event) => onFormChange({ ...form, source: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>Campaign</FieldLabel>
                <Input value={form.campaign} onChange={(event) => onFormChange({ ...form, campaign: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel>Landing Path</FieldLabel>
                <div className="flex gap-2">
                  <Input value={form.landingPath} onChange={(event) => onFormChange({ ...form, landingPath: event.target.value })} />
                  <Button disabled={busy || !form.affiliateCode.trim()} onClick={onCreate}>{t("生成")}</Button>
                </div>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("推广者")}</TableHead>
                <TableHead>{t("类型")}</TableHead>
                <TableHead>Source / Campaign</TableHead>
                <TableHead>{t("商品")}</TableHead>
                <TableHead>{t("点击")}</TableHead>
                <TableHead>{t("分享链接")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.length === 0 ? (
                <EmptyRow colSpan={6} text={t("还没有推广链接。")} />
              ) : links.map((link) => (
                <TableRow key={link.id}>
                  <TableCell>
                    <div className="font-medium">{link.affiliate.displayName}</div>
                    <div className="font-mono text-muted-foreground text-xs">{link.affiliate.affiliateCode}</div>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{link.type}</Badge></TableCell>
                  <TableCell>{link.source || "-"} / {link.campaign || "-"}</TableCell>
                  <TableCell>{link.product?.title ?? link.product?.productCode ?? t("商城首页")}</TableCell>
                  <TableCell>{link._count.clicks}</TableCell>
                  <TableCell>
                    <div className="flex min-w-72 items-center gap-2">
                      <a className="truncate text-primary text-xs" href={link.shareUrl} target="_blank" rel="noreferrer">
                        {link.shareUrl}
                      </a>
                      <Button size="sm" variant="ghost" onClick={() => void onCopy(link.shareUrl, link.id)}>
                        {copied === link.id ? <CheckCircle2Icon /> : <CopyIcon />}
                      </Button>
                      <a href={link.whatsappUrl} target="_blank" rel="noreferrer" className="inline-flex text-muted-foreground hover:text-primary">
                        <ExternalLinkIcon className="size-4" />
                      </a>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function ClicksView({ clicks, busy }: { clicks: ClickRow[]; busy: boolean }) {
  return (
    <DataCard empty={busy ? t("正在读取点击记录...") : t("还没有点击记录。")} colSpan={6} headers={[t("时间"), t("推广者"), t("商品"), "Source", "Campaign", t("有效期")]}>
      {clicks.map((click) => (
        <TableRow key={click.id}>
          <TableCell>{dateTime(click.clickedAt)}</TableCell>
          <TableCell>{click.affiliate.displayName}<div className="font-mono text-muted-foreground text-xs">{click.affiliate.affiliateCode}</div></TableCell>
          <TableCell>{click.product?.title ?? click.product?.productCode ?? click.landingPath}</TableCell>
          <TableCell>{click.source || "-"}</TableCell>
          <TableCell>{click.campaign || "-"}</TableCell>
          <TableCell>{dateTime(click.expiresAt)}</TableCell>
        </TableRow>
      ))}
    </DataCard>
  );
}

function OrdersView({ orders, busy }: { orders: AttributedOrderRow[]; busy: boolean }) {
  return (
    <DataCard empty={busy ? t("正在读取归因订单...") : t("还没有归因订单。")} colSpan={7} headers={[t("订单"), t("推广者"), t("顾客"), t("商品"), t("状态"), t("金额"), t("佣金")]}>
      {orders.map((order) => (
        <TableRow key={order.id}>
          <TableCell className="font-mono text-xs">{order.orderNumber}</TableCell>
          <TableCell>{order.affiliate?.displayName ?? "-"}<div className="text-muted-foreground text-xs">{order.affiliateSource || "-"} / {order.affiliateCampaign || "-"}</div></TableCell>
          <TableCell>{order.customer.displayName || order.customer.email}<div className="text-muted-foreground text-xs">{order.customer.phone || "-"}</div></TableCell>
          <TableCell>{order.items[0]?.snapshot?.title ?? "-"}</TableCell>
          <TableCell><StatusBadge status={order.status} /></TableCell>
          <TableCell>{money(order.itemSubtotalKsh)}</TableCell>
          <TableCell>{order.commission ? `${order.commission.status} / ${money(order.commission.commissionAmountKsh)}` : t("未生成")}</TableCell>
        </TableRow>
      ))}
    </DataCard>
  );
}

function CommissionsView({
  commissions,
  busy,
  canApprove,
  onAction
}: {
  commissions: CommissionRow[];
  busy: boolean;
  canApprove: boolean;
  onAction: (commission: CommissionRow, actionName: "confirm" | "reject" | "paid") => void;
}) {
  return (
    <DataCard empty={busy ? t("正在读取佣金...") : t("当前没有佣金。")} colSpan={8} headers={[t("佣金"), t("推广者"), t("订单"), t("顾客"), t("状态"), t("来源"), t("备注"), t("操作")]}>
      {commissions.map((commission) => (
        <TableRow key={commission.id}>
          <TableCell>
            <div className="font-semibold">{money(commission.commissionAmountKsh)}</div>
            <div className="text-muted-foreground text-xs">{rateLabel(commission.rateBps)} / {money(commission.orderSubtotalKsh)}</div>
          </TableCell>
          <TableCell>{commission.affiliate.displayName}<div className="font-mono text-muted-foreground text-xs">{commission.affiliate.affiliateCode}</div></TableCell>
          <TableCell className="font-mono text-xs">{commission.order.orderNumber}<div className="text-muted-foreground">{commission.order.items[0]?.snapshot?.title ?? "-"}</div></TableCell>
          <TableCell>{commission.order.customer.displayName || commission.order.customer.email}<div className="text-muted-foreground text-xs">{commission.order.customer.phone || "-"}</div></TableCell>
          <TableCell><StatusBadge status={commission.status} />{commission.holdReason ? <div className="mt-1 text-destructive text-xs">{commission.holdReason}</div> : null}{["PENDING", "CONFIRMED"].includes(commission.status) && commission.eligibility?.blockingReason ? <div className="mt-1 max-w-64 text-muted-foreground text-xs">{commission.eligibility.blockingReason}</div> : null}</TableCell>
          <TableCell>{commission.attribution?.source || "-"} / {commission.attribution?.campaign || "-"}</TableCell>
          <TableCell className="max-w-48 text-muted-foreground text-xs">{commission.note || "-"}</TableCell>
          <TableCell>
            {canApprove ? (
              <div className="flex flex-wrap gap-2">
                {commission.status === "PENDING" ? <Button size="sm" disabled={busy || Boolean(commission.eligibility?.blockingReason)} onClick={() => void onAction(commission, "confirm")}>{t("确认")}</Button> : null}
                {["PENDING", "CONFIRMED"].includes(commission.status) ? <Button size="sm" disabled={busy} variant="outline" onClick={() => void onAction(commission, "reject")}>{t("驳回")}</Button> : null}
                {commission.status === "CONFIRMED" && !commission.holdReason ? <Button size="sm" disabled={busy || Boolean(commission.eligibility?.blockingReason) || commission.commissionAmountKsh === 0} onClick={() => void onAction(commission, "paid")}>{t("记录已付款")}</Button> : null}
              </div>
            ) : "-"}
          </TableCell>
        </TableRow>
      ))}
    </DataCard>
  );
}

function DataCard({
  headers,
  colSpan,
  empty,
  children
}: {
  headers: string[];
  colSpan: number;
  empty: string;
  children: ReactNode;
}) {
  const rows = Array.isArray(children) ? children : [children];
  const hasRows = rows.some(Boolean);
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header) => <TableHead key={header}>{header}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {hasRows ? children : <EmptyRow colSpan={colSpan} text={empty} />}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="space-y-1">
        <p className="font-medium text-muted-foreground text-sm">{eyebrow}</p>
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        <p className="max-w-3xl text-muted-foreground text-sm">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function StatusMessage({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div className={cn(
      "rounded-lg border px-3 py-2 text-sm",
      tone === "danger" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-200 bg-emerald-50 text-emerald-900"
    )}>
      {children}
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-28 text-center text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "ACTIVE" || status === "PAID" || status === "CONFIRMED"
    ? "default"
    : status === "PENDING"
      ? "secondary"
      : "outline";
  return <Badge variant={tone}>{status}</Badge>;
}

function pageMeta(view: AffiliateView, queue?: CommissionQueueKey) {
  if (view === "links") return { title: t("推广链接"), description: t("生成商城、商品和社媒 campaign 链接。") };
  if (view === "clicks") return { title: t("点击记录"), description: t("查看 ref/source/campaign 带来的访问点击。") };
  if (view === "orders") return { title: t("归因订单"), description: t("查看已保存 Affiliate ID 的订单。") };
  if (view === "commissions") {
    const labels: Record<CommissionQueueKey, string> = {
      pending: t("待确认佣金"),
      confirmed: t("已确认佣金"),
      paid: t("已支付佣金"),
      exceptions: t("异常佣金")
    };
    return { title: labels[queue ?? "pending"], description: t("佣金只在订单支付成功后生成，支付前订单不会产生有效佣金。") };
  }
  return { title: t("推广者列表"), description: t("开通、停用小B推广者，并管理唯一 Affiliate ID。") };
}

async function apiRequest<T>(path: string, options?: RequestOptions): Promise<T> {
  const url = new URL(`${API_PROXY_URL}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await operationsFetch(url.toString(), {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) }
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text || `Request failed: ${response.status}` };
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body ? String((body as { message?: unknown }).message) : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function money(value: number): string {
  return `KSh ${Math.round(value).toLocaleString("en-KE")}`;
}

function AffiliateStats({ affiliate }: { affiliate: AffiliateRow }) {
  const { stats } = affiliate;
  const clicks = affiliate._count.clicks;
  const conversion = clicks > 0 ? `${((stats.paidOrders / clicks) * 100).toFixed(1)}%` : "-";
  return (
    <div className="grid gap-1">
      <div>
        {t("点击 {clicks} / 订单 {orders} / 已付款 {paid} / 未付款 {unpaid} · 转化率 {conversion}", {
          clicks,
          orders: affiliate._count.orders,
          paid: stats.paidOrders,
          unpaid: Math.max(0, affiliate._count.orders - stats.paidOrders),
          conversion
        })}
      </div>
      <div>{t("带来销售额")} {money(stats.salesKsh)}</div>
      <div>
        {t("佣金：待确认 {pending} · 已确认 {confirmed} · 已付款 {paid} · 已拒绝 {rejected}", {
          pending: money(stats.pendingCommissionKsh),
          confirmed: money(stats.confirmedCommissionKsh),
          paid: money(stats.paidCommissionKsh),
          rejected: money(stats.rejectedCommissionKsh)
        })}
      </div>
      <div className="text-muted-foreground text-xs">
        {t("最近点击")} {dateTime(stats.lastClickAt)} · {t("最近下单")} {dateTime(stats.lastOrderAt)}
      </div>
    </div>
  );
}

function rateLabel(value?: number | null): string {
  if (value === null || value === undefined) return t("默认配置");
  return `${(value / 100).toFixed(2)}%`;
}

function dateTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString("en-KE") : "-";
}
