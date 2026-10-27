/**
 * Run-through ("过款") videos: which pieces a video shows, and the caption that
 * goes with it.
 *
 * Eight pieces at 1.2 s each make a video of about 12 s: short enough that
 * most viewers watch to the end, long enough to show a real choice.
 *
 * A video is one category, so its cover can say what the pieces are, and
 * the pieces run from the smallest size to the largest.
 *
 * Every affiliate draws from the same stock, so pieces are picked by how
 * rarely they have been shown: across all affiliates first, then by this
 * affiliate, then newest first. Ties are broken at random, which also means
 * two affiliates generating on the same day get different pieces in a
 * different order, so TikTok does not see the same video posted twice.
 */

export const RUN_THROUGH_ITEM_COUNT = 8;
export const RUN_THROUGH_MIN_ITEMS = 4;

export type RunThroughCandidate = {
  id: string;
  publishedAt: Date | null;
  timesShown: number;
  timesShownByAffiliate: number;
};

export function selectRunThroughProducts<T extends RunThroughCandidate>(
  candidates: T[],
  count: number = RUN_THROUGH_ITEM_COUNT,
  random: () => number = Math.random,
): T[] {
  const shuffled = [...candidates];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  // Array.prototype.sort is stable, so the shuffle decides every tie.
  return shuffled
    .sort((a, b) =>
      a.timesShown - b.timesShown
      || a.timesShownByAffiliate - b.timesShownByAffiliate
      || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, count);
}

const CATEGORY_LABELS: Record<string, string> = {
  TSHIRTS: "T-Shirts",
  SHIRTS: "Shirts",
  LADY_TOPS: "Tops",
  DRESSES: "Dresses",
  JACKETS: "Jackets",
  PANTS: "Trousers",
  SHORT: "Shorts",
  TWO_PIECE: "Two-piece sets",
  SHOES: "Shoes",
  BAG: "Bags",
  KIDS: "Kids",
};

export function runThroughCategoryLabel(category: string | null | undefined): string {
  if (!category) return "Pieces";
  return CATEGORY_LABELS[category]
    ?? category.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function runThroughCaption(categoryLabel: string, prices: number[], sizes: string[] = []): string {
  const lowest = Math.min(...prices.filter((price) => price > 0));
  const from = Number.isFinite(lowest) ? ` from KSh ${lowest.toLocaleString("en-KE")}` : "";
  return [
    `Hi! I found ${prices.length} ${categoryLabel.toLowerCase()}${from} 🔥`,
    ...(sizes.length ? [`Sizes: ${runThroughSizes(sizes).join(" · ")}`] : []),
    "Only one of each, so if you like one, grab it before it is gone.",
  ].join("\n");
}

/**
 * The caption with the promoter's own tracked link at the end. Orders are only
 * credited when people come through that link, so the caption sends them to it
 * instead of asking them to comment.
 */
export function captionWithLink(caption: string, link: string): string {
  return `${caption}\nSee them here: ${link}`;
}

const LETTER_SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];

/** Where a size label sorts: letter sizes in order, then numbers, then the rest. */
function sizeRank(size: string): [number, number, string] {
  const label = size.trim().toUpperCase().replace(/^([2-4])XL$/, (_, n: string) => "X".repeat(Number(n)) + "L");
  const letter = LETTER_SIZES.indexOf(label);
  if (letter >= 0) return [0, letter, label];
  const number = /\d+(\.\d+)?/.exec(label);
  if (number) return [1, Number(number[0]), label];
  return [2, 0, label];
}

export function compareSizes(a: string, b: string): number {
  const [groupA, valueA, labelA] = sizeRank(a);
  const [groupB, valueB, labelB] = sizeRank(b);
  return groupA - groupB || valueA - valueB || labelA.localeCompare(labelB);
}

/** The distinct sizes in a video, smallest first, for its cover. */
export function runThroughSizes(sizes: string[]): string[] {
  return [...new Set(sizes.map((size) => size.trim().toUpperCase()).filter(Boolean))].sort(compareSizes);
}

// ---------------------------------------------------------------------------
// Daily videos. Every affiliate gets RUN_THROUGH_DAILY_VIDEOS each Nairobi day,
// each a different category, rendered ahead of time. Beyond the pieces, every
// video's look comes from its seed, so no two videos share a cover, pace,
// length and transition, and TikTok does not match them as duplicates.

export const RUN_THROUGH_DAILY_VIDEOS = 3;

export type RunThroughVariant = {
  cover: "grid" | "hero" | "strip";
  tone: string;
  transition: "slide" | "fade" | "zoom" | "cut";
  itemFrames: number;
  itemCount: number;
  largestFirst: boolean;
};

const TONES = ["#ffffff", "#f7f4ef", "#f3f3f1", "#f4f1f6"];
const COVERS: RunThroughVariant["cover"][] = ["grid", "hero", "strip"];
const TRANSITIONS: RunThroughVariant["transition"][] = ["slide", "fade", "zoom", "cut"];

/** A small deterministic generator (mulberry32), so a video renders the same every time. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function runThroughVariant(seed: number): RunThroughVariant {
  const random = seededRandom(seed);
  const pick = <T,>(values: T[]) => values[Math.floor(random() * values.length)];
  return {
    cover: pick(COVERS),
    tone: pick(TONES),
    transition: pick(TRANSITIONS),
    // 1.0–1.4 s a piece and 6–9 pieces: every video lands between 8 and 15 s.
    itemFrames: pick([30, 33, 36, 39, 42]),
    itemCount: 6 + Math.floor(random() * 4),
    largestFirst: random() < 0.3,
  };
}

/** Today's date in Nairobi as YYYY-MM-DD; daily videos belong to it. */
export function nairobiDay(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The categories an affiliate's daily videos cover. Affiliates start at
 * different points of the list and move one step each day, so across the team
 * every category is posted every day and each affiliate's feed keeps changing.
 */
export function dailyCategories(categories: string[], affiliateIndex: number, day: string, count = RUN_THROUGH_DAILY_VIDEOS): string[] {
  if (!categories.length) return [];
  const dayNumber = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const start = (affiliateIndex * count + dayNumber) % categories.length;
  return Array.from({ length: count }, (_, slot) => categories[(start + slot) % categories.length]);
}
