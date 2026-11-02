/** Longest side of a returned-item photo after it is shrunk for upload. */
export const RETURN_PHOTO_MAX_SIDE = 1600;
export const RETURN_PHOTO_MAX_COUNT = 5;

/** Scale a photo down so its longest side fits, never up, keeping the shape. */
export function fitWithin(width: number, height: number, maxSide: number = RETURN_PHOTO_MAX_SIDE): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 1, height: 1 };
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** How many more photos can be added to a return that already has some. */
export function photoSlotsLeft(existing: number, max: number = RETURN_PHOTO_MAX_COUNT): number {
  return Math.max(0, max - Math.max(0, existing));
}

/**
 * A phone photo is often 5-10 MB; the warehouse only needs to see the item.
 * Shrinks it to a JPEG in the browser before it is uploaded.
 */
export async function compressPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare the photo.");
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("This browser cannot prepare the photo.");
    return blob;
  } finally {
    bitmap.close();
  }
}
