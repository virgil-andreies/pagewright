import { useState } from 'react';
import { useBrand } from '../brand';
import { useSnapshot, useUi } from '../react';
import { Modal } from './Modal';

/**
 * What the app is, which version, and what happens to your files and data: in plain words, and accurate (it is
 * checked against what the app stores and sends; it sends nothing).
 */
export function AboutDialog() {
  const { store } = useUi();
  const { doc } = useSnapshot();
  const brand = useBrand();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const remove = async () => {
    setDeleting(true);
    setFailed(false);
    try {
      await store.deleteLocalData(); // restarts the app when done
    } catch {
      setFailed(true);
      setDeleting(false);
    }
  };
  const version = [brand.version, brand.commit].filter(Boolean).join(' · ');
  return (
    <Modal title={`About ${brand.name}`} onClose={() => store.openAbout(false)}>
      <div className="about">
        <p className="about-name">
          <strong>{brand.name}</strong> <span className="beta">Beta</span>
        </p>
        {version && <p className="about-version">Version {version}</p>}

        <h3>Your files stay on your device</h3>
        <p>
          Your PDFs are opened, edited and saved entirely in this browser. They are never uploaded. There are no accounts,
          ads, cookies or tracking.
        </p>
        <p>The website’s host (Cloudflare) sees normal technical data, such as your IP address, when the page loads: never your files.</p>

        <h3>Kept on this device</h3>
        <ul>
          <li>your name, shown on your comments</li>
          <li>the signatures you save</li>
          <li>each tool’s colour and settings</li>
          <li>a private working copy of each PDF you open, so it keeps working after you save over the original</li>
        </ul>
        <p>
          Other websites cannot see any of this. The working copies are deleted the next time you open {brand.name}{store.canDeleteLocalData ? ', or right away with the button below' : ''}.
        </p>
        {store.canDeleteLocalData && (
          <div className="about-delete" role="group" aria-label="Delete stored data">
            {!confirming ? (
              <button onClick={() => setConfirming(true)}>Delete everything stored on this device…</button>
            ) : (
              <div className="about-confirm" role="alert">
                <p>
                  <strong>Delete your name, saved signatures, tool settings and every working copy?</strong> This cannot be undone.
                  {doc.pages.length > 0 && (
                    <>
                      {' '}The document open now will be closed{doc.dirty ? ', and its unsaved changes lost: save it first if you need them' : ''}.
                    </>
                  )}
                </p>
                {failed && <p className="error-text">Something could not be deleted. Please try again.</p>}
                <div className="actions">
                  <button onClick={() => setConfirming(false)} disabled={deleting}>Cancel</button>
                  <button className="danger" onClick={() => void remove()} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete everything'}</button>
                </div>
              </div>
            )}
          </div>
        )}

        <h3>Works best in</h3>
        <p>
          Chrome and Edge, which can save over the original file. Firefox, Safari and phone browsers do everything else, and
          save a copy to your downloads instead.
        </p>

        <h3>Beta</h3>
        <p>
          This is an early version. If something goes wrong, please report it
          {brand.sourceUrl ? (
            <>
              {' '}on <a href={`${brand.sourceUrl}/issues`} target="_blank" rel="noreferrer">GitHub</a>
            </>
          ) : null}
          .
        </p>
        <p className="about-small">
          {brand.sourceUrl && (
            <>
              <a href={brand.sourceUrl} target="_blank" rel="noreferrer">Source code on GitHub</a>
              {' · '}
            </>
          )}
          Built with PDF.js, pdf-lib, fontkit, Lucide icons and the Noto fonts.
        </p>
      </div>
      <div className="actions">
        <button className="primary" autoFocus onClick={() => store.openAbout(false)}>Close</button>
      </div>
    </Modal>
  );
}
