"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  BarChart3Icon,
  BikeIcon,
  BoxesIcon,
  BriefcaseBusinessIcon,
  Building2Icon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  ClipboardCheckIcon,
  ClockIcon,
  FileTextIcon,
  HeadphonesIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  PackageCheckIcon,
  ScanBarcodeIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TruckIcon,
  UserCogIcon,
  UsersIcon,
  WalletCardsIcon,
  XCircleIcon
} from "lucide-react";

import {
  adminInitials,
  canAccessPath,
  firstAllowedPath,
  hasPermission,
  landingPath,
  filterNavigation,
  roleLabels,
  type NavigationItem,
  type NavigationModule
} from "@/components/admin/operations-access";
import { DEFAULT_ADMIN_LOGIN, useOperationsSession } from "@/components/admin/operations-access-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { t } from "@/i18n/runtime";
import { useOperationsI18n } from "@/i18n/provider";
import { OperationsLanguageSwitcher } from "./operations-language-switcher";

type ModuleKey = "product" | "warehouse" | "store" | "rider" | "affiliate" | "service" | "analytics" | "system";

type ModuleItem = NavigationItem & {
  icon: typeof PackageCheckIcon;
};

type ModuleNav = NavigationModule & {
  key: ModuleKey;
  icon: typeof PackageCheckIcon;
  items: ModuleItem[];
};

/**
 * The eight ends of the business, in the order a garment passes through them.
 *
 * Each one is a job someone actually holds, not a table in the database: the
 * person picking in the warehouse never opens the store desk, and the rider
 * never sees an order list. Grouping by job is what lets a role be given one
 * end and nothing else.
 *
 * The first item of each end is its home. Switching ends navigates there, so
 * pressing 门店端 lands on the store desk rather than leaving the old page on
 * screen under a new menu.
 */
