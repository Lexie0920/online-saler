import "reflect-metadata";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { prisma } from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsFulfillmentService, isSuperAdminSession } from "./operations-fulfillment.service";
import { ProductImageStorageService } from "../product/product-image-storage.service";
import {
  CODELESS_COMPLETION_ACTION,
  CODELESS_COMPLETION_STATUSES,
  canTransitionFulfillment
} from "./operations-fulfillment-state";
import { commissionEligibility } from "./operations-commission-policy";

/**
 * Two owner decisions of 2026-10-13.
 *
 * 改派拣货员 — a supervisor can move an order that is already being picked (or
 * packed) to someone else, with a reason, without losing the scans already done.
 *
 * 无码补登 — a super admin, and only a super admin, can complete an order whose
 * customer code was never read out. It goes through the ordinary completion, so
 * the stock, the timeline and the commission behave as for a coded handover.
 */

type Session = { adminUser: { id: string; linkedEmployee: { id: string } | null } | null; roles: Array<{ code: string }>; permissions: string[] };

const SUPERVISOR: Session = {
  adminUser: { id: "admin-supervisor", linkedEmployee: { id: "emp-supervisor" } },
  roles: [{ code: "PROJECT_MANAGER" }],
  permissions: ["orders.view", "orders.assign-picker", "orders.assign-packer", "orders.complete"]
};
const STORE_STAFF: Session = {
  adminUser: { id: "admin-store", linkedEmployee: { id: "emp-store" } },
  roles: [{ code: "STORE_STAFF" }],
  permissions: ["orders.view", "orders.complete", "orders.pick"]
};
const SUPER_ADMIN: Session = {
  adminUser: { id: "admin-super", linkedEmployee: null },
  roles: [{ code: "SUPER_ADMIN" }],
  permissions: ["orders.view", "orders.assign-picker", "orders.assign-packer", "orders.complete"]
};

const EMPLOYEES: Record<string, { id: string; name: string }> = {
  "emp-textdabao": { id: "emp-textdabao", name: "textdabao" },
  "emp-faith": { id: "emp-faith", name: "Faith2026" }
};

