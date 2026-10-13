import "reflect-metadata";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { hashCustomerCode } from "@online-saler/business-rules";
import { prisma } from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsFulfillmentService } from "./operations-fulfillment.service";
import { ProductImageStorageService } from "../product/product-image-storage.service";
import {
  canTransitionFulfillment,
  holderForStatus,
  requiresCustomerCode
} from "./operations-fulfillment-state";

/**
 * The rule these tests exist for: no code, no completion.
 *
 * A rider who knows the customer, a store that recognises the buyer, a WhatsApp
 * message saying "received" — none of them close an order. Only four digits the
 * customer read out do, and only once.
 */

const CODE = "5832";
const WRONG = "1111";

type Fixture = ReturnType<typeof fixture>;

function fixture(
  t: TestContext,
  overrides: {
    status?: string;
    failedAttempts?: number;
    lockedAt?: Date | null;
    verifiedAt?: Date | null;
    codeHash?: string | null;
    riderId?: string | null;
  } = {}
) {
  const status = overrides.status ?? "OUT_FOR_DELIVERY";
  const riderId = overrides.riderId === undefined ? "rider-1" : overrides.riderId;
  const actor = { actorAdminUserId: "admin", actorEmployeeId: "employee" };
  const attempts: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const fulfillmentWrites: Array<Record<string, unknown>> = [];

  const fulfillmentRow = {
    id: "fulfillment",
    status,
    deliveryCodeHash: overrides.codeHash === undefined ? hashCustomerCode(CODE) : overrides.codeHash,
    customerCodeVerifiedAt: overrides.verifiedAt ?? null,
    customerCodeFailedAttempts: overrides.failedAttempts ?? 0,
    customerCodeLockedAt: overrides.lockedAt ?? null,
    deliveryCodeSentCount: 1,
    deliveryAttemptCount: 1,
    deliveryRiderId: riderId,
    deliveryRiderName: "Peter",
    fulfillmentNodeId: "node-kinoo",
    readyForDispatchAt: new Date("2026-09-23T10:00:00Z"),
    packageCode: "PKG-KINOO-10281"
  };

  const order = {
    id: "order",
    orderNumber: "DL-10281",
    status: "FULFILLING",
    fulfillmentMethod: "KIKUYU_LOCAL_DELIVERY",
    totalKsh: 200,
    pickupCode: null,
    deliveryAddress: "Kinoo, near the stage",
    deliveryNote: null,
    whatsappPhone: null,
    customer: { displayName: "Wanjiku", phone: "0712345678" },
    items: [{ id: "item", productId: "product", snapshot: { title: "Denim jacket", sizeLabel: "M", barcode: "BARCODE" } }],
    fulfillmentNode: { id: "node-kinoo", type: "STORE", name: "Kinoo", phone: null, mapsUrl: null },
    fulfillment: {
      ...fulfillmentRow,
      fulfillmentNode: { id: "node-kinoo", type: "STORE", name: "Kinoo" },
      items: [],
      deliveryAssignments: [],
      deliveryRider: riderId ? { id: riderId, name: "Peter", phone: "0722000111", employeeId: null } : null
    }
  };

  const tx = {
    $queryRaw: async () => [{ id: "order", productId: "product", status: "PACKED", owned: true }],
    order: { findUnique: async () => order, update: async () => order },
    orderItem: {
      // The first shape is "this order's items"; the second is the competing-claim
      // query, which must come back empty for the garment to count as owned.
      findMany: async ({ where }: { where: { orderId?: unknown } }) =>
        typeof where.orderId === "string" ? [{ productId: "product" }] : [],
      findFirst: async () => null
    },
    payment: { findMany: async () => [{ amountKsh: 200 }] },
    inventoryItem: { updateMany: async () => ({ count: 1 }) },
    orderFulfillment: {
      findUnique: async () => fulfillmentRow,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        fulfillmentWrites.push(data);
        return fulfillmentRow;
      }
    },
    customerCodeAttempt: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push(data);
        return data;
      }
    },
    deliveryAssignment: { create: async () => ({ id: "assignment" }) },
    deliveryRider: { findUnique: async () => ({ id: "rider-1", name: "Peter", active: true, fulfillmentNodeId: "node-kinoo" }) },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(data);
        return data;
      }
    },
    fulfillmentEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        events.push(create);
        return create;
      }
    }
  };

  const originalTransaction = prisma.$transaction;
  prisma.$transaction = (async (callback: (value: unknown) => unknown) => callback(tx)) as typeof prisma.$transaction;
  const originalRider = prisma.deliveryRider.findUnique;
  prisma.deliveryRider.findUnique = (async () => ({
    id: "rider-1",
    name: "Peter",
    active: true,
    fulfillmentNodeId: "node-kinoo",
    employeeId: null
  })) as unknown as typeof prisma.deliveryRider.findUnique;
  t.after(() => {
    prisma.$transaction = originalTransaction;
    prisma.deliveryRider.findUnique = originalRider;
  });

  const uploads: Array<{ objectName: string; contentType: string; bytes: number }> = [];
  const photos = {
    upload: async (objectName: string, contentType: string, body: Buffer) => {
      uploads.push({ objectName, contentType, bytes: body.length });
    }
  } as unknown as ProductImageStorageService;

  const service = new OperationsFulfillmentService({} as OperationsAccessService, photos);
  const internals = service as unknown as {
    employeeForPermission: () => Promise<typeof actor>;
    adminForPermission: () => Promise<typeof actor>;
    employeeForAnyPermission: () => Promise<typeof actor>;
    employeeBelongsToNode: () => Promise<void>;
    requireOrderWithTask: () => Promise<typeof order>;
    orderDetail: () => Promise<{ id: string }>;
  };
  internals.employeeForPermission = async () => actor;
  internals.adminForPermission = async () => actor;
  internals.employeeForAnyPermission = async () => actor;
  internals.employeeBelongsToNode = async () => undefined;
  internals.requireOrderWithTask = async () => order;
  internals.orderDetail = async () => ({ id: "order" });

  return { service, attempts, events, notifications, fulfillmentWrites, uploads };
}

