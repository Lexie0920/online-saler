import { pbkdf2Sync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modules = ["product", "orders", "affiliate", "customer-service", "analytics", "system"];
const actions = ["view", "create", "edit", "approve", "publish", "delete", "export", "manage-users", "manage-roles"];

export const permissions = [
  ...modules.map((module) => ({
    code: `module.${module}`,
    module,
    scope: "MODULE",
    description: `Access ${module} module.`
  })),
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
    code: "page.orders.deposits",
    module: "orders",
    scope: "PAGE",
    page: "orders-deposits",
    action: "view",
    description: "Open the deposit board: garments held against a 50% deposit and the balances coming due."
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
    code: "page.system.permissions",
    module: "system",
    scope: "PAGE",
    page: "permissions",
    action: "view",
    description: "Open permission matrix."
  },
  ...modules.flatMap((module) =>
    actions.map((action) => ({
      code: `action.${module}.${action}`,
      module,
      scope: "ACTION",
      action,
      description: `Allow ${action} operation in ${module}.`
    }))
  ),
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
    code: "page.orders.finance",
    module: "orders",
    scope: "PAGE",
    page: "orders-finance",
    action: "view",
    description: "Open the finance summary for revenue, refunds, delivery cost and commission."
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
  ...[
    ["orders.view", "orders", "view", "View orders and their status history."],
    ["orders.assign-picker", "orders", "assign-picker", "Assign or reassign picking work."],
    ["orders.assign-packer", "orders", "assign-packer", "Hand a finished trolley to a named packer."],
    ["orders.pick", "orders", "pick", "Claim picking work and verify item barcodes."],
    ["orders.pack", "orders", "pack", "Start and complete order packing."],
    ["orders.assign-rider", "orders", "assign-rider", "Assign an internal or external delivery rider."],
    ["orders.dispatch", "orders", "dispatch", "Confirm a parcel was handed to a rider."],
    ["orders.complete", "orders", "complete", "Confirm delivery or customer pickup completion."],
    ["orders.cancel", "orders", "cancel", "Cancel an eligible order."],
    ["orders.after-sale", "orders", "after-sale", "Manage after-sale ownership and status."],
    ["orders.resend-code", "orders", "resend-code", "Send the customer a replacement delivery code."],
    ["customer-service.assign", "customer-service", "assign", "Give a customer service case an owner."],
    ["customer-service.escalate", "customer-service", "escalate", "Hand a case to fulfillment, finance or an administrator."],
    ["customer-service.contact-update", "customer-service", "contact-update", "Correct a customer phone, WhatsApp number or delivery address."],
    ["customer-service.refund-request", "customer-service", "refund-request", "Ask finance to approve a refund. Never moves money."],
    ["customer-service.refund-approve", "customer-service", "refund-approve", "Approve or reject a refund request. Finance only."],
    ["orders.refund", "orders", "refund", "Record a refund that was already executed in M-Pesa."],
    ["warehouse-locations.view", "product", "view", "View warehouse locations and their products."],
    ["warehouse-locations.manage", "product", "manage", "Create, enable, and disable warehouse locations."],
    ["warehouse-locations.edit-capacity", "product", "edit-capacity", "Edit warehouse location capacity."],
    ["warehouse-locations.move-product", "product", "move-product", "Move eligible inventory between warehouse locations."],
    ["inventory-overview.view", "product", "inventory-overview", "View the real-time warehouse inventory overview."],
    ["analytics.warehouse.view", "analytics", "warehouse-analytics", "Open advanced warehouse analytics in Metabase."],
    ["orders.assign-node", "orders", "assign-node", "Route an order to a fulfillment node and send its package."],
    ["orders.node-receive", "orders", "node-receive", "Confirm a package arrived at a fulfillment node."],
    ["orders.delivery-cost", "orders", "delivery-cost", "Record the actual Bolt fare paid for a delivery."],
    ["orders.write-off", "orders", "write-off", "Write off a paid order that can never be fulfilled."],
    ["orders.payment-review", "orders", "payment-review", "Resolve payments and callbacks held for manual review."],
    ["rider.deliveries", "orders", "rider-deliveries", "See and close only the deliveries assigned to you."],
    ["riders.view", "orders", "view", "View the riders of a fulfillment node."],
    ["riders.manage", "orders", "manage", "Add a rider, change their details, or stand them down."],
    ["nodes.view", "system", "view", "View fulfillment nodes."],
    ["nodes.manage", "system", "manage", "Create, edit, enable and disable fulfillment nodes."],
    ["notifications.view", "system", "view", "View the outbound notification outbox."],
    ["notifications.retry", "system", "retry", "Retry or cancel a queued notification."],
    ["finance.payout", "affiliate", "payout", "Open the weekly payout sheet and record an M-Pesa payout already sent by hand. Never moves money."]
  ].map(([code, module, action, description]) => ({ code, module, scope: "ACTION", action, description }))
];

