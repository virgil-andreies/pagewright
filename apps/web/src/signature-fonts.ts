import type { SignatureFontSource } from '@pagewright/engine';

/**
 * The handwriting styles offered for typed signatures. All are open-licence (SIL OFL) fonts from Fontsource. They are
 * only used to draw the outlines of the letters once, when a signature is made: the signature is then stored and saved
 * into PDFs as plain shapes, so these files are not embedded anywhere.
 */
const STYLES = [
  { id: 'great-vibes', label: 'Great Vibes' },
  { id: 'dancing-script', label: 'Dancing Script' },
  { id: 'caveat', label: 'Caveat' },
  { id: 'sacramento', label: 'Sacramento' },
] as const;

/** A font's files are split by character set. Earlier ones are preferred: Latin first, then the rest. */
const CHARACTER_SETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese'];

// URLs of the font files, resolved by the bundler. Nothing is downloaded until a style is first used.
const files = import.meta.glob('/node_modules/@fontsource/*/files/*-400-normal.woff', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the signature font (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export const signatureFonts: SignatureFontSource[] = STYLES.map(({ id, label }) => ({
  id,
  label,
  load: () => {
    const urls = CHARACTER_SETS.map((set) => files[`/node_modules/@fontsource/${id}/files/${id}-${set}-400-normal.woff`]).filter((u): u is string => !!u);
    if (urls.length === 0) throw new Error(`The "${label}" font files are missing.`);
    return Promise.all(urls.map(fetchBytes));
  },
}));