const rider = { id: "rider-1", name: "Peter", employeeId: null };

function bodies(h: Fixture): string[] {
  return h.notifications.map((row) => String(row.body ?? ""));
}

// ------------------------------------------------------------ state machine ---

test("a delivery cannot be completed without a verified customer code", () => {
  const base = { from: "OUT_FOR_DELIVERY", to: "COMPLETED", fulfillmentMethod: "KIKUYU_LOCAL_DELIVERY" } as const;
  assert.equal(canTransitionFulfillment({ ...base } as never), false);
  assert.equal(canTransitionFulfillment({ ...base, customerCodeVerified: true } as never), true);
});

test("a pickup cannot be completed without a verified customer code either", () => {
  const base = { from: "READY_FOR_PICKUP", to: "COMPLETED", fulfillmentMethod: "PICKUP" } as const;
  assert.equal(canTransitionFulfillment({ ...base } as never), false);
  assert.equal(canTransitionFulfillment({ ...base, customerCodeVerified: true } as never), true);
  assert.equal(requiresCustomerCode("COMPLETED" as never), true);
  assert.equal(requiresCustomerCode("PACKED" as never), false);
});

test("a failed delivery goes back to its node and can be sent out again", () => {
  const delivery = { fulfillmentMethod: "KIKUYU_LOCAL_DELIVERY", nodeType: "STORE" } as const;
  assert.equal(canTransitionFulfillment({ ...delivery, from: "OUT_FOR_DELIVERY", to: "DELIVERY_FAILED" } as never), true);
  assert.equal(canTransitionFulfillment({ ...delivery, from: "DELIVERY_FAILED", to: "RETURNING_TO_NODE" } as never), true);
  assert.equal(canTransitionFulfillment({ ...delivery, from: "RETURNING_TO_NODE", to: "ARRIVED_AT_NODE" } as never), true);
  assert.equal(
    canTransitionFulfillment({ ...delivery, from: "ARRIVED_AT_NODE", to: "READY_FOR_DISPATCH" } as never),
    true
  );
});

test("a failed delivery cannot skip the return and complete itself", () => {
  const delivery = { fulfillmentMethod: "KIKUYU_LOCAL_DELIVERY", nodeType: "STORE", customerCodeVerified: true } as const;
  assert.equal(canTransitionFulfillment({ ...delivery, from: "DELIVERY_FAILED", to: "COMPLETED" } as never), false);
  assert.equal(canTransitionFulfillment({ ...delivery, from: "DELIVERY_FAILED", to: "OUT_FOR_DELIVERY" } as never), false);
});

