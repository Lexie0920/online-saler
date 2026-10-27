import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSizes,
  dailyCategories,
  nairobiDay,
  captionWithLink,
  runThroughCaption,
  runThroughCategoryLabel,
  runThroughSizes,
  runThroughVariant,
  selectRunThroughProducts,
  type RunThroughCandidate,
} from "./run-through";

function candidate(id: string, timesShown: number, timesShownByAffiliate = 0, published = "2026-09-01"): RunThroughCandidate {
  return { id, timesShown, timesShownByAffiliate, publishedAt: new Date(published) };
}

test("pieces shown least across all affiliates come first", () => {
  const picked = selectRunThroughProducts([candidate("a", 3), candidate("b", 0), candidate("c", 1), candidate("d", 5)], 2, () => 0);
  assert.deepEqual(picked.map((item) => item.id), ["b", "c"]);
});

test("among equally shown pieces, ones this affiliate has not shown come first", () => {
  const picked = selectRunThroughProducts([candidate("a", 2, 2), candidate("b", 2, 0), candidate("c", 2, 1)], 2, () => 0);
  assert.deepEqual(picked.map((item) => item.id), ["b", "c"]);
});

test("then the newest pieces come first", () => {
  const picked = selectRunThroughProducts([candidate("old", 0, 0, "2026-08-01"), candidate("new", 0, 0, "2026-09-20")], 1, () => 0);
  assert.deepEqual(picked.map((item) => item.id), ["new"]);
});

test("full ties are settled at random, so two affiliates get different videos", () => {
  const pool = Array.from({ length: 20 }, (_, index) => candidate(`p${index}`, 0));
  const first = selectRunThroughProducts(pool, 8, sequence(0.1, 0.7, 0.3, 0.9, 0.5));
  const second = selectRunThroughProducts(pool, 8, sequence(0.8, 0.2, 0.6, 0.4, 0.05));
  assert.equal(first.length, 8);
  assert.notDeepEqual(first.map((item) => item.id), second.map((item) => item.id));
});

test("never returns more pieces than exist", () => {
  assert.equal(selectRunThroughProducts([candidate("a", 0)], 8).length, 1);
});

test("categories read as plain words", () => {
  assert.equal(runThroughCategoryLabel("TSHIRTS"), "T-Shirts");
  assert.equal(runThroughCategoryLabel("WINTER_COATS"), "Winter Coats");
});

test("the caption names the count and the lowest price", () => {
  const caption = runThroughCaption("T-Shirts", [350, 250, 0], ["XL", "M", "XL"]);
  assert.match(caption, /^Hi! I found 3 t-shirts from KSh 250/);
  assert.match(caption, /Sizes: M · XL/);
  assert.doesNotMatch(caption, /Comment the number/);
  assert.equal(captionWithLink("Hi!", "https://x.test/?ref=A"), "Hi!\nSee them here: https://x.test/?ref=A");
});

test("pieces run from the smallest size to the largest", () => {
  assert.deepEqual(["XXXL", "M", "2XL", "S", "L", "XL"].sort(compareSizes), ["S", "M", "L", "XL", "2XL", "XXXL"]);
  assert.deepEqual(["EU 42", "L", "EU 40", "W30"].sort(compareSizes), ["L", "W30", "EU 40", "EU 42"]);
});

test("the cover lists each size once, smallest first", () => {
  assert.deepEqual(runThroughSizes(["xl", "L", "XL", "", "m"]), ["M", "L", "XL"]);
});

function sequence(...values: number[]) {
  let index = 0;
  return () => values[index++ % values.length];
}

test("a video's look is fixed by its seed and varies between seeds", () => {
  assert.deepEqual(runThroughVariant(42), runThroughVariant(42));
  const looks = new Set(Array.from({ length: 40 }, (_, seed) => JSON.stringify(runThroughVariant(seed))));
  assert.ok(looks.size >= 35, `only ${looks.size} distinct looks from 40 seeds`);
  for (let seed = 0; seed < 200; seed += 1) {
    const variant = runThroughVariant(seed);
    const seconds = (variant.itemCount * variant.itemFrames) / 30;
    assert.ok(variant.itemCount >= 6 && variant.itemCount <= 9);
    assert.ok(seconds >= 6 && seconds <= 12.6);
  }
});

test("the Nairobi day turns over at 21:00 UTC", () => {
  assert.equal(nairobiDay(new Date("2026-09-22T20:59:00Z")), "2026-09-22");
  assert.equal(nairobiDay(new Date("2026-09-22T21:00:00Z")), "2026-09-23");
});

test("each affiliate gets different categories, and they move on the next day", () => {
  const categories = ["TSHIRTS", "DRESSES", "JACKETS", "PANTS", "SHIRTS"];
  const first = dailyCategories(categories, 0, "2026-09-22");
  const second = dailyCategories(categories, 1, "2026-09-22");
  assert.equal(new Set(first).size, 3);
  assert.notDeepEqual(first, second);
  assert.notDeepEqual(first, dailyCategories(categories, 0, "2026-09-23"));
  assert.deepEqual(dailyCategories(["TSHIRTS"], 0, "2026-09-22"), ["TSHIRTS", "TSHIRTS", "TSHIRTS"]);
  assert.deepEqual(dailyCategories([], 0, "2026-09-22"), []);
});
