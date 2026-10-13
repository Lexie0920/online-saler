import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATIONS_PERMISSIONS,
  OPERATIONS_ROLE_BLUEPRINTS,
  bearerOperationsAccessToken,
  hasOperationsPermission,
  hashPassword,
  issueOperationsAccessToken,
  operationsAccessTokenSubject,
  rolePermissionCodes,
  uniquePermissionCodes,
  verifyOperationsAccessToken,
  verifyPassword
} from "./operations-access-policy";

test("super admin role includes every operations permission", () => {
  const admin = OPERATIONS_ROLE_BLUEPRINTS.find((role) => role.code === "SUPER_ADMIN");
  assert.ok(admin);
  assert.deepEqual(admin.permissions.sort(), OPERATIONS_PERMISSIONS.map((permission) => permission.code).sort());
});

test("product digitization role cannot access system account management", () => {
  const permissions = rolePermissionCodes(["PRODUCT_DIGITIZATION"]);
  assert.equal(hasOperationsPermission(permissions, "page.product.digitalization"), true);
  assert.equal(hasOperationsPermission(permissions, "page.product.warehouse-locations"), true);
  assert.equal(hasOperationsPermission(permissions, "inventory-overview.view"), true);
  assert.equal(hasOperationsPermission(permissions, "warehouse-locations.edit-capacity"), false);
  assert.equal(hasOperationsPermission(permissions, "page.product.details"), false);
  assert.equal(hasOperationsPermission(permissions, "action.system.manage-users"), false);
});

test("warehouse management mutations require explicit supervisor permissions", () => {
  const manager = rolePermissionCodes(["PROJECT_MANAGER"]);
  assert.equal(hasOperationsPermission(manager, "warehouse-locations.manage"), true);
  assert.equal(hasOperationsPermission(manager, "warehouse-locations.edit-capacity"), true);
  assert.equal(hasOperationsPermission(manager, "warehouse-locations.move-product"), true);
  assert.equal(hasOperationsPermission(rolePermissionCodes(["DATA_ANALYST"]), "analytics.warehouse.view"), true);
});

test("product detail generation is limited to project managers and super admins", () => {
  assert.equal(hasOperationsPermission(rolePermissionCodes(["PROJECT_MANAGER"]), "page.product.details"), true);
  assert.equal(hasOperationsPermission(rolePermissionCodes(["SUPER_ADMIN"]), "page.product.details"), true);
});

test("order fulfillment permissions are action-specific", () => {
  const permissions = rolePermissionCodes(["WAREHOUSE_FULFILLMENT"]);
  assert.equal(hasOperationsPermission(permissions, "orders.view"), true);
  assert.equal(hasOperationsPermission(permissions, "orders.pick"), true);
  assert.equal(hasOperationsPermission(permissions, "orders.pack"), true);
  assert.equal(hasOperationsPermission(permissions, "orders.dispatch"), true);
  assert.equal(hasOperationsPermission(permissions, "orders.assign-rider"), false);
  assert.equal(hasOperationsPermission(permissions, "orders.cancel"), false);
  assert.equal(hasOperationsPermission(permissions, "warehouse-locations.manage"), false);
});

test("an employee without an order action permission cannot modify fulfillment state", () => {
  const productPermissions = rolePermissionCodes(["PRODUCT_DIGITIZATION"]);
  assert.equal(hasOperationsPermission(productPermissions, "orders.view"), false);
  assert.equal(hasOperationsPermission(productPermissions, "orders.pick"), false);
  assert.equal(hasOperationsPermission(productPermissions, "orders.pack"), false);
  assert.equal(hasOperationsPermission(productPermissions, "orders.complete"), false);
});

test("permission helper returns sorted unique permission codes", () => {
  assert.deepEqual(uniquePermissionCodes(["b", "a", "b"]), ["a", "b"]);
});