export const operationsModules: ModuleNav[] = [
  {
    key: "product",
    label: "商品中心",
    icon: PackageCheckIcon,
    permission: "module.product",
    items: [
      { label: "今日工作", href: "/", icon: LayoutDashboardIcon, permission: "page.product.digitalization", badge: "Live" },
      { label: "新建批次", href: "/product/new-batch", icon: PackageCheckIcon, permission: "page.product.digitalization" },
      {
        label: "进行中批次",
        href: "/product/batches",
        routePrefixes: [
          "/product/calibration",
          "/product/barcode",
          "/product/display-review",
          "/product/review",
          "/product/waiting-upload",
          "/product/waiting-ai",
          "/product/published",
          "/product/rejected"
        ],
        icon: ClipboardCheckIcon,
        permission: "page.product.digitalization"
      },
      { label: "待处理异常", href: "/product/exceptions", icon: XCircleIcon, permission: "page.product.digitalization" },
      { label: "商品管理", href: "/product/manage", icon: PackageCheckIcon, permission: "page.product.digitalization" },
      { label: "商品查询", href: "/product/search", icon: SearchIcon, permission: "page.product.digitalization" },
      { label: "详情生成", href: "/product/details", icon: FileTextIcon, permission: "page.product.details" },
      { label: "分类与属性", href: "/product/taxonomy", icon: SettingsIcon, permission: "page.product.control" },
      { label: "货架位管理", href: "/product/warehouse-locations", icon: BoxesIcon, permission: "page.product.warehouse-locations" },
      { label: "库存概览", href: "/product/inventory-overview", icon: BarChart3Icon, permission: "page.product.inventory-overview" },
      { label: "已完成", href: "/product/completed", icon: PackageCheckIcon, permission: "page.product.digitalization" }
    ]
  },
  {
    key: "warehouse",
    label: "仓库发货",
    icon: BoxesIcon,
    permission: "module.orders",
    items: [
      // The morning's run comes first because it is what the warehouse opens at
      // eight o'clock. The order centre is for looking one order up, which is a
      // rarer and calmer thing to need.
      { label: "每日打单配送", href: "/orders/dispatch", icon: ClipboardCheckIcon, permission: "page.orders.dispatch" },
      // One person, one PC with the label printer: scan a garment and finish its
      // order on one screen. Same permission as the daily run it shortens.
      { label: "打包台", href: "/orders/pack-station", icon: PackageCheckIcon, permission: "page.orders.dispatch" },
      { label: "手机拣货台", href: "/orders/picking", icon: ScanBarcodeIcon, permission: "page.orders.picking" },
      { label: "订单工作台", href: "/orders", icon: LayoutDashboardIcon, permission: "page.orders.workbench" },
      { label: "全部订单", href: "/orders/all", icon: BriefcaseBusinessIcon, permission: "page.orders.all" },
      { label: "异常订单", href: "/orders/exceptions", icon: XCircleIcon, permission: "page.orders.exceptions" }
    ]
  },
  {
    key: "store",
    label: "门店端",
    icon: TruckIcon,
    permission: "module.orders",
    items: [
      { label: "门店手机台", href: "/store", icon: PackageCheckIcon, permission: "page.orders.node" },
      { label: "门店履约台", href: "/orders/node", icon: TruckIcon, permission: "page.orders.node" },
      { label: "门店骑手", href: "/orders/riders", icon: BikeIcon, permission: "page.orders.riders" }
    ]
  },
  {
    key: "rider",
    label: "骑手端",
    icon: BikeIcon,
    permission: "rider.deliveries",
    items: [
      { label: "我的配送单", href: "/rider", icon: BikeIcon, permission: "page.rider.deliveries" }
    ]
  },
  {
    key: "affiliate",
    label: "推广中心",
    icon: CircleDollarSignIcon,
    permission: "module.affiliate",
    items: [
      { label: "推广者列表", href: "/affiliate", icon: UsersIcon, permission: "action.affiliate.view" },
      { label: "推广链接", href: "/affiliate/links", icon: CircleDollarSignIcon, permission: "action.affiliate.view" },
      { label: "点击记录", href: "/affiliate/clicks", icon: SearchIcon, permission: "action.affiliate.view" },
      { label: "归因订单", href: "/affiliate/attributed-orders", icon: BriefcaseBusinessIcon, permission: "action.affiliate.view" },
      { label: "待确认佣金", href: "/affiliate/commissions/pending", icon: ClipboardCheckIcon, permission: "action.affiliate.view" },
      { label: "已确认佣金", href: "/affiliate/commissions/confirmed", icon: ShieldCheckIcon, permission: "action.affiliate.view" },
      { label: "已支付佣金", href: "/affiliate/commissions/paid", icon: PackageCheckIcon, permission: "action.affiliate.view" },
      { label: "异常佣金", href: "/affiliate/commissions/exceptions", icon: XCircleIcon, permission: "action.affiliate.view" },
      // 2026-10-14: the Monday M-Pesa run. Finance and super admins only.
      { label: "周结付款", href: "/affiliate/payouts", icon: WalletCardsIcon, permission: "finance.payout" }
    ]
  },
  {
    key: "service",
    label: "客服端",
    icon: HeadphonesIcon,
    permission: "module.customer-service",
    items: [
      { label: "客服看板", href: "/customer-service", icon: SearchIcon, permission: "action.customer-service.view" },
      { label: "客服工单", href: "/customer-service/cases", icon: ClipboardCheckIcon, permission: "page.customer-service.cases" },
      { label: "退款审批", href: "/customer-service/refunds", icon: CircleDollarSignIcon, permission: "page.customer-service.refunds" },
      { label: "顾客搜索", href: "/customer-service/customers", icon: UsersIcon, permission: "action.customer-service.view" },
      { label: "订单查询", href: "/customer-service/orders", icon: BriefcaseBusinessIcon, permission: "action.customer-service.view" },
      { label: "支付问题", href: "/customer-service/payments", icon: CircleDollarSignIcon, permission: "action.customer-service.view" },
      { label: "自提问题", href: "/customer-service/pickup", icon: ClipboardCheckIcon, permission: "action.customer-service.view" },
      { label: "配送问题", href: "/customer-service/delivery", icon: TruckIcon, permission: "action.customer-service.view" },
      { label: "售后订单", href: "/orders/after-sales", icon: HeadphonesIcon, permission: "page.orders.after-sale" },
      { label: "售后记录", href: "/customer-service/after-sales", icon: HeadphonesIcon, permission: "action.customer-service.view" },
      { label: "备注与标签", href: "/customer-service/notes", icon: SettingsIcon, permission: "action.customer-service.view" }
    ]
  },
  {
    key: "analytics",
    label: "数据中心",
    icon: BarChart3Icon,
    permission: "module.analytics",
    items: [
      { label: "经营概览", href: "/analytics", icon: BarChart3Icon, permission: "action.analytics.view" },
      // The three money screens live here rather than with the warehouse: they
      // are read by whoever is answerable for the cash, not by whoever is
      // holding the parcel.
      { label: "财务汇总", href: "/orders/finance", icon: CircleDollarSignIcon, permission: "page.orders.finance" },
      { label: "支付复核", href: "/orders/payment-review", icon: CircleDollarSignIcon, permission: "page.orders.payment-review" },
      { label: "定金看板", href: "/orders/deposits", icon: ClockIcon, permission: "page.orders.deposits" },
      { label: "高级仓库分析", href: "/analytics/warehouse-bi", icon: BoxesIcon, permission: "analytics.warehouse.view" },
      { label: "搜索分析", href: "/analytics/search-bi", icon: SearchIcon, permission: "action.analytics.view" },
      { label: "商品漏斗", href: "/analytics/product-funnel", icon: LayoutDashboardIcon, permission: "action.analytics.view" },
      { label: "支付转化", href: "/analytics/payment-conversion", icon: CircleDollarSignIcon, permission: "action.analytics.view" },
      { label: "库存售罄", href: "/analytics/inventory-sellout", icon: BoxesIcon, permission: "action.analytics.view" },
      { label: "分类表现", href: "/analytics/category-performance", icon: PackageCheckIcon, permission: "action.analytics.view" },
      { label: "推广者表现", href: "/analytics/affiliate-performance", icon: UsersIcon, permission: "action.analytics.view" },
      { label: "退货与异常", href: "/analytics/returns-exceptions", icon: XCircleIcon, permission: "action.analytics.view" },
      { label: "员工效率", href: "/analytics/employee-efficiency", icon: UserCogIcon, permission: "action.analytics.view" }
    ]
  },
  {
    key: "system",
    label: "系统管理",
    icon: SettingsIcon,
    permission: "module.system",
    items: [
      { label: "商品工厂配置", href: "/system/product-factory", icon: SettingsIcon, permission: "page.product.control" },
      { label: "履约点配置", href: "/system/nodes", icon: TruckIcon, permission: "page.system.nodes" },
      { label: "通知队列", href: "/system/notifications", icon: HeadphonesIcon, permission: "page.system.notifications" },
      { label: "账号管理", href: "/system/accounts", icon: UsersIcon, permission: "page.system.accounts" },
      { label: "角色管理", href: "/system/roles", icon: UserCogIcon, permission: "page.system.roles" },
      { label: "权限管理", href: "/system/permissions", icon: ShieldCheckIcon, permission: "page.system.permissions" }
    ]
  }
];

