import { MAX_IMAGE_ASPECT, MAX_IMAGE_SIDE, sniffImage, type ImageMime } from '@pagewright/core';

/** A picture ready to become an image stamp: PNG or JPEG bytes the PDF writer can embed as they are. */
export interface StampImage {
  mime: ImageMime;
  bytes: Uint8Array;
  /** Pixels. */
  width: number;
  height: number;
}

/** Turns the bytes of a picked file into a stamp image, or rejects with a message for the person. */
export type ImageLoader = (bytes: Uint8Array) => Promise<StampImage>;

const JPEG_QUALITY = 0.9;

/**
 * The browser's image loader. Every picture is decoded and drawn again, which:
 * - turns it the right way up (phone photos are often stored sideways with an orientation tag PDFs ignore);
 * - scales it down to `MAX_IMAGE_SIDE` pixels, so a 50 MB camera file becomes a stamp-sized one;
 * - writes it out in a plain form every PDF viewer reads (no CMYK or progressive JPEGs, no 16-bit or interlaced PNGs).
 * Pictures with transparency stay PNG so the page shows through; the rest become JPEG, which is far smaller for photos.
 */
export const browserImageLoader: ImageLoader = async (bytes) => {
  const mime = sniffImage(bytes);
  if (!mime) throw new Error('Only PNG and JPEG pictures can be used as stamps.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This picture could not be read. It may be damaged.');
  }
  try {
    const { width: w0, height: h0 } = bitmap;
    if (w0 === 0 || h0 === 0) throw new Error('This picture is empty.');
    if (Math.max(w0 / h0, h0 / w0) > MAX_IMAGE_ASPECT) throw new Error('This picture is too long and thin to use as a stamp.');
    const s = Math.min(1, MAX_IMAGE_SIDE / Math.max(w0, h0));
    const width = Math.max(1, Math.round(w0 * s));
    const height = Math.max(1, Math.round(h0 * s));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This device could not prepare the picture.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const transparent = mime === 'image/png' && hasTransparency(ctx.getImageData(0, 0, width, height).data);
    const outMime: ImageMime = transparent ? 'image/png' : 'image/jpeg';
    if (!transparent) {
      // JPEG has no transparency: put a white page behind the picture rather than let the browser pick black.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outMime, JPEG_QUALITY));
    if (!blob) throw new Error('This device could not prepare the picture.');
    const out = new Uint8Array(await blob.arrayBuffer());
    canvas.width = canvas.height = 0; // let the browser free the pixels now
    return { mime: outMime, bytes: out, width, height };
  } finally {
    bitmap.close();
  }
};

function hasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 255) return true;
  return false;
}
