import { useEffect, useRef, type ReactNode } from 'react';

/** A modal dialog: focus is trapped, Escape closes it, and the page behind is dimmed. */
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
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
