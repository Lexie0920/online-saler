import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This bootstrap is exclusively for a new disposable test database. Historical
// 0002 contains a UTF-8 BOM rejected by PostgreSQL; do not rewrite its checksum.
// Instead materialize the released schema, execute the exact new migration, and
// prove that the resulting database matches the proposed Prisma schema.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = "e319fe94febb0479fe143914c0e2b6f6d87b764d";
// Every migration that changes the schema after the baseline must be listed here,
// in order. A data-only migration does not belong: it moves no structure, so the
// diff below stays empty without it. Forgetting a structural one fails CI with
// the missing columns spelled out.
const migrations = [
  "20260906140000_add_manual_after_sales",
  "20260906180000_shoe_intake",
  "20260917120000_guest_phone_checkout",
  "20260922150000_run_through_videos",
  "20260922190000_daily_run_through_videos",
  "20260923115000_business_closure_enum_values",
  "20260923120000_business_closure_p0",
  "20260923140000_delivery_closure_enum_values",
  "20260923141000_delivery_closure_p0",
  "20260923170000_customer_service_mvp",
  "20260923190000_deposit_plan_enum_values",
  "20260923191000_deposit_plan",
  "20260923193000_order_lookup_attempts",
  "20260923200000_delivery_code_customer_copy",
  "20260924100000_assigned_packer",
  "20260925120000_package_label_printed",
  "20260925150000_rider_fee",
  "20260926090000_commission_rate_25",
  "20260926100000_return_reason_not_satisfied",
  "20261014120000_weekly_payouts"
];
const raw = process.env.MVP_INTEGRATION_DATABASE_URL;
if (!raw) throw new Error("MVP_INTEGRATION_DATABASE_URL must name a disposable local test database.");
const url = new URL(raw);
if (!["postgres:", "postgresql:"].includes(url.protocol)
  || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  || !/test/i.test(url.pathname)
  || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "sslmode", "pool_timeout", "connect_timeout"].includes(key))) {
  throw new Error("Refusing database bootstrap: only loopback PostgreSQL test databases are allowed.");
}
process.env.DATABASE_URL = raw;
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
try {
  const rows = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`;
  if (rows.length) throw new Error("Refusing database bootstrap: the target schema is not empty.");
} finally {
  await db.$disconnect();
}
const directory = mkdtempSync(path.join(tmpdir(), "mvp-schema-test-"));
const schemaDirectory = path.join(directory, "prisma");
mkdirSync(schemaDirectory);
const env = { ...process.env, DATABASE_URL: raw, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" };
const cli = path.join(root, "node_modules/prisma/build/index.js");
const runPrisma = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, env, stdio: "inherit" });
try {
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline, "packages/database/prisma"], { cwd: root, encoding: "utf8" })
    .trim().split("\n").filter((file) => file.endsWith(".prisma"));
  if (!paths.length) throw new Error("Released baseline schemas are unavailable; checkout history is required.");
  for (const file of paths) {
    const content = execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root });
    writeFileSync(path.join(schemaDirectory, path.basename(file)), content);
  }
  runPrisma(["db", "push", "--schema", schemaDirectory, "--skip-generate"]);
  for (const migration of migrations) {
    runPrisma(["db", "execute", "--schema", "packages/database/prisma", "--file", `packages/database/prisma/migrations/${migration}/migration.sql`]);
  }
  // --from-schema-datasource reads the connection without echoing it as an argument.
  runPrisma(["migrate", "diff", "--from-schema-datasource", "packages/database/prisma", "--to-schema-datamodel", "packages/database/prisma", "--exit-code"]);
  console.log("Disposable database verified: released schema + unchanged new migration equals proposed schema.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