/**
 * Which end a path belongs to.
 *
 * The specific store and rider paths are tested before the general order paths,
 * because /orders/node is the store's screen even though it starts with /orders.
 * Getting this wrong is what made 我的配送 open with the 商品中心 menu beside it.
 */
function moduleForPath(pathname: string): ModuleKey {
  if (pathname.startsWith("/rider")) return "rider";
  if (pathname.startsWith("/store") || pathname.startsWith("/orders/node") || pathname.startsWith("/orders/riders")) return "store";
  if (pathname.startsWith("/orders/after-sales") || pathname.startsWith("/customer-service")) return "service";
  if (pathname.startsWith("/orders/finance") || pathname.startsWith("/orders/payment-review") || pathname.startsWith("/orders/deposits")) return "analytics";
  if (pathname.startsWith("/warehouse") || pathname.startsWith("/orders")) return "warehouse";
  if (pathname.startsWith("/affiliate")) return "affiliate";
  if (pathname.startsWith("/analytics")) return "analytics";
  if (pathname.startsWith("/system")) return "system";
  if (pathname.startsWith("/product") || pathname.startsWith("/control") || pathname.startsWith("/debug") || pathname === "/") return "product";
  return "product";
}

function sectionForPath(pathname: string): string {
  const matchingItem = operationsModules.flatMap((module) => module.items).find((item) =>
    Boolean(item.href && item.href !== "/" && pathname.startsWith(item.href)) ||
    Boolean(item.routePrefixes?.some((prefix) => pathname.startsWith(prefix)))
  );
  if (matchingItem) return matchingItem.label;
  if (pathname === "/") return t("今日工作");
  if (pathname.startsWith("/control")) return t("商品控制");
  if (pathname.startsWith("/debug")) return t("调试工具");
  return t("工作台");
}