test("the holder answers who has the package at every step", () => {
  const at = (status: string) =>
    holderForStatus({ status: status as never, fulfillmentNodeId: "node-1", nodeName: "Kinoo", deliveryRiderId: "rider-1", riderName: "Peter" });

  assert.equal(at("PACKED").currentHolderType, "WAREHOUSE");
  assert.equal(at("IN_TRANSIT_TO_NODE").currentHolderType, "IN_TRANSIT");
  assert.equal(at("RETURNING_TO_NODE").currentHolderType, "IN_TRANSIT");
  assert.equal(at("ARRIVED_AT_NODE").currentHolderType, "NODE");
  assert.equal(at("ARRIVED_AT_NODE").currentHolderId, "node-1");
  assert.equal(at("READY_FOR_PICKUP").currentHolderLabel, "Kinoo");
  assert.equal(at("OUT_FOR_DELIVERY").currentHolderType, "RIDER");
  assert.equal(at("OUT_FOR_DELIVERY").currentHolderId, "rider-1");
  // A rider who failed is still holding it until they hand it back.
  assert.equal(at("DELIVERY_FAILED").currentHolderType, "RIDER");
  assert.equal(at("COMPLETED").currentHolderType, "CUSTOMER");
});

// ------------------------------------------------------------------ redaction ---

test("no order response carries a code or its hash", async (t) => {
  const h = fixture(t);
  const internals = h.service as unknown as {
    attachInventory: (orders: unknown[]) => Promise<Array<Record<string, unknown>>>;
  };
  const order = {
    id: "order",
    orderNumber: "DL-10281",
    pickupCode: "4417",
    customer: { displayName: "Wanjiku", phone: "0712345678" },
    payments: [],
    items: [],
    customerServiceCases: [],
    status: "FULFILLING",
    fulfillment: {
      status: "OUT_FOR_DELIVERY",
      deliveryCode: CODE,
      deliveryCodeHash: hashCustomerCode(CODE),
      pickupVerificationValue: "VERIFIED"
    }
  };
  const originalFindMany = prisma.inventoryItem.findMany;
  prisma.inventoryItem.findMany = (async () => []) as unknown as typeof prisma.inventoryItem.findMany;
  t.after(() => { prisma.inventoryItem.findMany = originalFindMany; });

  const [row] = await internals.attachInventory([order]);
  assert.equal(row.pickupCode, undefined, "the pickup code is not returned");
  const fulfillment = row.fulfillment as Record<string, unknown>;
  assert.equal(fulfillment.deliveryCodeHash, undefined, "the delivery code hash is not returned");
  // The readable copy exists for the customer's order page. An operations
  // response that carried it would hand the store a code it could type into its
  // own verification box, which is the one thing the code exists to prevent.
  assert.equal(fulfillment.deliveryCode, undefined, "the readable delivery code is not returned");
  // Four digits is 10,000 guesses, so a hash in a JSON response is a code.
  assert.ok(!JSON.stringify(row).includes("pbkdf2_sha256"));
  assert.ok(!JSON.stringify(row).includes("4417"));
  assert.ok(!JSON.stringify(row).includes(CODE), "no response carries the delivery code");
});

test("an order response carries the customer's full name, phone and address", async (t) => {
  // The owner removed customer-info masking on 2026-09-24: staff dial these
  // numbers and write them on parcels. Only the codes above stay hidden.
  const h = fixture(t);
  const internals = h.service as unknown as {
    attachInventory: (orders: unknown[]) => Promise<Array<Record<string, unknown>>>;
  };
  const order = {
    id: "order",
    orderNumber: "DL-10281",
    pickupCode: "4417",
    deliveryAddress: "Kikuyu Town, behind the petrol station, house 12",
    customer: { displayName: "Wanjiku Kamau", phone: "+254712345678" },
    payments: [{ id: "pay", phone: "254712345678", status: "SUCCEEDED" }],
    items: [],
    customerServiceCases: [],
    status: "FULFILLING",
    fulfillment: { status: "OUT_FOR_DELIVERY", deliveryCode: CODE, deliveryCodeHash: hashCustomerCode(CODE) }
  };
  const originalFindMany = prisma.inventoryItem.findMany;
  prisma.inventoryItem.findMany = (async () => []) as unknown as typeof prisma.inventoryItem.findMany;
  t.after(() => { prisma.inventoryItem.findMany = originalFindMany; });

  const [row] = await internals.attachInventory([order]);
  const customer = row.customer as Record<string, unknown>;
  assert.equal(customer.displayName, "Wanjiku Kamau");
  assert.equal(customer.phone, "+254712345678", "the customer's phone is returned whole");
  assert.equal((row.payments as Array<Record<string, unknown>>)[0]!.phone, "254712345678", "so is the paying number");
  assert.equal(row.deliveryAddress, "Kikuyu Town, behind the petrol station, house 12");
  assert.ok(!JSON.stringify(row).includes("•"), "no masked digits anywhere");
  // The codes are still redacted.
  assert.equal((row.fulfillment as Record<string, unknown>).deliveryCode, undefined);
  assert.equal(row.pickupCode, undefined);
});

