import { readRange, sourceSize, type SourceData } from '@pagewright/core';

const CHUNK = 8 * 1024 * 1024;
const NEEDLE = new TextEncoder().encode('/ByteRange');
/** A signature's /Contents hex string (often 8 to 32 KB) sits between /Type /Sig and /ByteRange. */
const LOOK_BEHIND = 48 * 1024;
const LOOK_AHEAD = 2 * 1024;

const BYTE_RANGE_ARRAY = /\/ByteRange\s*\[/;
const SIGNATURE = /\/Type\s*\/Sig\b|\/SubFilter\s*\/(adbe|ETSI)/;

/**
 * Cheap check for an embedded digital signature: a `/ByteRange [` entry in a dictionary that is typed as a
 * signature. Reads the source in chunks and searches the raw bytes (no text decoding of the whole file),
 * so a 300 MB scan costs well under a second and never holds more than one chunk.
 *
 * Only the neighbourhood of each `/ByteRange` is decoded and tested, which is also more accurate than
 * testing the whole file: unrelated `/Sig` text elsewhere cannot flag an unsigned document.
 */
export async function detectSignature(data: SourceData, chunk = CHUNK): Promise<boolean> {
  const size = sourceSize(data);
  for (let pos = 0; pos < size; pos += chunk) {
    // Overlap by one needle so a marker split across two chunks is still seen exactly once... or twice.
    const bytes = await readRange(data, pos, pos + chunk + NEEDLE.length - 1);
    for (let at = indexOfSeq(bytes, NEEDLE, 0); at >= 0; at = indexOfSeq(bytes, NEEDLE, at + 1)) {
      const hit = pos + at;
      const around = new TextDecoder('latin1').decode(await readRange(data, Math.max(0, hit - LOOK_BEHIND), hit + LOOK_AHEAD));
      if (BYTE_RANGE_ARRAY.test(around) && SIGNATURE.test(around)) return true;
    }
  }
  return false;
}

/** Index of `needle` in `hay` at or after `from`, or -1. Uses the engine's native `indexOf` to skip ahead. */
function indexOfSeq(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]!;
  const last = hay.length - needle.length;
  for (let i = hay.indexOf(first, from); i >= 0 && i <= last; i = hay.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}
