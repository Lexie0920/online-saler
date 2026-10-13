import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const OPERATIONS_ACCESS_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export type OperationsAccessTokenPayload = {
  v: 1;
  sub: string;
  exp: number;
};

export type PermissionScopeValue = "MODULE" | "PAGE" | "ACTION";

export type OperationsPermission = {
  code: string;
  module: string;
  scope: PermissionScopeValue;
  page?: string;
  action?: string;
  description: string;
};

export type OperationsRoleBlueprint = {
  code: string;
  name: string;
  description: string;
  permissions: string[];
};

const MODULES = [
  "product",
  "orders",
  "affiliate",
  "customer-service",
  "analytics",
  "system"
] as const;

const ACTIONS = [
  "view",
  "create",
  "edit",
  "approve",
  "publish",
  "delete",
  "export",
  "manage-users",
  "manage-roles"
] as const;

const modulePermissions: OperationsPermission[] = MODULES.map((module) => ({
  code: `module.${module}`,
  module,
  scope: "MODULE",
  page: undefined,
  action: undefined,
  description: `Access ${module} module.`
}));

const pagePermissions: OperationsPermission[] = [
  {
    code: "page.orders.workbench",
    module: "orders",
    scope: "PAGE",
    page: "orders-workbench",
    action: "view",
    description: "Open the order workbench."
  },
  {
    code: "page.orders.dispatch",
    module: "orders",
    scope: "PAGE",
    page: "orders-dispatch",
    action: "view",
    description: "Open the daily picking, packing and dispatch run."
  },
  {
    code: "page.orders.picking",
    module: "orders",
    scope: "PAGE",
    page: "orders-picking",
    action: "view",
    description: "Open the picker's phone station."
  },
  {
    code: "page.orders.all",
    module: "orders",
    scope: "PAGE",
    page: "orders-all",
    action: "view",
    description: "Open all orders."
  },
  {
    code: "page.orders.after-sale",
    module: "orders",
    scope: "PAGE",
    page: "orders-after-sale",
    action: "view",
    description: "Open after-sale orders."
  },
  {
    code: "page.orders.exceptions",
    module: "orders",
    scope: "PAGE",
    page: "orders-exceptions",
    action: "view",
    description: "Open exception orders."
  },
  {
    code: "page.system.warehouse-locations",
    module: "system",
    scope: "PAGE",
    page: "warehouse-locations",
    action: "view",
    description: "Open warehouse location configuration."
  },
  {
    code: "page.product.warehouse-locations",
    module: "product",
    scope: "PAGE",
    page: "warehouse-locations",
    action: "view",
    description: "Open Product Center warehouse location management."
  },
  {
    code: "page.product.inventory-overview",
    module: "product",
    scope: "PAGE",
    page: "inventory-overview",
    action: "view",
    description: "Open the real-time Product Center inventory overview."
  },
  {
    code: "page.product.digitalization",
    module: "product",
    scope: "PAGE",
    page: "product-digitalization",
    action: "view",
    description: "Open the product digitization workspace."
  },
  {
    code: "page.product.control",
    module: "product",
    scope: "PAGE",
    page: "product-control",
    action: "view",
    description: "Open product review, pricing, warehouse placement, and publish controls."
  },
  {
    code: "page.product.details",
    module: "product",
    scope: "PAGE",
    page: "product-details",
    action: "view",
    description: "Open generated product detail review and approval controls."
  },
  {
    code: "page.orders.node",
    module: "orders",
    scope: "PAGE",
    page: "orders-node",
    action: "view",
    description: "Open the store node fulfillment workbench."
  },
  {
    code: "page.orders.payment-review",
    module: "orders",
    scope: "PAGE",
    page: "orders-payment-review",
    action: "view",
    description: "Open payments and M-Pesa callbacks waiting for manual review."
  },
  {
    code: "page.orders.deposits",
    module: "orders",
    scope: "PAGE",
    page: "orders-deposits",
    action: "view",
    description: "Open the deposit board: garments held against a 50% deposit and the balances coming due."
  },
  {
    code: "page.orders.finance",
    module: "orders",
    scope: "PAGE",
    page: "orders-finance",
    action: "view",
    description: "Open the finance summary for revenue, refunds, delivery cost and commission."
  },
  {
    code: "page.customer-service.cases",
    module: "customer-service",
    scope: "PAGE",
    page: "customer-service-cases",
    action: "view",
    description: "Open the customer service case queue."
  },
  {
    code: "page.customer-service.refunds",
    module: "customer-service",
    scope: "PAGE",
    page: "customer-service-refunds",
    action: "view",
    description: "Open refund requests waiting for finance approval."
  },
  {
    code: "page.rider.deliveries",
    module: "orders",
    scope: "PAGE",
    page: "rider-deliveries",
    action: "view",
    description: "Open the rider's own delivery list on a phone."
  },
  {
    code: "page.orders.riders",
    module: "orders",
    scope: "PAGE",
    page: "orders-riders",
    action: "view",
    description: "Open the store's rider roster."
  },
  {
    code: "page.system.nodes",
    module: "system",
    scope: "PAGE",
    page: "fulfillment-nodes",
    action: "view",
    description: "Open fulfillment node configuration."
  },
  {
    code: "page.system.notifications",
    module: "system",
    scope: "PAGE",
    page: "notifications",
    action: "view",
    description: "Open the outbound notification outbox."
  },
  {
    code: "page.system.accounts",
    module: "system",
    scope: "PAGE",
    page: "accounts",
    action: "view",
    description: "Open admin account management."
  },
  {
    code: "page.system.roles",
    module: "system",
    scope: "PAGE",
    page: "roles",
    action: "view",
    description: "Open role management."
  },
  {
    code: "page.system.permissions",
    module: "system",
    scope: "PAGE",
    page: "permissions",
    action: "view",
    description: "Open permission matrix."
  }
];