// ------------------------------------------------------------------ dispatch ---

test("dispatching to a rider texts a code that appears nowhere staff can read it", async (t) => {
  const h = fixture(t, { status: "ARRIVED_AT_NODE", codeHash: null });
  await h.service.dispatchToRider("order", { adminUserId: "admin", deliveryRiderId: "rider-1", riderFeeKsh: 50 });

  const sms = bodies(h).find((body) => body.includes("Delivery code"));
  assert.ok(sms, "the customer is texted a delivery code");
  const digits = sms!.match(/Delivery code (\d{4})/)?.[1];
  assert.ok(digits, "the SMS carries four digits");
  assert.match(sms!, /only after you have received your order/);

  // Verification still reads a hash, never the readable copy.
  const write = h.fulfillmentWrites.find((data) => typeof data.deliveryCodeHash === "string");
  assert.ok(write, "a code hash is stored");
  assert.match(String(write!.deliveryCodeHash), /^pbkdf2_sha256\$/);
  // A random hash or a timestamp can contain any four digits by chance, so look
  // for the code as a value or next to the word "code", not as a substring.
  const hash = String(write!.deliveryCodeHash);
  assert.notEqual(hash, digits);
  assert.ok(!hash.split("$").includes(digits!), "the hash does not carry the code as a field");
  const eventText = JSON.stringify(h.events);
  assert.ok(!eventText.includes(`"${digits}"`), "no event stores the code as a value");
  assert.ok(!new RegExp(`code\\D{0,3}${digits}`, "i").test(eventText), "no event records the code");

  // One column holds the readable copy, and it is the one the customer's own
  // order page reads. Anywhere else -- an event, a note, a second column -- it
  // would be visible to the staff who must not have it.
  assert.equal(write!.deliveryCode, digits, "the customer's own copy is stored");
  const columnsWithCode = h.fulfillmentWrites.flatMap((data) =>
    Object.entries(data).filter(([, value]) => value === digits).map(([column]) => column));
  assert.deepEqual(columnsWithCode, ["deliveryCode"], "only deliveryCode carries the plaintext");
});

test("dispatch moves the package to the rider in the same write as the code", async (t) => {
  const h = fixture(t, { status: "ARRIVED_AT_NODE", codeHash: null });
  await h.service.dispatchToRider("order", { adminUserId: "admin", deliveryRiderId: "rider-1", riderFeeKsh: 50 });

  const write = h.fulfillmentWrites.find((data) => data.status === "OUT_FOR_DELIVERY");
  assert.ok(write, "the package goes out for delivery");
  assert.equal(write!.deliveryRiderId, "rider-1");
  assert.equal(write!.currentHolderType, "RIDER");
  assert.ok(write!.deliveryCodeHash, "the code is minted in the same update");
  assert.equal(write!.customerCodeFailedAttempts, 0, "a new attempt starts with a clean budget");
});

test("a second tap on dispatch does not mint a second code or send a second SMS", async (t) => {
  const h = fixture(t, { status: "OUT_FOR_DELIVERY" });
  await h.service.dispatchToRider("order", { adminUserId: "admin", deliveryRiderId: "rider-1", riderFeeKsh: 50 });
  assert.equal(h.notifications.length, 0);
  assert.equal(h.fulfillmentWrites.length, 0);
});

test("a package that has not reached its node cannot be dispatched", async (t) => {
  const h = fixture(t, { status: "PACKED", codeHash: null });
  await assert.rejects(
    () => h.service.dispatchToRider("order", { adminUserId: "admin", deliveryRiderId: "rider-1", riderFeeKsh: 50 }),
    /received at its node/
  );
});

test("dispatch needs a rider to be chosen", async (t) => {
  const h = fixture(t, { status: "ARRIVED_AT_NODE", codeHash: null });
  await assert.rejects(() => h.service.dispatchToRider("order", { adminUserId: "admin" }), /Choose a rider/);
});

