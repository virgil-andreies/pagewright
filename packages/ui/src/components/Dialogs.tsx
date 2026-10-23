import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { describeError } from '@pagewright/core';
import { useSnapshot, useUi } from '../react';

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) (d.showModal ? d.showModal() : d.setAttribute('open', ''));
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-label={title} onCancel={(e) => (e.preventDefault(), onClose())}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

function PasswordDialog({ fileName, wrong }: { fileName: string; wrong: boolean }) {
  const { store } = useUi();
  const [pw, setPw] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    store.submitPassword(pw);
  };
  return (
    <Modal title="Password required" onClose={() => store.cancelPassword()}>
      <form onSubmit={submit}>
        <p>“{fileName}” is protected.{wrong && <strong className="error-text"> That password was incorrect.</strong>}</p>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password" />
        <div className="actions">
          <button type="button" onClick={() => store.cancelPassword()}>Cancel</button>
          <button type="submit" className="primary">Open</button>
        </div>
      </form>
    </Modal>
  );
}

export function Dialogs() {
  const { store } = useUi();
  const { ui } = useSnapshot();

  return (
    <>
      {ui.passwordPrompt && <PasswordDialog key={ui.passwordPrompt.fileName + ui.passwordPrompt.wrong} {...ui.passwordPrompt} />}
      {ui.saveWarning && (
        <Modal title="Digital signatures will be invalidated" onClose={() => store.cancelSaveWarning()}>
          <p>{describeError(ui.saveWarning).message} Visual signatures added here are not cryptographic signatures.</p>
          <div className="actions">
            <button onClick={() => store.cancelSaveWarning()}>Cancel</button>
            <button className="primary" onClick={() => void store.save(true)}>Save anyway</button>
          </div>
        </Modal>
      )}
      <div className="toasts" role="status">
        {ui.error && (
          <div className="toast error">
            <span>{ui.error.code === 'Message' ? ui.error.message : `${describeError(ui.error).message} ${describeError(ui.error).action}.`}</span>
            <button onClick={() => store.dismissError()} aria-label="Dismiss">×</button>
          </div>
        )}
        {ui.notices.map((n) => (
          <div className="toast" key={n}>
            <span>{n}</span>
            <button onClick={() => store.dismissNotice(n)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </>
  );
}