export function OperationsAdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { loading, session, logout } = useOperationsSession();
  const visibleModules = useMemo(() => filterNavigation(operationsModules, session) as ModuleNav[], [session]);
  const router = useRouter();
  // Which end is open is decided by the URL and nothing else. It used to be
  // separate state, which meant pressing an end changed the menu but left the
  // previous page on screen — 我的配送 opening under the 商品中心 sidebar.
  const routeModule = moduleForPath(pathname);

  if (loading) return <LoadingScreen />;
  if (!session?.adminUser) return <LoginScreen />;

  const routeAllowed = canAccessPath(pathname, operationsModules, session);
  const home = landingPath(operationsModules, session);
  // The home page belongs to 商品中心 and needs a product permission, so every
  // other role signed in and met a 403 before touching anything. Send them to
  // their own end instead. Only "/" redirects: a deep link someone genuinely
  // may not open still says so rather than quietly moving them somewhere else.
  if (pathname === "/" && !routeAllowed && home) {
    return <HomeRedirect to={home} />;
  }
  // Embedded in another system's phone workbench. The host already provides the
  // frame, the navigation and the identity, so this renders the screen and
  // nothing around it — a sidebar inside somebody else's phone mock is not a
  // smaller version of this app, it is a broken one. Sign-in and the permission
  // check above still apply: whoever taps the tile signs in as themselves.
  if (pathname.startsWith("/embed/")) {
    return <div className="min-h-dvh bg-background p-3">{routeAllowed ? children : <AccessDenied />}</div>;
  }

  const fallbackModule: ModuleNav = visibleModules[0] ?? operationsModules[0];
  const activeModule: ModuleNav = visibleModules.find((module) => module.key === routeModule) ?? fallbackModule;
  const routeSection = sectionForPath(pathname);

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "17rem"
        } as CSSProperties
      }
    >
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Building2Icon data-icon="inline-start" />
            </div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate font-medium text-sm">Online Saler</p>
              <p className="truncate text-muted-foreground text-xs">Operations</p>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{t(activeModule.label)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {activeModule.items.map((item) => {
                  const Icon = item.icon ?? PackageCheckIcon;
                  const isActive = Boolean(item.href && (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)));
                  const content = (
                    <>
                      <Icon />
                      <span>{t(item.label)}</span>
                    </>
                  );

                  return (
                    <SidebarMenuItem key={`${activeModule.key}-${item.label}`}>
                      {item.href ? (
                        <SidebarMenuButton asChild isActive={isActive} tooltip={t(item.label)}>
                          <Link href={item.href}>{content}</Link>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton type="button" aria-disabled="true" className="opacity-60" tooltip={t(item.label)}>
                          {content}
                        </SidebarMenuButton>
                      )}
                      {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="rounded-lg border bg-background p-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            
            {t("后台账号、角色和权限由系统管理统一控制。")}
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-x-clip [--operations-header-height:--spacing(13)]">
        <header className="sticky top-0 z-20 flex min-h-13 shrink-0 flex-col gap-2 border-b bg-background/90 px-4 py-2 backdrop-blur md:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <Link href="/">Operations</Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator>
                    <ChevronRightIcon />
                  </BreadcrumbSeparator>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{t(activeModule.label)}</BreadcrumbPage>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator>
                    <ChevronRightIcon />
                  </BreadcrumbSeparator>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{t(routeSection)}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <OperationsLanguageSwitcher />
              <Badge variant="secondary" className="hidden md:inline-flex">
                Staging
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-9 gap-2 px-2">
                    <Avatar className="size-7">
                      <AvatarFallback>{adminInitials(session.adminUser)}</AvatarFallback>
                    </Avatar>
                    <span className="hidden max-w-36 truncate md:inline">{session.adminUser.name}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>
                    <div className="flex flex-col gap-1">
                      <span>{session.adminUser.name}</span>
                      <span className="font-normal text-muted-foreground text-xs">{roleLabels(session)}</span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout}>
                    <LogOutIcon />
                    
                    {t("退出登录")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {/*
            Shown at every width. Hiding it below md took away the only way to
            change ends: the sidebar lists the pages of the end you are already
            in, so a narrow window — a laptop at 200% zoom counts — left you
            wherever you landed with no way out. The row already scrolls
            sideways, which is all a phone needs.
          */}
          <nav className="flex gap-1 overflow-x-auto pb-1" aria-label="Operations modules">
            {visibleModules.map((module) => {
              const Icon = module.icon;
              const selected = module.key === activeModule.key;
              return (
                <Button
                  key={module.key}
                  type="button"
                  variant={selected ? "secondary" : "ghost"}
                  size="sm"
                  className={cn("shrink-0", selected && "shadow-xs")}
                  onClick={() => {
                    // The first item this account can see is that end's home.
                    const home = module.items.find((item) => item.href)?.href;
                    if (home) router.push(home);
                  }}
                >
                  <Icon data-icon="inline-start" />
                  {t(module.label)}
                </Button>
              );
            })}
          </nav>
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 md:p-6">
          {routeAllowed ? children : <AccessDenied />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function LoadingScreen() {
  const { t } = useOperationsI18n();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader>
          <CardTitle>{t("正在打开 Online Saler Operations")}</CardTitle>
          <CardDescription>{t("正在读取后台账号和权限。")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/2 rounded-full bg-primary" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Sends a role to its own home. Rendered rather than redirected from an effect
 * high in the tree so the replace happens once, after paint, with something on
 * screen in the meantime — a blank flash on a phone reads as a crash.
 */
function HomeRedirect({ to }: { to: string }) {
  const router = useRouter();
  const { t } = useOperationsI18n();

  useEffect(() => {
    router.replace(to);
  }, [router, to]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
      <p className="text-muted-foreground text-sm">{t("正在打开你的工作台…")}</p>
    </div>
  );
}

function LoginScreen() {
  const { t } = useOperationsI18n();
  const { login, error } = useOperationsSession();
  const router = useRouter();
  const [loginAccount, setLoginAccount] = useState(DEFAULT_ADMIN_LOGIN);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  async function submit() {
    setBusy(true);
    setLocalError("");
    try {
      const next = await login(loginAccount, password);
      const home = landingPath(operationsModules, next);
      if (home && window.location.pathname === "/") router.replace(home);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : t("登录失败。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-muted/30 p-4 md:p-8">
      <div className="mx-auto grid min-h-[calc(100vh-2rem)] w-full max-w-6xl overflow-hidden rounded-2xl border bg-background shadow-sm md:min-h-[calc(100vh-4rem)] lg:grid-cols-[1fr_440px]">
        <section className="hidden border-r bg-sidebar p-10 lg:flex lg:flex-col lg:justify-between">
          <div className="flex flex-col gap-10">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Building2Icon />
              </div>
              <div>
                <p className="font-semibold text-lg">Online Saler</p>
                <p className="text-muted-foreground text-sm">Operations Control Center</p>
              </div>
            </div>

            <div className="max-w-xl">
              <Badge variant="secondary">Staging</Badge>
              <h1 className="mt-5 font-semibold text-4xl tracking-tight">
                
                {t("Kikuyu 二手服装运营中台")}
              </h1>
              <p className="mt-4 text-muted-foreground">
                
                {t("用一套后台完成商品数字化、订单全流程处理、推广佣金、客服和数据分析。")}
              </p>
            </div>

            <div className="grid gap-3">
              {[
                [t("商品中心"), t("批次、AI 识别、人工校准、Barcode 和发布")],
                [t("订单中心"), t("从付款、拣货和打包到自提、配送、售后与异常")],
                [t("系统权限"), t("后台账号、角色和操作权限统一控制")]
              ].map(([title, description]) => (
                <div key={title} className="flex gap-3 rounded-xl border bg-background/70 p-4">
                  <ShieldCheckIcon className="mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{title}</p>
                    <p className="text-muted-foreground text-sm">{description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            
            {t("顾客 Google 登录和后台员工登录相互独立。这里仅用于内部运营人员。")}
          </p>
        </section>

        <section className="flex items-center justify-center p-4 md:p-10">
          <Card className="w-full max-w-md shadow-none ring-0">
            <CardHeader>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground lg:hidden">
                  <Building2Icon />
                </div>
                <div className="ml-auto">
                  <OperationsLanguageSwitcher />
                </div>
              </div>
              <CardTitle className="text-2xl">{t("后台登录")}</CardTitle>
              <CardDescription>{t("使用后台账号进入 Operations。顾客 Google 登录不适用于这里。")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="admin-login">{t("登录账号或邮箱")}</Label>
                <Input
                  id="admin-login"
                  autoComplete="username"
                  value={loginAccount}
                  onChange={(event) => setLoginAccount(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="admin-password">{t("密码")}</Label>
                <Input
                  id="admin-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  placeholder={t("输入后台密码")}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                />
              </div>
              {localError || error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive text-sm">
                  {localError || error}
                </div>
              ) : null}
              <div className="rounded-lg border bg-muted/40 p-3 text-muted-foreground text-sm">
                
                {t("Staging 默认账号是")} <span className="font-mono text-foreground">superadmin</span>{t("。如果密码无效，需要重置 Staging Super Admin。")}
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button className="w-full" disabled={busy} onClick={() => void submit()}>
                {busy ? t("正在登录...") : t("登录后台")}
              </Button>
              <p className="text-center text-muted-foreground text-xs">
                
                {t("所有后台操作会按账号、角色和权限记录。")}
              </p>
            </CardFooter>
          </Card>
        </section>
      </div>
    </div>
  );
}

function AccessDenied() {
  return (
    <Card className="mx-auto mt-12 max-w-lg">
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
          <ShieldCheckIcon />
        </div>
        <CardTitle>{t("403 无权限访问")}</CardTitle>
        <CardDescription>{t("当前后台账号没有访问这个页面的权限。")}</CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        
        {t("请联系 Super Admin 调整角色或权限。")}
      </CardContent>
    </Card>
  );
}