test("the older two-step dispatch also texts a code, so no order is left uncompletable", async (t) => {
  const h = fixture(t, { status: "READY_FOR_DISPATCH", codeHash: null });
  await h.service.dispatch("order", { adminUserId: "admin", riderFeeKsh: 50 });

  const sms = bodies(h).find((body) => body.includes("Delivery code"));
  assert.ok(sms, "confirming the handover texts a code");
  const write = h.fulfillmentWrites.find((data) => data.status === "OUT_FOR_DELIVERY");
  assert.ok(write?.deliveryCodeHash, "a code is minted on the older route too");
});

test("the older dispatch refuses to hand over with no rider registered", async (t) => {
  const h = fixture(t, { status: "READY_FOR_DISPATCH", codeHash: null, riderId: null });
  // The state machine catches this first: READY_FOR_DISPATCH only leads to
  // OUT_FOR_DELIVERY when a rider is on the order. The explicit check inside
  // dispatch is the fallback for a rider id whose relation did not load.
  await assert.rejects(
    () => h.service.dispatch("order", { adminUserId: "admin", riderFeeKsh: 50 }),
    /cannot move from READY_FOR_DISPATCH/
  );
  assert.equal(h.notifications.length, 0, "no code is texted for a handover that did not happen");
  assert.equal(h.fulfillmentWrites.length, 0);
});

// -------------------------------------------------------------- verification ---

test("the right code completes the delivery and is recorded as one attempt", async (t) => {
  const h = fixture(t);
  await h.service.completeRiderDelivery("order", { code: CODE }, rider);

  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].succeeded, true);
  assert.equal(h.attempts[0].purpose, "DELIVERY");
  assert.equal(h.attempts[0].deliveryRiderId, "rider-1");
  // The attempt row says who and when, never what was typed.
  assert.ok(!JSON.stringify(h.attempts).includes(CODE));

  const completion = h.fulfillmentWrites.find((data) => data.status === "COMPLETED");
  assert.ok(completion, "the order completes");
  assert.equal(completion!.deliveryCompletionMethod, "HANDED_TO_CUSTOMER");
  assert.ok(completion!.customerCodeVerifiedAt, "the code is stamped as used");
  assert.equal(completion!.currentHolderType, "CUSTOMER");
});

test("a wrong code is refused, burns one attempt, and completes nothing", async (t) => {
  const h = fixture(t);
  await assert.rejects(() => h.service.completeRiderDelivery("order", { code: WRONG }, rider), /4 attempt\(s\) left/);

  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].succeeded, false);
  assert.ok(h.fulfillmentWrites.some((data) => data.customerCodeFailedAttempts), "the counter goes up");
  assert.ok(!h.fulfillmentWrites.some((data) => data.status === "COMPLETED"), "nothing completes");
});

test("the fifth wrong code locks the order and says to ask the store", async (t) => {
  const h = fixture(t, { failedAttempts: 4 });
  await assert.rejects(() => h.service.completeRiderDelivery("order", { code: WRONG }, rider), /now locked/);

  assert.equal(h.attempts[0].lockedOut, true);
  const write = h.fulfillmentWrites.find((data) => data.customerCodeLockedAt);
  assert.ok(write, "the lock is recorded");
});

test("a locked order refuses even the correct code", async (t) => {
  const h = fixture(t, { lockedAt: new Date(), failedAttempts: 5 });
  await assert.rejects(() => h.service.completeRiderDelivery("order", { code: CODE }, rider), /Too many wrong codes/);
  assert.ok(!h.fulfillmentWrites.some((data) => data.status === "COMPLETED"));
});

test("a code is one-time: the same code cannot close the order twice", async (t) => {
  const h = fixture(t, { verifiedAt: new Date("2026-09-23T17:14:00Z") });
  await assert.rejects(() => h.service.completeRiderDelivery("order", { code: CODE }, rider), /already been used/);
});

test("a malformed entry is a typo, not a guess, and does not burn an attempt", async (t) => {
  const h = fixture(t);
  await assert.rejects(() => h.service.completeRiderDelivery("order", { code: "58" }, rider), /Enter the 4 digits/);
  assert.equal(h.attempts.length, 0);
  assert.equal(h.fulfillmentWrites.length, 0);
});

test("no code at all cannot complete a delivery", async (t) => {
  const h = fixture(t);
  await assert.rejects(() => h.service.completeRiderDelivery("order", {}, rider), /Enter the 4 digits/);
  assert.ok(!h.fulfillmentWrites.some((data) => data.status === "COMPLETED"));
});