function fixture(
  t: TestContext,
  options: {
    session?: Session;
    status?: string;
    method?: "PICKUP" | "KIKUYU_LOCAL_DELIVERY";
    picker?: string | null;
    packer?: string | null;
    packingStartedAt?: Date | null;
    items?: Array<{ orderItemId: string; status: "PENDING" | "VERIFIED" }>;
    orders?: Record<string, { status: string; orderNumber: string }>;
  } = {}
) {
  const session = options.session ?? SUPERVISOR;
  const events: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const fulfillmentWrites: Array<Record<string, unknown>> = [];
  const orderWrites: Array<Record<string, unknown>> = [];
  const inventoryWrites: Array<Record<string, unknown>> = [];
  const itemWrites: Array<Record<string, unknown>> = [];

  function makeOrder(id: string, status: string, orderNumber: string) {
    const picker = options.picker === undefined ? "emp-textdabao" : options.picker;
    const packer = options.packer ?? null;
    const row = {
      id: `fulfillment-${id}`,
      status,
      assignedPickerEmployeeId: picker,
      assignedPackerEmployeeId: packer,
      packingStartedAt: options.packingStartedAt ?? null,
      packingStartedByEmployeeId: options.packingStartedAt ? packer : null,
      deliveryRiderId: null,
      deliveryAttemptCount: 0,
      fulfillmentNodeId: "node-kinoo"
    };
    return {
      row,
      order: {
        id,
        orderNumber,
        status: "FULFILLING",
        fulfillmentMethod: options.method ?? "PICKUP",
        totalKsh: 500,
        pickupCode: "4417",
        whatsappPhone: null,
        customer: { displayName: "Wanjiku", phone: "0712345678" },
        items: [
          { id: "item-1", productId: "product-1", snapshot: { title: "Denim jacket", barcode: "B1" } },
          { id: "item-2", productId: "product-2", snapshot: { title: "Skirt", barcode: "B2" } }
        ],
        fulfillmentNode: { id: "node-kinoo", type: "STORE", name: "Kinoo", phone: null },
        fulfillment: {
          ...row,
          assignedPicker: picker ? EMPLOYEES[picker] ?? null : null,
          assignedPacker: packer ? EMPLOYEES[packer] ?? null : null,
          fulfillmentNode: { id: "node-kinoo", type: "STORE", name: "Kinoo" },
          items: options.items ?? [
            { orderItemId: "item-1", status: "VERIFIED" },
            { orderItemId: "item-2", status: "PENDING" }
          ],
          deliveryAssignments: [],
          deliveryRider: null
        }
      }
    };
  }

  const definitions = options.orders ?? { order: { status: options.status ?? "PICKING", orderNumber: "DL-1001" } };
  const built = new Map(Object.entries(definitions).map(([id, value]) => [id, makeOrder(id, value.status, value.orderNumber)]));
  let activeOrderId = [...built.keys()][0];

  const tx = {
    $queryRaw: async () => [
      { id: "inv-1", productId: "product-1", status: "PACKED", owned: true },
      { id: "inv-2", productId: "product-2", status: "PACKED", owned: true }
    ],
    order: {
      findUnique: async () => built.get(activeOrderId)!.order,
      update: async ({ data }: { data: Record<string, unknown> }) => { orderWrites.push(data); return built.get(activeOrderId)!.order; }
    },
    orderItem: {
      findMany: async ({ where }: { where: { orderId?: unknown } }) =>
        typeof where.orderId === "string" ? [{ productId: "product-1" }, { productId: "product-2" }] : [],
      findFirst: async () => null
    },
    payment: { findMany: async () => [{ amountKsh: 500 }] },
    inventoryItem: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { inventoryWrites.push(data); return { count: 2 }; }
    },
    fulfillmentItem: {
      update: async ({ data }: { data: Record<string, unknown> }) => { itemWrites.push(data); return data; },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { itemWrites.push(data); return { count: 0 }; }
    },
    orderFulfillment: {
      findUnique: async () => built.get(activeOrderId)!.row,
      update: async ({ data }: { data: Record<string, unknown> }) => { fulfillmentWrites.push(data); return built.get(activeOrderId)!.row; }
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } },
    notification: { create: async ({ data }: { data: Record<string, unknown> }) => { notifications.push(data); return data; } },
    fulfillmentEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data; },
      upsert: async ({ create }: { create: Record<string, unknown> }) => { events.push(create); return create; }
    }
  };

  const originalTransaction = prisma.$transaction;
  prisma.$transaction = (async (callback: (value: unknown) => unknown) => callback(tx)) as typeof prisma.$transaction;
  t.after(() => { prisma.$transaction = originalTransaction; });

  const access = {
    session: async () => session,
    requirePermission: async (_id: string | undefined, permission: string) => {
      if (!session.adminUser || !session.permissions.includes(permission)) {
        const { ForbiddenException } = await import("@nestjs/common");
        throw new ForbiddenException("This admin account does not have permission for this operation.");
      }
      return session;
    },
    hasPermission: async (_id: string | undefined, permission: string) => session.permissions.includes(permission)
  } as unknown as OperationsAccessService;

  const service = new OperationsFulfillmentService(access, {} as ProductImageStorageService);
  const internals = service as unknown as {
    requireOrderWithTask: (orderId: string) => Promise<unknown>;
    requireEmployee: (employeeId?: string) => Promise<unknown>;
    orderDetail: (orderId: string) => Promise<unknown>;
    assertOrderInStoreScope: (orderId: string) => Promise<void>;
  };
  internals.requireOrderWithTask = async (orderId: string) => {
    const entry = built.get(orderId);
    if (!entry) throw new Error("Order was not found.");
    activeOrderId = orderId;
    return entry.order;
  };
  internals.requireEmployee = async (employeeId?: string) => {
    const employee = employeeId ? EMPLOYEES[employeeId] : undefined;
    if (!employee) {
      const { BadRequestException } = await import("@nestjs/common");
      throw new BadRequestException("Employee is required.");
    }
    return employee;
  };
  internals.orderDetail = async (orderId: string) => ({ id: orderId });
  internals.assertOrderInStoreScope = async () => undefined;

  return { service, events, audits, notifications, fulfillmentWrites, orderWrites, inventoryWrites, itemWrites, built };
}

// ---------------------------------------------------------------- 改派拣货员 ---

