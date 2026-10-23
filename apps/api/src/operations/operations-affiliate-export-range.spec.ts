import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { exportRange } from "./operations-affiliate-export-range";

test("no dates means no limit", () => {
  assert.deepEqual(exportRange(), {});
  assert.deepEqual(exportRange("", " "), {});
});

test("both days are included, counted in Nairobi time", () => {
  const range = exportRange("2026-10-01", "2026-10-07");
  assert.equal(range.gte?.toISOString(), "2026-09-30T21:00:00.000Z");
  assert.equal(range.lt?.toISOString(), "2026-10-07T21:00:00.000Z");
});

test("one day can be exported on its own, and either side can be left open", () => {
  const day = exportRange("2026-10-05", "2026-10-05");
  assert.equal(day.lt!.getTime() - day.gte!.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(exportRange("2026-10-05").lt, undefined);
  assert.equal(exportRange(undefined, "2026-10-05").gte, undefined);
});

test("bad or reversed dates are rejected", () => {
  assert.throws(() => exportRange("10/05/2026"), BadRequestException);
  assert.throws(() => exportRange("2026-02-30"), BadRequestException);
  assert.throws(() => exportRange("2026-10-08", "2026-10-07"), BadRequestException);
});
