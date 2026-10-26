import type { TypedSignatureResult } from './typed-signature';

/** A font as the signature maker needs it. */
export interface SignatureFontSource {
  id: string;
  label: string;
  /** Loads the font's files, most preferred first (for example Latin, then extended Latin, then Cyrillic). */
  load(): Promise<Uint8Array[]>;
}

/** What the editor asks for when it wants to turn typed text into artwork. */
export interface SignatureMaker {
  fonts: readonly { id: string; label: string }[];
  make(text: string, fontId: string): Promise<TypedSignatureResult>;
}

/**
 * Wraps a set of fonts, loading each only when first used and keeping it for next time. The font engine (fontkit,
 * about a third of the app's code) is loaded the first time a signature is drawn, not when the app starts.
 */
export function createSignatureMaker(sources: readonly SignatureFontSource[]): SignatureMaker {
  const loaded = new Map<string, Promise<Uint8Array[]>>();
  let engine: Promise<typeof import('./typed-signature')> | undefined;
  return {
    fonts: sources.map(({ id, label }) => ({ id, label })),
    async make(text, fontId) {
      const source = sources.find((s) => s.id === fontId);
      if (!source) throw new Error(`Unknown signature style "${fontId}"`);
      let files = loaded.get(fontId);
      if (!files) {
        files = source.load();
        loaded.set(fontId, files);
        files.catch(() => loaded.delete(fontId)); // a failed load is tried again next time
      }
      if (!engine) {
        engine = import('./typed-signature');
        engine.catch(() => (engine = undefined));
      }
      const [{ typedSignatureArt }, fontFiles] = await Promise.all([engine, files]);
      const result = typedSignatureArt(fontFiles, text);
      if (!result) throw new Error('There is nothing to draw: try a name with letters in it.');
      return result;
    },
  };
}