test("password hashing verifies only the original password", () => {
  const hash = hashPassword("ChangeMe43!", "fixedsalt");
  assert.equal(verifyPassword("ChangeMe43!", hash), true);
  assert.equal(verifyPassword("wrong-password", hash), false);
});

test("operations access tokens are signed, expire, and reject tampering", () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const passwordHash = hashPassword("ChangeMe43!", "fixedsalt");
  const issued = issueOperationsAccessToken("admin-123", passwordHash, now);

  assert.equal(operationsAccessTokenSubject(issued.accessToken), "admin-123");
  assert.equal(verifyOperationsAccessToken(issued.accessToken, passwordHash, now)?.sub, "admin-123");
  assert.equal(verifyOperationsAccessToken(`${issued.accessToken}x`, passwordHash, now), null);
  assert.equal(verifyOperationsAccessToken(issued.accessToken, `${passwordHash}changed`, now), null);
  assert.equal(verifyOperationsAccessToken(issued.accessToken, passwordHash, new Date("2026-08-12T22:00:01.000Z")), null);
  assert.equal(bearerOperationsAccessToken(`Bearer ${issued.accessToken}`), issued.accessToken);
  assert.equal(bearerOperationsAccessToken("admin-123"), null);
});

/**
 * The policy in this file decides what an API call is allowed to do. The seed in
 * packages/database decides what the database actually grants. They were two
 * hand-maintained lists, and they drifted: nineteen permission codes and two
 * whole roles -- store manager and delivery rider -- existed only here, so the
 * store hand-off, the rider screen, payment review and the notification outbox
 * shipped to a database that could not reach any of them.
 *
 * Drift is invisible in code review and only shows up as "the button is missing"
 * days later, which is why it is a test rather than a note.
 */
test("the staging seed grants exactly what this policy defines", async () => {
  const seed = await import("../../../../packages/database/prisma/seed-staging-test-employee.mjs") as {
    permissions: Array<{ code: string }>;
    roles: Array<{ code: string; permissions: string[] }>;
  };

  assert.deepEqual(
    uniquePermissionCodes(seed.permissions.map((permission) => permission.code)),
    uniquePermissionCodes(OPERATIONS_PERMISSIONS.map((permission) => permission.code)),
    "every permission code in the policy must also be seeded"
  );

  assert.deepEqual(
    seed.roles.map((role) => role.code).sort(),
    OPERATIONS_ROLE_BLUEPRINTS.map((role) => role.code).sort(),
    "every role in the policy must also be seeded"
  );

  for (const blueprint of OPERATIONS_ROLE_BLUEPRINTS) {
    const seeded = seed.roles.find((role) => role.code === blueprint.code)!;
    assert.deepEqual(
      uniquePermissionCodes(seeded.permissions),
      uniquePermissionCodes(blueprint.permissions),
      `role ${blueprint.code} is seeded with different permissions than the policy grants it`
    );
  }
});

test("finance.payout is held by SUPER_ADMIN and FINANCE only, in the policy, the seed and the role backfill", async () => {
  const seed = await import("../../../../packages/database/prisma/seed-staging-test-employee.mjs");
  const holders = (roles: Array<{ code: string; permissions: string[] }>) =>
    roles.filter((role) => role.permissions.includes("finance.payout")).map((role) => role.code).sort();
  assert.deepEqual(holders(OPERATIONS_ROLE_BLUEPRINTS), ["FINANCE", "SUPER_ADMIN"]);
  assert.deepEqual(holders(seed.roles), ["FINANCE", "SUPER_ADMIN"]);
  // An existing role that already holds something gets its missing defaults on
  // the next deployment: the payout grant must reach exactly these two roles.
  const grantedTo = seed.roles
    .filter((role) => seed.planRoleBackfill(role, { exists: true, held: new Set(["orders.view"]), offered: new Set() }).grant.includes("finance.payout"))
    .map((role) => role.code)
    .sort();
  assert.deepEqual(grantedTo, ["FINANCE", "SUPER_ADMIN"]);
});