const allPermissionCodes = permissions.map((permission) => permission.code);
const readAllModules = modules.flatMap((module) => [`module.${module}`, `action.${module}.view`]);

function unique(codes) {
  return [...new Set(codes)].sort();
}

export const roles = [
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
    permissions: unique(["action.affiliate.view","action.analytics.export","action.analytics.view","action.customer-service.create","action.customer-service.edit","action.customer-service.view","action.orders.edit","action.orders.view","action.product.approve","action.product.edit","action.product.publish","action.product.view","action.system.view","analytics.warehouse.view","customer-service.assign","customer-service.contact-update","customer-service.escalate","customer-service.refund-request","inventory-overview.view","module.affiliate","module.analytics","module.customer-service","module.orders","module.product","module.system","nodes.manage","nodes.view","notifications.retry","notifications.view","orders.after-sale","orders.assign-node","orders.assign-picker", "orders.assign-packer","orders.assign-rider","orders.cancel","orders.complete","orders.delivery-cost","orders.dispatch","orders.node-receive","orders.pack","orders.payment-review","orders.pick","orders.resend-code","orders.view","orders.write-off","page.customer-service.cases","page.customer-service.refunds","page.orders.after-sale","page.orders.all","page.orders.deposits","page.orders.exceptions","page.orders.finance","page.orders.node","page.orders.payment-review","page.orders.riders","page.orders.dispatch","page.orders.picking","page.orders.workbench","page.product.control","page.product.details","page.product.digitalization","page.product.inventory-overview","page.product.warehouse-locations","page.system.nodes","page.system.notifications","page.system.warehouse-locations","riders.manage","riders.view","warehouse-locations.edit-capacity","warehouse-locations.manage","warehouse-locations.move-product","warehouse-locations.view"])
  },
  {
    code: "PRODUCT_DIGITIZATION",
    name: "Product Digitization",
    description: "Upload, AI review, manual calibration, barcode, and product publishing work.",
    permissions: unique(["action.product.approve","action.product.create","action.product.edit","action.product.publish","action.product.view","inventory-overview.view","module.product","page.product.control","page.product.digitalization","page.product.inventory-overview","page.product.warehouse-locations","warehouse-locations.view"])
  },
  {
    code: "WAREHOUSE_FULFILLMENT",
    name: "Order Fulfillment",
    description: "Order-level picking, packing, pickup, and delivery handoff work.",
    permissions: unique(["action.orders.view","inventory-overview.view","module.orders","module.product","nodes.view","orders.assign-node","orders.complete","orders.dispatch","orders.pack","orders.pick","orders.view","page.orders.all","page.orders.exceptions","page.orders.dispatch","page.orders.picking","page.orders.workbench","page.product.inventory-overview","page.product.warehouse-locations","warehouse-locations.view"])
  },
  {
    code: "STORE_MANAGER",
    name: "Store Staff",
    description: "Receive packages at a store, hand them to its riders or the customer, and keep the rider roster.",
    permissions: unique(["action.orders.view","module.orders","nodes.view","orders.assign-rider","orders.complete","orders.delivery-cost","orders.dispatch","orders.node-receive","orders.resend-code","orders.view","page.orders.node","page.orders.riders","riders.manage","riders.view"])
  },
  {
    code: "DELIVERY_RIDER",
    name: "Delivery Rider",
    description: "See only your own deliveries, enter the customer's code, and report a failed delivery.",
    permissions: unique(["page.rider.deliveries","rider.deliveries"])
  },
  {
    code: "ORDER_OPERATIONS",
    name: "Order Operations",
    description: "Order review, payment status follow-up, and order exception handling.",
    permissions: unique(["action.orders.approve","action.orders.edit","action.orders.export","action.orders.view","module.orders","nodes.view","notifications.retry","notifications.view","orders.after-sale","orders.assign-node","orders.assign-picker", "orders.assign-packer","orders.assign-rider","orders.cancel","orders.delivery-cost","orders.node-receive","orders.payment-review","orders.resend-code","orders.view","orders.write-off","page.orders.after-sale","page.orders.all","page.orders.deposits","page.orders.exceptions","page.orders.node","page.orders.payment-review","page.orders.riders","page.orders.dispatch","page.orders.picking","page.orders.workbench","page.system.notifications","riders.view"])
  },
  {
    code: "AFFILIATE_OPERATIONS",
    name: "Affiliate Operations",
    description: "Affiliate attribution and commission operation.",
    permissions: unique(["action.affiliate.approve","action.affiliate.edit","action.affiliate.export","action.affiliate.view","module.affiliate"])
  },
  {
    code: "CUSTOMER_SERVICE",
    name: "Customer Service",
    description: "Customer support, return intake, and delivery exception handling.",
    permissions: unique(["action.customer-service.create","action.customer-service.edit","action.customer-service.view","action.orders.view","customer-service.assign","customer-service.contact-update","customer-service.escalate","customer-service.refund-request","module.customer-service","module.orders","orders.after-sale","orders.resend-code","orders.view","page.customer-service.cases","page.customer-service.refunds","page.orders.after-sale","page.orders.all"])
  },
  {
    code: "FINANCE",
    name: "Finance",
    description: "Payment, payout, commission, and export access.",
    permissions: unique(["action.affiliate.approve","action.affiliate.export","action.affiliate.view","action.analytics.export","action.analytics.view","action.customer-service.view","action.orders.export","action.orders.view","analytics.warehouse.view","customer-service.refund-approve","finance.payout","module.affiliate","module.analytics","module.customer-service","module.orders","nodes.view","orders.payment-review","orders.refund","orders.view","page.customer-service.refunds","page.orders.all","page.orders.deposits","page.orders.finance","page.orders.payment-review"])
  },
  {
    code: "DATA_ANALYST",
    name: "Data Analyst",
    description: "Read and export operational analytics.",
    permissions: unique(["action.affiliate.view","action.analytics.export","action.analytics.view","action.customer-service.view","action.orders.view","action.product.view","action.system.view","analytics.warehouse.view","inventory-overview.view","module.affiliate","module.analytics","module.customer-service","module.orders","module.product","module.system","page.product.inventory-overview"])
  }
];

