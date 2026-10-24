import { useEffect, useState } from 'react';
import { artSvgPath, type RGBA, type SignatureArt } from '@pagewright/core';
import { useSnapshot, useUi } from '../react';
import { SIGNATURE_INKS, type AppStore } from '../store';
import { Modal } from './Modal';

const css = (c: RGBA) => `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)})`;

/** A small picture of a signature's artwork. */
export function SignaturePreview({ art, color, label }: { art: SignatureArt; color: RGBA; label: string }) {
  return (
    <svg className="sig-preview" viewBox={`0 0 ${art.w} ${art.h}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
      <path
        d={artSvgPath(art)}
        fill={art.mode === 'fill' ? css(color) : 'none'}
        stroke={art.mode === 'stroke' ? css(color) : 'none'}
        strokeWidth={art.strokeWidth ?? 1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Preview = { state: 'ready'; art: SignatureArt; missing: string[] } | { state: 'error'; message: string };

/** The typed text drawn in every style, so the person can see them side by side. Waits for a pause in typing. */
function useStylePreviews(store: AppStore, text: string, fontIds: readonly string[]): Record<string, Preview> {
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const key = fontIds.join('|');
  useEffect(() => {
    const clean = text.trim();
    if (!clean) {
      setPreviews({});
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      for (const id of key.split('|').filter(Boolean)) {
        store.previewSignature(clean, id).then(
          (r) => live && setPreviews((p) => ({ ...p, [id]: { state: 'ready', ...r } })),
          (e: unknown) => live && setPreviews((p) => ({ ...p, [id]: { state: 'error', message: e instanceof Error ? e.message : String(e) } })),
        );
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [store, text, key]);
  return previews;
}

/**
 * Where signatures are made and kept. A signature here is a picture of a name in a handwriting style: it shows
 * who "signed" on the page but is not a digital signature, and the dialog says so.
 */
export function SignatureDialog() {
  const { store } = useUi();
  const { ui } = useSnapshot();
  const maker = store.signatureMaker;
  const fonts = maker?.fonts ?? [];
  const author = store.getAuthor();
  const [text, setText] = useState(author === 'You' ? '' : author);
  const [fontId, setFontId] = useState(fonts[0]?.id ?? '');
  const [ink, setInk] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const previews = useStylePreviews(store, text, fonts.map((f) => f.id));
  const chosen = previews[fontId];
  const ready = chosen?.state === 'ready' ? chosen : undefined;
  const color = SIGNATURE_INKS[ink]!.color;

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await store.createSignature(text, fontId, color);
      store.useSignature(saved.id); // ready to place; closes the dialog
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Signatures" onClose={() => store.openSignatures(false)}>
      <p className="sig-note">
        A visual signature shows your name on the page in a handwriting style. It is <strong>not a digital signature</strong> and
        does not prove who signed.
      </p>

      <section aria-label="Saved signatures">
        <h3>Saved on this device</h3>
        {ui.signatures.length === 0 ? (
          <p className="empty-hint">No saved signatures yet.</p>
        ) : (
          <ul className="sig-list">
            {ui.signatures.map((s) => (
              <li key={s.id} className={s.id === ui.activeSignature ? 'active' : ''}>
                <SignaturePreview art={s.art} color={s.color} label={`Signature of ${s.name}`} />
                <span className="sig-name">{s.name}</span>
                <button onClick={() => store.useSignature(s.id)} aria-label={`Use signature ${s.name}`}>Use</button>
                <button onClick={() => void store.deleteSignature(s.id)} aria-label={`Delete signature ${s.name}`}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="New signature">
        <h3>New signature</h3>
        {!maker ? (
          <p className="empty-hint">Typed signatures are not available here.</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (ready && !busy) void create();
            }}
          >
            <label className="sig-field">
              Your name
              <input value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="Type your name" />
            </label>

            <div role="radiogroup" aria-label="Style" className="sig-styles">
              {fonts.map((f) => {
                const p = previews[f.id];
                return (
                  <button
                    type="button"
                    key={f.id}
                    role="radio"
                    aria-checked={f.id === fontId}
                    aria-label={f.label}
                    className={f.id === fontId ? 'active' : ''}
                    onClick={() => setFontId(f.id)}
                  >
                    {p?.state === 'ready' ? <SignaturePreview art={p.art} color={color} label={`${f.label} preview`} /> : <span className="sig-placeholder" />}
                    <span>{f.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="sig-inks" role="radiogroup" aria-label="Ink">
              {SIGNATURE_INKS.map((c, i) => (
                <button
                  type="button"
                  key={c.name}
                  role="radio"
                  aria-checked={i === ink}
                  aria-label={c.name}
                  className="swatch"
                  style={{ background: css(c.color) }}
                  onClick={() => setInk(i)}
                />
              ))}
            </div>

            {ready && ready.missing.length > 0 && (
              <p role="status" className="error-text">
                This style cannot draw: {ready.missing.join(' ')}. {ready.missing.length === 1 ? 'It is' : 'They are'} left out.
              </p>
            )}
            {chosen?.state === 'error' && <p role="alert" className="error-text">{chosen.message}</p>}
            {error && <p role="alert" className="error-text">{error}</p>}

            <div className="actions">
              <button type="button" onClick={() => store.openSignatures(false)}>Close</button>
              <button type="submit" className="primary" disabled={!ready || busy}>Save and use</button>
            </div>
          </form>
        )}
      </section>
      {!maker && (
        <div className="actions">
          <button onClick={() => store.openSignatures(false)}>Close</button>
        </div>
      )}
    </Modal>
  );
}