test("a supervisor moves an order being picked to another picker and the scans stay", async (t) => {
  const h = fixture(t);
  await h.service.reassignPicker("order", { adminUserId: "admin-supervisor", employeeId: "emp-faith", reason: "textdabao 已离职" });

  assert.deepEqual(h.fulfillmentWrites, [{ assignedPickerEmployeeId: "emp-faith" }], "only the picker changes");
  assert.equal(h.itemWrites.length, 0, "verified scans are not reset");
  const event = h.events.find((row) => row.action === "REASSIGN_PICKER");
  assert.ok(event, "the reassignment is on the timeline");
  assert.equal(event.relatedEmployeeId, "emp-faith");
  assert.equal(event.oldStatus, "PICKING");
  assert.equal(event.newStatus, "PICKING", "the order stays where it is");
  assert.equal(event.idempotencyKey, null, "every reassignment is its own event");
  assert.match(String(event.note), /textdabao → Faith2026/);
  assert.match(String(event.note), /textdabao 已离职/);
  assert.match(String(event.note), /1\/2/, "the note says how many scans were kept");
  const audit = h.audits.find((row) => row.action === "REASSIGN_PICKER");
  assert.deepEqual((audit?.beforeJson as Record<string, unknown>).employeeId, "emp-textdabao");
  assert.deepEqual((audit?.afterJson as Record<string, unknown>).employeeId, "emp-faith");
});

test("after the reassignment the new picker may scan and the old one may not", async (t) => {
  const h = fixture(t);
  await h.service.reassignPicker("order", { adminUserId: "admin-supervisor", employeeId: "emp-faith", reason: "离职交接" });
  // The scan compares the task's picker with the scanning employee; the write
  // above is what that comparison reads next time.
  const { canWorkWarehouseTask } = await import("./operations-fulfillment-state");
  const assigned = h.fulfillmentWrites[0].assignedPickerEmployeeId as string;
  assert.equal(canWorkWarehouseTask({ assignedEmployeeId: assigned, actorEmployeeId: "emp-faith", supervisor: false, unassignedIsOpen: true }).allowed, true);
  assert.equal(canWorkWarehouseTask({ assignedEmployeeId: assigned, actorEmployeeId: "emp-textdabao", supervisor: false, unassignedIsOpen: true }).allowed, false);
});

test("someone without orders.assign-picker cannot reassign", async (t) => {
  const h = fixture(t, { session: STORE_STAFF });
  await assert.rejects(
    h.service.reassignPicker("order", { adminUserId: "admin-store", employeeId: "emp-faith", reason: "想接手" }),
    /does not have permission/
  );
  assert.equal(h.fulfillmentWrites.length, 0);
  assert.equal(h.events.length, 0);
});

test("a reassignment without a reason is refused", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    h.service.reassignPicker("order", { adminUserId: "admin-supervisor", employeeId: "emp-faith", reason: "  " }),
    /Say why/
  );
  await assert.rejects(
    h.service.reassignPicker("order", { adminUserId: "admin-supervisor", employeeId: "emp-faith" }),
    /Say why/
  );
  assert.equal(h.fulfillmentWrites.length, 0);
});

test("an order past picking cannot change picker", async (t) => {
  const h = fixture(t, { status: "PACKED" });
  await assert.rejects(
    h.service.reassignPicker("order", { adminUserId: "admin-supervisor", employeeId: "emp-faith", reason: "离职交接" }),
    /being picked/
  );
});

test("plain assign-picker no longer takes a started task away without a reason", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    h.service.assignPicker("order", { adminUserId: "admin-supervisor", employeeId: "emp-faith" }),
    /reassign-picker/
  );
});

test("a parcel whose packing already started can be moved to another packer", async (t) => {
  const h = fixture(t, { status: "READY_TO_PACK", packer: "emp-textdabao", packingStartedAt: new Date("2026-10-12T08:00:00Z") });
  await h.service.reassignPacker("order", { adminUserId: "admin-supervisor", employeeId: "emp-faith", reason: "离职交接" });
  assert.deepEqual(h.fulfillmentWrites, [{ assignedPackerEmployeeId: "emp-faith", packingStartedByEmployeeId: "emp-faith" }]);
  const event = h.events.find((row) => row.action === "REASSIGN_PACKER");
  assert.ok(event);
  assert.match(String(event.note), /textdabao → Faith2026/);
});

// ------------------------------------------------------------- 批量改派 ---