const linkedEmployee = {
  id: "00000000-0000-4000-8000-000000000001",
  employeeCode: "STAGING-TEST-001",
  name: "Staging Product Operator",
  status: "ACTIVE"
};

const superAdmin = {
  id: "00000000-0000-4000-9000-000000000043",
  loginAccount: "superadmin",
  email: "superadmin@online-saler.local",
  name: "Staging Super Admin",
  phone: "+254700000043",
  status: "ACTIVE",
  roleCode: "SUPER_ADMIN",
  password: process.env.OPERATIONS_SUPER_ADMIN_PASSWORD || "ChangeMe43!"
};

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const digest = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${digest}`;
}

/**
 * Grants no blueprint may ever hand out, checked again at the moment of writing.
 *
 * Refunds are a two-person control: customer service raises the request and
 * finance approves it. A customer service role that could also approve would be
 * both halves, so this holds even if somebody edits the blueprint by mistake.
 * (An administrator can still tick it by hand in role management; that is their
 * call, not the deployment's.)
 */
export const forbiddenGrants = {
  CUSTOMER_SERVICE: ["customer-service.refund-approve"]
};

/**
 * Where the baseline remembers which default grants it has already offered each
 * role. A single system setting rather than a new table, so the backfill needs
 * no schema change: `{ "<ROLE_CODE>": ["<permission code>", ...] }`.
 */
export const ROLE_GRANT_LEDGER_KEY = "access.roleDefaultGrants.offered";

/** A role's default permissions, minus anything it must never hold. */
export function defaultGrantsFor(role) {
  const forbidden = new Set(forbiddenGrants[role.code] ?? []);
  return unique(role.permissions.filter((code) => !forbidden.has(code)));
}

/**
 * What one deployment does to one role. Pure, so the rules can be tested
 * without a database.
 *
 * - `offered` is what earlier deployments already offered this role. Those are
 *   never offered again, so a permission an administrator took away stays away.
 * - Everything else in the role's defaults is offered now: granted if the role
 *   does not already hold it, and recorded as offered either way.
 * - A role that exists but holds nothing was switched off by hand. It is not
 *   filled back in; its defaults are only recorded, so it stays off.
 * - Nothing here ever removes a grant.
 */
export function planRoleBackfill(role, { exists, held, offered }) {
  const defaults = defaultGrantsFor(role);
  const offer = defaults.filter((code) => !offered.has(code));
  if (!exists) return { create: defaults, grant: [], offer };
  if (held.size === 0) return { create: [], grant: [], offer };
  return { create: [], grant: offer.filter((code) => !held.has(code)), offer };
}

function readLedger(setting) {
  const value = setting?.valueJson;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([roleCode, codes]) => [roleCode, Array.isArray(codes) ? codes.map(String) : []])
  );
}

/**
 * Brings every role up to its defaults, additively.
 *
 * A feature that shipped new permission codes used to arrive invisible: the
 * role already existed, `update: {}` left it alone, and the screens answered 403
 * until somebody ticked boxes by hand. An earlier fix only topped roles up with
 * codes the database had never seen, which missed every code that already
 * existed for some other role -- the deposit board, packer hand-off and the
 * customer service desk all fell through that gap.
 *
 * Now each default grant is offered exactly once per role, and the ledger
 * remembers it. The first deployment with this code has an empty ledger, so it
 * offers every default an existing role is missing.
 *
 * Only inserts: missing Permission rows, missing role links, and the ledger.
 * Never deletes a link, never edits a role, a permission or a link that exists.
 */
async function backfillRolePermissions(prisma) {
  const rolesBefore = new Set(
    (await prisma.role.findMany({ select: { code: true } })).map((row) => row.code)
  );
  const ledgerRow = await prisma.systemSetting.findUnique({ where: { key: ROLE_GRANT_LEDGER_KEY } });
  const ledger = readLedger(ledgerRow);

  // Missing permission rows are created; existing ones are left exactly as
  // they are, description included.
  for (const permission of permissions) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: {},
      create: permission
    });
  }

  const granted = {};
  let ledgerChanged = false;
  for (const role of roles) {
    const exists = rolesBefore.has(role.code);
    const held = exists
      ? new Set(
          (
            await prisma.rolePermission.findMany({
              where: { role: { code: role.code } },
              select: { permission: { select: { code: true } } }
            })
          ).map((row) => row.permission.code)
        )
      : new Set();
    const plan = planRoleBackfill(role, { exists, held, offered: new Set(ledger[role.code] ?? []) });

    if (!exists) {
      await prisma.role.upsert({
        where: { code: role.code },
        update: {},
        create: {
          code: role.code,
          name: role.name,
          description: role.description,
          permissions: {
            create: plan.create.map((code) => ({ permission: { connect: { code } } }))
          }
        }
      });
    }

    for (const code of plan.grant) {
      await prisma.rolePermission.create({
        data: { role: { connect: { code: role.code } }, permission: { connect: { code } } }
      });
    }
    if (plan.grant.length) granted[role.code] = plan.grant;

    if (plan.offer.length) {
      ledger[role.code] = unique([...(ledger[role.code] ?? []), ...plan.offer]);
      ledgerChanged = true;
    }
  }

  if (ledgerChanged) {
    await prisma.systemSetting.upsert({
      where: { key: ROLE_GRANT_LEDGER_KEY },
      update: { valueJson: ledger },
      create: { key: ROLE_GRANT_LEDGER_KEY, valueJson: ledger, scope: "GLOBAL" }
    });
  }

  return granted;
}

export async function seedStagingBaseline(prisma) {
  const granted = await backfillRolePermissions(prisma);

  const employee = await prisma.employee.upsert({
    where: { employeeCode: linkedEmployee.employeeCode },
    update: {},
    create: linkedEmployee
  });

  const adminUser = await prisma.adminUser.upsert({
    where: { loginAccount: superAdmin.loginAccount },
    update: {},
    create: {
      id: superAdmin.id,
      name: superAdmin.name,
      email: superAdmin.email,
      loginAccount: superAdmin.loginAccount,
      phone: superAdmin.phone,
      passwordHash: hashPassword(superAdmin.password),
      status: superAdmin.status,
      linkedEmployeeId: employee.id,
      roles: { create: { role: { connect: { code: superAdmin.roleCode } } } }
    }
  });

  await prisma.systemSetting.upsert({
    where: { key: "affiliate.defaultCommissionRateBps" },
    update: {},
    create: {
      key: "affiliate.defaultCommissionRateBps",
      valueJson: 2500,
      scope: "GLOBAL"
    }
  });

  const affiliate = await prisma.affiliate.upsert({
    where: { affiliateCode: "DL-AFF-001" },
    update: {},
    create: {
      affiliateCode: "DL-AFF-001",
      slug: "staging-affiliate",
      displayName: "Staging Affiliate",
      phone: "+254700000046",
      email: "affiliate@online-saler.local",
      status: "ACTIVE",
      commissionRateBps: 2500
    }
  });

  await prisma.affiliateLink.upsert({
    where: { linkCode: "DL-AFF-001-STORE-WA" },
    update: {},
    create: {
      affiliateId: affiliate.id,
      linkCode: "DL-AFF-001-STORE-WA",
      type: "STORE",
      landingPath: "/",
      source: "whatsapp",
      placement: "direct-message",
      campaign: "staging"
    }
  });

  return { adminUserId: adminUser.id, loginAccount: adminUser.loginAccount, granted };
}

function printGranted(granted) {
  const entries = Object.entries(granted);
  if (!entries.length) {
    console.log("Role permissions: every role already had its defaults; nothing added.");
    return;
  }
  for (const [roleCode, codes] of entries) {
    console.log(`Role permissions: ${roleCode} gained ${codes.join(", ")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  // --dry-run runs the whole baseline inside a transaction and rolls it back,
  // printing what a real deployment would add without writing anything.
  const dryRun = process.argv.includes("--dry-run");
  const rollback = new Error("DRY_RUN_ROLLBACK");
  try {
    if (dryRun) {
      let preview;
      try {
        await prisma.$transaction(async (tx) => {
          preview = await seedStagingBaseline(tx);
          throw rollback;
        }, { timeout: 60_000 });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      console.log("Dry run: nothing was written.");
      printGranted(preview.granted);
    } else {
      const result = await seedStagingBaseline(prisma);
      printGranted(result.granted);
      console.log(`Staging admin access baseline ready: ${result.loginAccount}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