const actionPermissions: OperationsPermission[] = MODULES.flatMap((module) =>
  ACTIONS.map((action) => ({
    code: `action.${module}.${action}`,
    module,
    scope: "ACTION" as const,
    page: undefined,
    action,
    description: `Allow ${action} operation in ${module}.`
  }))
);

const orderWorkflowPermissions: OperationsPermission[] = [
  ["orders.view", "view", "View orders and their status history."],
  ["orders.assign-picker", "assign-picker", "Assign or reassign picking work."],
  ["orders.assign-packer", "assign-packer", "Hand a finished trolley to a named packer. A packer without this may only pack parcels assigned to them."],
  ["orders.pick", "pick", "Claim picking work and verify item barcodes."],
  ["orders.pack", "pack", "Start and complete order packing."],
  ["orders.assign-rider", "assign-rider", "Assign an internal or external delivery rider."],
  ["orders.dispatch", "dispatch", "Confirm a parcel was handed to a rider."],
  ["orders.complete", "complete", "Confirm delivery or customer pickup completion."],
  ["orders.cancel", "cancel", "Cancel an eligible order."],
  ["orders.after-sale", "after-sale", "Manage after-sale ownership and status."],
  ["orders.assign-node", "assign-node", "Route an order to a fulfillment node and send its package."],
  ["orders.node-receive", "node-receive", "Confirm a package arrived at a fulfillment node."],
  ["orders.delivery-cost", "delivery-cost", "Record the actual Bolt fare paid for a delivery."],
  ["orders.write-off", "write-off", "Write off a paid order that can never be fulfilled."],
  ["orders.refund", "refund", "Record a refund that was already executed in M-Pesa."],
  ["orders.payment-review", "payment-review", "Resolve payments and callbacks held for manual review."],
  ["orders.resend-code", "resend-code", "Send the customer a replacement delivery code."],
  ["customer-service.assign", "assign", "Give a customer service case an owner."],
  ["customer-service.escalate", "escalate", "Hand a case to fulfillment, finance or an administrator."],
  ["customer-service.contact-update", "contact-update", "Correct a customer phone, WhatsApp number or delivery address."],
  ["customer-service.refund-request", "refund-request", "Ask finance to approve a refund. Never moves money."],
  ["customer-service.refund-approve", "refund-approve", "Approve or reject a refund request. Finance only."],
  ["rider.deliveries", "rider-deliveries", "See and close only the deliveries assigned to you."],
  ["riders.view", "view", "View the riders of a fulfillment node."],
  ["riders.manage", "manage", "Add a rider, change their details, or stand them down."],
  ["nodes.view", "view", "View fulfillment nodes."],
  ["nodes.manage", "manage", "Create, edit, enable and disable fulfillment nodes."],
  ["notifications.view", "view", "View the outbound notification outbox."],
  ["notifications.retry", "retry", "Retry or cancel a queued notification."],
  ["warehouse-locations.view", "view", "View warehouse locations and their products."],
  ["warehouse-locations.manage", "manage", "Create, enable, and disable warehouse locations."],
  ["warehouse-locations.edit-capacity", "edit-capacity", "Edit warehouse location capacity."],
  ["warehouse-locations.move-product", "move-product", "Move eligible inventory between warehouse locations."],
  ["inventory-overview.view", "inventory-overview", "View the real-time warehouse inventory overview."],
  ["analytics.warehouse.view", "warehouse-analytics", "Open advanced warehouse analytics in Metabase."],
  // 2026-10-14: weekly manual M-Pesa payouts. Only SUPER_ADMIN and FINANCE.
  ["finance.payout", "payout", "Open the weekly payout sheet and record an M-Pesa payout already sent by hand. Never moves money."]
].map(([code, action, description]) => ({
  code,
  module: code.startsWith("analytics.") ? "analytics"
    : code.startsWith("finance.") ? "affiliate"
    : code.startsWith("customer-service.") ? "customer-service"
      : code.startsWith("orders.") || code.startsWith("rider.") || code.startsWith("riders.") ? "orders"
        : code.startsWith("nodes.") || code.startsWith("notifications.") ? "system"
          : "product",
  scope: "ACTION" as const,
  action,
  description
}));