test("a batch moves picking orders as picker and packing orders as packer, and names failures", async (t) => {
  const h = fixture(t, {
    packer: "emp-textdabao",
    orders: {
      a: { status: "PICKING", orderNumber: "DL-A" },
      b: { status: "READY_TO_PACK", orderNumber: "DL-B" },
      c: { status: "COMPLETED", orderNumber: "DL-C" }
    }
  });
  const result = await h.service.reassignBatch({
    adminUserId: "admin-supervisor",
    orderIds: ["a", "b", "c", "a"],
    employeeId: "emp-faith",
    reason: "textdabao 测试账号停用"
  });
  assert.equal(result.total, 3, "a repeated id is counted once");
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results.map((row) => [row.orderNumber, row.ok, row.role ?? null]), [
    ["DL-A", true, "picker"],
    ["DL-B", true, "packer"],
    ["DL-C", false, null]
  ]);
  assert.match(String(result.results[2].error), /being picked/);
  assert.deepEqual(h.events.map((row) => row.action), ["REASSIGN_PICKER", "REASSIGN_PACKER"]);
});

test("a batch needs a reason, a person and at least one order before it touches anything", async (t) => {
  const h = fixture(t);
  await assert.rejects(h.service.reassignBatch({ adminUserId: "admin-supervisor", orderIds: ["order"], employeeId: "emp-faith" }), /Say why/);
  await assert.rejects(h.service.reassignBatch({ adminUserId: "admin-supervisor", orderIds: [], employeeId: "emp-faith", reason: "离职" }), /at least one/);
  await assert.rejects(h.service.reassignBatch({ adminUserId: "admin-supervisor", orderIds: ["order"], reason: "离职" }), /Employee is required/);
  assert.equal(h.fulfillmentWrites.length, 0);
});

test("store staff cannot run a batch reassignment", async (t) => {
  const h = fixture(t, { session: STORE_STAFF });
  await assert.rejects(
    h.service.reassignBatch({ adminUserId: "admin-store", orderIds: ["order"], employeeId: "emp-faith", reason: "离职" }),
    /does not have permission/
  );
});

// ------------------------------------------------------------- 无码补登 ---

const NOTE = "顾客当面付款，我亲手交给了她";

test("only the codeless flag opens a code-less completion, and only from the listed statuses", () => {
  for (const status of CODELESS_COMPLETION_STATUSES) {
    assert.equal(canTransitionFulfillment({ from: status, to: "COMPLETED", fulfillmentMethod: "PICKUP" } as never), false, `${status} still needs a code`);
    assert.equal(canTransitionFulfillment({ from: status, to: "COMPLETED", fulfillmentMethod: "PICKUP", codelessBySuperAdmin: true } as never), true, `${status} opens`);
  }
  for (const status of ["PAID", "PICKING", "READY_TO_PACK", "DELIVERY_FAILED", "RETURNING_TO_NODE", "EXCEPTION"]) {
    assert.equal(canTransitionFulfillment({ from: status, to: "COMPLETED", fulfillmentMethod: "PICKUP", codelessBySuperAdmin: true } as never), false, `${status} stays closed`);
  }
});

for (const status of CODELESS_COMPLETION_STATUSES) {
  test(`a super admin completes a ${status} order without a code`, async (t) => {
    const method = ["READY_FOR_DISPATCH", "OUT_FOR_DELIVERY"].includes(status) ? "KIKUYU_LOCAL_DELIVERY" : "PICKUP";
    const h = fixture(t, { session: SUPER_ADMIN, status, method });
    await h.service.completeWithoutCode("order", { adminUserId: "admin-super", reasonCode: "OFFLINE_HANDOVER_NO_CODE", note: NOTE });

    assert.deepEqual(h.orderWrites, [{ status: "COMPLETED" }], "the order is completed");
    assert.deepEqual(h.inventoryWrites, [{ status: "DELIVERED" }], "the garments are delivered, as with a code");
    const write = h.fulfillmentWrites.at(-1)!;
    assert.equal(write.status, "COMPLETED");
    assert.ok(write.completedAt instanceof Date, "completedAt is set, so commission can follow");
    assert.equal(write.customerCodeVerifiedAt, undefined, "no code was verified and none is claimed");
    assert.equal(write.currentHolderType, "CUSTOMER");
    const event = h.events.find((row) => row.action === CODELESS_COMPLETION_ACTION);
    assert.ok(event, "the timeline shows 无码补登");
    assert.equal(event.oldStatus, status);
    assert.equal(event.newStatus, "COMPLETED");
    assert.equal(event.actorAdminUserId, "admin-super");
    assert.match(String(event.note), /无码补登 · 已线下交付，顾客无码 · 顾客当面付款/);
    const audit = h.audits.find((row) => row.action === CODELESS_COMPLETION_ACTION);
    assert.equal((audit?.afterJson as Record<string, unknown>).reasonCode, "OFFLINE_HANDOVER_NO_CODE");
    assert.equal(h.notifications.length, 1, "the customer is told the order is complete, as usual");
  });
}