test("an order with no code issued cannot be completed by guessing one", async (t) => {
  const h = fixture(t, { codeHash: null });
  await assert.rejects(() => h.service.completeRiderDelivery("order", { code: CODE }, rider), /no delivery code has been issued/i);
});

test("a rider cannot touch another rider's delivery", async (t) => {
  const h = fixture(t, { riderId: "rider-2" });
  await assert.rejects(
    () => h.service.completeRiderDelivery("order", { code: CODE }, rider),
    /assigned to another rider/
  );
  assert.equal(h.attempts.length, 0, "a foreign delivery does not even reach the code check");
});

// ------------------------------------------------------------ drop-off proof ---

test("an authorized drop-off needs both the photo and the code", async (t) => {
  const h = fixture(t);
  await h.service.completeAuthorizedDropOff("order", {
    code: CODE,
    photoBase64: `data:image/jpeg;base64,${Buffer.from("a photo of the gate").toString("base64")}`,
    photoContentType: "image/jpeg",
    dropOffNote: "Left with the Block A guard"
  }, rider);

  assert.equal(h.uploads.length, 1);
  assert.match(h.uploads[0].objectName, /^staging\/deliveries\/order\/fulfillment-\d+\.jpg$/);
  const completion = h.fulfillmentWrites.find((data) => data.status === "COMPLETED");
  assert.equal(completion!.deliveryCompletionMethod, "AUTHORIZED_DROP_OFF");
  assert.equal(completion!.dropOffPhotoObject, h.uploads[0].objectName);
  assert.equal(completion!.dropOffNote, "Left with the Block A guard");
});

test("a drop-off with no photo is refused before the code is spent", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    () => h.service.completeAuthorizedDropOff("order", { code: CODE }, rider),
    /photo of where the package was left is required/
  );
  assert.equal(h.attempts.length, 0);
  assert.equal(h.uploads.length, 0);
});

test("a drop-off photo without a valid code completes nothing", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    () => h.service.completeAuthorizedDropOff("order", {
      code: WRONG,
      photoBase64: Buffer.from("a photo").toString("base64")
    }, rider),
    /wrong/
  );
  assert.equal(h.uploads.length, 1, "the proof is kept even though the handover failed");
  assert.ok(!h.fulfillmentWrites.some((data) => data.status === "COMPLETED"));
});

// --------------------------------------------------------- failure and retry ---

test("a failed delivery keeps the order alive, kills the code, and tells the customer", async (t) => {
  const h = fixture(t);
  await h.service.markDeliveryFailed("order", { adminUserId: "admin", reason: "NO_ANSWER", note: "Gate locked" }, rider);

  const write = h.fulfillmentWrites.find((data) => data.status === "DELIVERY_FAILED");
  assert.ok(write, "the package is marked failed");
  assert.equal(write!.deliveryFailureReason, "NO_ANSWER");
  assert.equal(write!.deliveryCodeHash, null, "the old code dies with the attempt");
  assert.equal(write!.deliveryCode, null, "and stops being readable on the customer's order page");
  assert.equal(write!.currentHolderType, "RIDER", "the rider still has the goods");

  const sms = bodies(h).find((body) => body.includes("could not deliver"));
  assert.ok(sms, "the customer is told");
  assert.match(sms!, /Your payment is safe/);
});

test("resending replaces the code rather than revealing the old one", async (t) => {
  const h = fixture(t);
  await h.service.resendDeliveryCode("order", { adminUserId: "admin" });

  const write = h.fulfillmentWrites.find((data) => typeof data.deliveryCodeHash === "string");
  assert.ok(write, "a fresh hash replaces the old one");
  assert.equal(write!.customerCodeLockedAt, null, "resending also unlocks a locked order");
  assert.equal(write!.customerCodeFailedAttempts, 0);

  const sms = bodies(h).find((body) => body.includes("Delivery code"));
  assert.ok(sms, "the new code is texted");
  const digits = sms!.match(/Delivery code (\d{4})/)?.[1];
  // The readable copy is overwritten in the same update, so the order page can
  // never show a code the verification box would now reject.
  assert.equal(write!.deliveryCode, digits, "the customer's order page shows the new code");
});

test("a code can only be resent while the package is actually out for delivery", async (t) => {
  const h = fixture(t, { status: "ARRIVED_AT_NODE" });
  await assert.rejects(() => h.service.resendDeliveryCode("order", { adminUserId: "admin" }), /out for delivery/);
});