export const OPERATIONS_PERMISSIONS = [
  ...modulePermissions,
  ...pagePermissions,
  ...actionPermissions,
  ...orderWorkflowPermissions
] as const satisfies readonly OperationsPermission[];

const allPermissionCodes = OPERATIONS_PERMISSIONS.map((permission) => permission.code);
const readAllModules = MODULES.map((module) => [`module.${module}`, `action.${module}.view`]).flat();

export const OPERATIONS_ROLE_BLUEPRINTS: OperationsRoleBlueprint[] = [
  {
    code: "SUPER_ADMIN",
    name: "Super Admin",
    description: "Full system administration access.",
    permissions: allPermissionCodes
  },
  {
    code: "PROJECT_MANAGER",
    name: "Project Manager",
    description: "Manage daily operation flow without changing system users or roles.",
    permissions: uniquePermissionCodes([
      ...readAllModules,
      "page.product.digitalization",
      "page.product.control",
      "page.product.details",
      "page.orders.workbench",
      "page.orders.dispatch","page.orders.picking",
      "page.orders.all",
      "page.orders.after-sale",
      "page.orders.exceptions",
      "page.system.warehouse-locations",
      "page.product.warehouse-locations",
      "page.product.inventory-overview",
      "action.product.edit",
      "action.product.approve",
      "action.product.publish",
      "action.orders.edit",
      "action.analytics.export",
      "orders.view",
      "orders.assign-picker",
      "orders.assign-packer",
      "orders.pick",
      "orders.pack",
      "orders.assign-rider",
      "orders.dispatch",
      "orders.complete",
      "orders.cancel",
      "orders.after-sale",
      "orders.assign-node",
      "orders.node-receive",
      "orders.delivery-cost",
      "orders.write-off",
      "orders.payment-review",
      "orders.resend-code",
      "action.customer-service.create",
      "action.customer-service.edit",
      "page.customer-service.cases",
      "page.customer-service.refunds",
      "customer-service.assign",
      "customer-service.escalate",
      "customer-service.contact-update",
      "customer-service.refund-request",
      "riders.view",
      "riders.manage",
      "page.orders.node",
      "page.orders.riders",
      "page.orders.payment-review",
      "page.orders.deposits",
      "page.orders.finance",
      "page.system.nodes",
      "page.system.notifications",
      "nodes.view",
      "nodes.manage",
      "notifications.view",
      "notifications.retry",
      "warehouse-locations.view",
      "warehouse-locations.manage",
      "warehouse-locations.edit-capacity",
      "warehouse-locations.move-product",
      "inventory-overview.view",
      "analytics.warehouse.view"
    ])
  },
  {
    code: "PRODUCT_DIGITIZATION",
    name: "Product Digitization",
    description: "Upload, AI review, manual calibration, barcode, and product publishing work.",
    permissions: [
      "module.product",
      "page.product.digitalization",
      "page.product.control",
      "page.product.warehouse-locations",
      "page.product.inventory-overview",
      "action.product.view",
      "action.product.create",
      "action.product.edit",
      "action.product.approve",
      "action.product.publish",
      "warehouse-locations.view",
      "inventory-overview.view"
    ]
  },
  {
    code: "WAREHOUSE_FULFILLMENT",
    name: "Order Fulfillment",
    description: "Order-level picking, packing, pickup, and delivery handoff work.",
    permissions: [
      "module.orders",
      "module.product",
      "page.orders.workbench",
      "page.orders.dispatch","page.orders.picking",
      "page.orders.all",
      "page.orders.exceptions",
      "page.product.warehouse-locations",
      "page.product.inventory-overview",
      "action.orders.view",
      "orders.view",
      "orders.pick",
      "orders.pack",
      "orders.dispatch",
      "orders.complete",
      "orders.assign-node",
      "nodes.view",
      "warehouse-locations.view",
      "inventory-overview.view"
    ]
  },
  {
    code: "STORE_MANAGER",
    name: "Store Staff",
    description: "Receive packages at a store, hand them to its riders or the customer, and keep the rider roster.",
    permissions: [
      "module.orders",
      "page.orders.node",
      "page.orders.riders",
      "action.orders.view",
      "orders.view",
      "orders.node-receive",
      "orders.assign-rider",
      "orders.dispatch",
      "orders.complete",
      "orders.delivery-cost",
      "orders.resend-code",
      "riders.view",
      "riders.manage",
      "nodes.view"
    ]
  },
  {
    code: "DELIVERY_RIDER",
    name: "Delivery Rider",
    description: "See only your own deliveries, enter the customer's code, and report a failed delivery.",
    // Deliberately tiny. No orders module, no order list, no finance, no
    // affiliate: a rider signing in sees one screen with their own drops on it.
    permissions: [
      "page.rider.deliveries",
      "rider.deliveries"
    ]
  },
  {
    code: "ORDER_OPERATIONS",
    name: "Order Operations",
    description: "Order review, payment status follow-up, and order exception handling.",
    permissions: [
      "module.orders",
      "page.orders.workbench",
      "page.orders.dispatch","page.orders.picking",
      "page.orders.all",
      "page.orders.after-sale",
      "page.orders.exceptions",
      "action.orders.view",
      "action.orders.edit",
      "action.orders.approve",
      "action.orders.export",
      "orders.view",
      "orders.assign-picker",
      "orders.assign-packer",
      "orders.assign-rider",
      "orders.cancel",
      "orders.after-sale",
      "orders.assign-node",
      "orders.node-receive",
      "orders.write-off",
      "orders.payment-review",
      "orders.delivery-cost",
      "orders.resend-code",
      "riders.view",
      "page.orders.node",
      "page.orders.riders",
      "page.orders.payment-review",
      "page.orders.deposits",
      "nodes.view",
      "notifications.view",
      "notifications.retry",
      "page.system.notifications"
    ]
  },
  {
    code: "AFFILIATE_OPERATIONS",
    name: "Affiliate Operations",
    description: "Affiliate attribution and commission operation.",
    permissions: [
      "module.affiliate",
      "action.affiliate.view",
      "action.affiliate.edit",
      "action.affiliate.approve",
      "action.affiliate.export"
    ]
  },
  {
    code: "CUSTOMER_SERVICE",
    name: "Customer Service",
    description: "Customer support, return intake, and delivery exception handling.",
    // What customer service can do stops exactly where money, stock and
    // attribution begin. It can ask for a refund but never record one; it can
    // resend a delivery code but never read one; it has no permission that
    // completes a delivery, marks a payment paid, or touches a commission.
    permissions: [
      "module.customer-service",
      "module.orders",
      "page.orders.all",
      "page.orders.after-sale",
      "page.customer-service.cases",
      "page.customer-service.refunds",
      "action.customer-service.view",
      "action.customer-service.create",
      "action.customer-service.edit",
      "customer-service.assign",
      "customer-service.escalate",
      "customer-service.contact-update",
      "customer-service.refund-request",
      "action.orders.view",
      "orders.view",
      "orders.after-sale",
      "orders.resend-code"
    ]
  },
  {
    code: "FINANCE",
    name: "Finance",
    description: "Payment, payout, commission, and export access.",
    permissions: [
      "module.orders",
      "module.affiliate",
      "module.analytics",
      "action.orders.view",
      "orders.view",
      "action.orders.export",
      "action.affiliate.view",
      "action.affiliate.approve",
      "action.affiliate.export",
      "action.analytics.view",
      "action.analytics.export",
      "analytics.warehouse.view",
      "page.orders.all",
      "page.orders.finance",
      "page.orders.payment-review",
      "page.orders.deposits",
      "orders.payment-review",
      "orders.refund",
      // Finance is the only role that can approve a refund request, and the
      // only one that can then record the executed refund against it.
      "module.customer-service",
      "action.customer-service.view",
      "page.customer-service.refunds",
      "customer-service.refund-approve",
      "nodes.view",
      // Finance pays the week: commissions and rider fees, by hand on M-Pesa.
      "finance.payout"
    ]
  },
  {
    code: "DATA_ANALYST",
    name: "Data Analyst",
    description: "Read and export operational analytics.",
    permissions: uniquePermissionCodes([
      ...readAllModules,
      "page.product.inventory-overview",
      "inventory-overview.view",
      "analytics.warehouse.view",
      "action.analytics.export"
    ])
  }
];