test("store staff and supervisors cannot complete without a code", async (t) => {
  for (const session of [STORE_STAFF, SUPERVISOR]) {
    const h = fixture(t, { session, status: "READY_FOR_PICKUP" });
    await assert.rejects(
      h.service.completeWithoutCode("order", { adminUserId: session.adminUser!.id, reasonCode: "OFFLINE_HANDOVER_NO_CODE", note: NOTE }),
      /Only a super admin/
    );
    assert.equal(h.orderWrites.length, 0);
    assert.equal(h.events.length, 0);
  }
  // Every permission in the world does not make a session a super admin; the role does.
  assert.equal(isSuperAdminSession({ roles: [{ code: "PROJECT_MANAGER" }] }), false);
  assert.equal(isSuperAdminSession({ roles: [{ code: "SUPER_ADMIN" }] }), true);
});

test("a code-less completion needs a reason from the list and a real note", async (t) => {
  const h = fixture(t, { session: SUPER_ADMIN, status: "READY_FOR_PICKUP" });
  await assert.rejects(h.service.completeWithoutCode("order", { adminUserId: "admin-super", note: NOTE }), /Choose why/);
  await assert.rejects(h.service.completeWithoutCode("order", { adminUserId: "admin-super", reasonCode: "BECAUSE", note: NOTE }), /Choose why/);
  await assert.rejects(h.service.completeWithoutCode("order", { adminUserId: "admin-super", reasonCode: "OTHER", note: "ok" }), /at least 10/);
  assert.equal(h.orderWrites.length, 0);
});

test("a code-less completion is refused before packing and after a failed delivery", async (t) => {
  for (const status of ["PICKING", "DELIVERY_FAILED"]) {
    const h = fixture(t, { session: SUPER_ADMIN, status });
    await assert.rejects(
      h.service.completeWithoutCode("order", { adminUserId: "admin-super", reasonCode: "PICKED_UP_CODE_LOST", note: NOTE }),
      /cannot be completed without a code/
    );
  }
});

test("commission is eligible after a code-less completion exactly as after a coded one", async (t) => {
  const h = fixture(t, { session: SUPER_ADMIN, status: "READY_FOR_PICKUP" });
  await h.service.completeWithoutCode("order", { adminUserId: "admin-super", reasonCode: "PICKED_UP_CODE_LOST", note: NOTE });
  const write = h.fulfillmentWrites.at(-1)!;
  const completedAt = write.completedAt as Date;
  const commission = {
    holdReason: null,
    rateBps: 1000,
    orderSubtotalKsh: 500,
    commissionAmountKsh: 50,
    order: {
      status: String(h.orderWrites[0].status),
      totalKsh: 500,
      payments: [{ status: "SUCCESS", amountKsh: 500 }],
      fulfillment: { status: String(write.status), completedAt },
      customerServiceCases: [],
      afterSaleReturns: []
    }
  };
  const tooEarly = commissionEligibility(commission, new Date(completedAt.getTime() + 60_000));
  assert.match(String(tooEarly.blockingReason), /72 hours/, "the usual waiting period applies");
  const later = commissionEligibility(commission, new Date(completedAt.getTime() + 73 * 60 * 60 * 1000));
  assert.equal(later.blockingReason, null, "and then it can be confirmed as usual");
});

test("the coded completion is unchanged: no code, no completion", () => {
  assert.equal(canTransitionFulfillment({ from: "READY_FOR_PICKUP", to: "COMPLETED", fulfillmentMethod: "PICKUP" } as never), false);
  assert.equal(canTransitionFulfillment({ from: "READY_FOR_PICKUP", to: "COMPLETED", fulfillmentMethod: "PICKUP", customerCodeVerified: true } as never), true);
  assert.equal(canTransitionFulfillment({ from: "PACKED", to: "COMPLETED", fulfillmentMethod: "PICKUP", customerCodeVerified: true } as never), false, "a code alone does not skip steps");
});
