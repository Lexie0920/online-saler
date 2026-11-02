import assert from "node:assert/strict";
import { test } from "node:test";

import { fitWithin, photoSlotsLeft } from "./return-photo";

test("a big phone photo is scaled down to the longest side and keeps its shape", () => {
  assert.deepEqual(fitWithin(4000, 3000), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: 1600 });
});

test("a photo that is already small is left alone and never enlarged", () => {
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1600, 1600), { width: 1600, height: 1600 });
});

test("broken sizes do not produce a zero-sized canvas", () => {
  assert.deepEqual(fitWithin(0, 100), { width: 1, height: 1 });
  assert.deepEqual(fitWithin(Number.NaN, 100), { width: 1, height: 1 });
  assert.deepEqual(fitWithin(10000, 1), { width: 1600, height: 1 });
});

test("at most five photos can be added to one return", () => {
  assert.equal(photoSlotsLeft(0), 5);
  assert.equal(photoSlotsLeft(3), 2);
  assert.equal(photoSlotsLeft(5), 0);
  assert.equal(photoSlotsLeft(9), 0);
});