export const STAGING_SUPER_ADMIN = {
  id: "00000000-0000-4000-9000-000000000043",
  loginAccount: "superadmin",
  email: "superadmin@online-saler.local",
  name: "Staging Super Admin",
  phone: "+254700000043",
  status: "ACTIVE",
  roleCode: "SUPER_ADMIN",
  linkedEmployee: {
    id: "00000000-0000-4000-8000-000000000001",
    employeeCode: "STAGING-TEST-001",
    name: "Staging Product Operator",
    status: "ACTIVE"
  },
  defaultPassword: "ChangeMe43!"
} as const;

export function uniquePermissionCodes(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort();
}

export function hasOperationsPermission(permissionCodes: readonly string[], required: string): boolean {
  return permissionCodes.includes(required);
}

export function rolePermissionCodes(roleCodes: readonly string[]): string[] {
  const roleSet = new Set(roleCodes);
  const codes = OPERATIONS_ROLE_BLUEPRINTS
    .filter((role) => roleSet.has(role.code))
    .flatMap((role) => role.permissions);
  return uniquePermissionCodes(codes);
}

export function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const digest = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${digest}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const [algorithm, iterations, salt, digest] = storedHash.split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterations || !salt || !digest) return false;
  const expected = pbkdf2Sync(password, salt, Number(iterations), 32, "sha256");
  const actual = Buffer.from(digest, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function issueOperationsAccessToken(
  adminUserId: string,
  passwordHash: string,
  now = new Date()
): { accessToken: string; accessTokenExpiresAt: string } {
  const expiresAt = new Date(now.getTime() + OPERATIONS_ACCESS_TOKEN_TTL_SECONDS * 1000);
  const payload: OperationsAccessTokenPayload = {
    v: 1,
    sub: adminUserId,
    exp: Math.floor(expiresAt.getTime() / 1000)
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = operationsAccessTokenSignature(encodedPayload, passwordHash).toString("base64url");
  return {
    accessToken: `${encodedPayload}.${signature}`,
    accessTokenExpiresAt: expiresAt.toISOString()
  };
}

export function operationsAccessTokenSubject(token: string): string | null {
  return parseOperationsAccessToken(token)?.payload.sub ?? null;
}

export function verifyOperationsAccessToken(
  token: string,
  passwordHash: string,
  now = new Date()
): OperationsAccessTokenPayload | null {
  const parsed = parseOperationsAccessToken(token);
  if (!parsed || parsed.payload.exp <= Math.floor(now.getTime() / 1000)) return null;

  const expected = operationsAccessTokenSignature(parsed.encodedPayload, passwordHash);
  let actual: Buffer;
  try {
    actual = Buffer.from(parsed.signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return parsed.payload;
}

export function bearerOperationsAccessToken(authorization?: string): string | null {
  const match = authorization?.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function operationsAccessTokenSignature(encodedPayload: string, passwordHash: string): Buffer {
  const key = createHash("sha256").update(passwordHash).digest();
  return createHmac("sha256", key).update(encodedPayload).digest();
}

function parseOperationsAccessToken(token: string): { encodedPayload: string; signature: string; payload: OperationsAccessTokenPayload } | null {
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) return null;
  try {
    const value = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<OperationsAccessTokenPayload>;
    if (value.v !== 1 || typeof value.sub !== "string" || !value.sub.trim() || !Number.isInteger(value.exp)) return null;
    return { encodedPayload, signature, payload: value as OperationsAccessTokenPayload };
  } catch {
    return null;
  }
}
