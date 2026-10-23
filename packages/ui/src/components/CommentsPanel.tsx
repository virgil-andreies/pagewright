import { useState, type KeyboardEvent } from 'react';
import { annotationName, listThreads, type Thread } from '../comments';
import { useSnapshot, useUi } from '../react';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A text box with a submit button. Ctrl/Cmd+Enter submits, Escape cancels. */
function Composer({ label, initial = '', submitLabel, onSubmit, onCancel, clearOnSubmit = true, autoFocus = false }: {
  label: string; initial?: string; submitLabel: string; onSubmit: (text: string) => void; onCancel?: () => void;
  clearOnSubmit?: boolean; autoFocus?: boolean;
}) {
  const [text, setText] = useState(initial);
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(text);
    if (clearOnSubmit) setText('');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), submit());
    else if (e.key === 'Escape' && onCancel) (e.stopPropagation(), onCancel());
  };
  return (
    <div className="composer">
      <textarea aria-label={label} value={text} rows={2} autoFocus={autoFocus} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <div className="actions">
        {onCancel && <button onClick={onCancel}>Cancel</button>}
        <button className="primary" onClick={submit} disabled={!text.trim()}>{submitLabel}</button>
      </div>
    </div>
  );
}

function Reply({ thread, reply }: { thread: Thread; reply: { id: string; author: string; createdAt: string; text: string } }) {
  const { store } = useUi();
  const [editing, setEditing] = useState(false);
  const { pageId, annot } = thread;
  return (
    <li className="reply">
      <div className="meta"><strong>{reply.author}</strong> <time>{when(reply.createdAt)}</time></div>
      {editing ? (
        <Composer
          label="Edit reply" initial={reply.text} submitLabel="Save" clearOnSubmit={false} autoFocus
          onSubmit={(t) => (store.editReply(pageId, annot.id, reply.id, t), setEditing(false))}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <p>{reply.text}</p>
          <div className="row-actions">
            <button onClick={() => setEditing(true)}>Edit</button>
            <button onClick={() => store.deleteReply(pageId, annot.id, reply.id)}>Delete</button>
          </div>
        </>
      )}
    </li>
  );
}

function ThreadView({ thread, selected }: { thread: Thread; selected: boolean }) {
  const { store } = useUi();
  const [editing, setEditing] = useState(false);
  const { pageId, pageIndex, annot } = thread;
  const comment = annot.comment;

  const open = () => {
    store.setTool('select');
    store.selectAnnotation({ pageId, id: annot.id });
    store.setCurrentPage(pageIndex);
  };

  return (
    <li className={`thread${selected ? ' selected' : ''}`} data-annot-id={annot.id} aria-current={selected || undefined}>
      <button className="thread-head" onClick={open} aria-label={`${annotationName(annot)} on page ${pageIndex + 1}`}>
        <strong>{annotationName(annot)}</strong> <span>page {pageIndex + 1}</span>
      </button>
      <div className="meta"><strong>{annot.author}</strong> <time>{when(annot.modifiedAt)}</time></div>
      {editing ? (
        <Composer
          label="Edit comment" initial={comment?.text ?? ''} submitLabel="Save" clearOnSubmit={false} autoFocus
          onSubmit={(t) => (store.setComment(pageId, annot.id, t), setEditing(false))}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          {comment && <p className="body">{comment.text}</p>}
          <div className="row-actions">
            <button onClick={() => setEditing(true)}>Edit</button>
            {annot.type === 'note' ? (
              <button onClick={() => store.deleteAnnotation(pageId, annot.id)}>Delete note</button>
            ) : (
              <button onClick={() => store.removeComment(pageId, annot.id)}>Remove comment</button>
            )}
          </div>
        </>
      )}
      {comment && comment.replies.length > 0 && (
        <ul className="replies">
          {comment.replies.map((r) => <Reply key={r.id} thread={thread} reply={r} />)}
        </ul>
      )}
      {comment && <ReplyBox thread={thread} />}
    </li>
  );
}

function ReplyBox({ thread }: { thread: Thread }) {
  const { store } = useUi();
  return <Composer label="Reply" submitLabel="Reply" onSubmit={(t) => store.addReply(thread.pageId, thread.annot.id, t)} />;
}

function AuthorField() {
  const { store } = useUi();
  useSnapshot(); // re-render when the remembered name loads
  const [draft, setDraft] = useState<string | undefined>();
  const commit = () => {
    if (draft !== undefined) store.setAuthor(draft);
    setDraft(undefined);
  };
  return (
    <label className="author">
      Commenting as
      <input
        value={draft ?? store.getAuthor()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function CommentsPanel() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const threads = listThreads(doc);
  const selectedId = ui.selectedAnnot?.id;

  // Offer to comment on the selected annotation when it has no comment yet (notes always have one).
  const sel = ui.selectedAnnot && doc.annotations[ui.selectedAnnot.pageId]?.find((a) => a.id === ui.selectedAnnot!.id);
  // Notes always have a comment; a text box's text already lives in its own /Contents.
  const canAdd = sel && !sel.comment && sel.type !== 'note' && sel.type !== 'freetext' ? sel : undefined;
  const draftPage = ui.draftNote && doc.pages.findIndex((p) => p.id === ui.draftNote!.pageId) + 1;

  return (
    <aside className="comments" aria-label="Comments">
      <header>
        <h2>Comments</h2>
        <button onClick={() => store.toggleComments(false)} aria-label="Close comments">×</button>
      </header>
      <AuthorField />

      {ui.draftNote && (
        <section className="new-note" aria-label="New note">
          <h3>New note on page {draftPage}</h3>
          <Composer
            label="Note text" submitLabel="Add note" autoFocus
            onSubmit={(t) => store.saveDraftNote(t)}
            onCancel={() => store.cancelDraftNote()}
          />
        </section>
      )}

      {canAdd && sel && (
        <section className="new-note" aria-label="Add comment">
          <h3>Comment on this {annotationName(sel).toLowerCase()}</h3>
          <Composer label="Comment" submitLabel="Add comment" onSubmit={(t) => store.setComment(ui.selectedAnnot!.pageId, sel.id, t)} />
        </section>
      )}

      {threads.length === 0 && !ui.draftNote && !canAdd && (
        <p className="empty-hint">No comments yet. Choose the Note tool and click the page, or select an annotation to comment on it.</p>
      )}
      <ul className="threads">
        {threads.map((t) => <ThreadView key={t.annot.id} thread={t} selected={t.annot.id === selectedId} />)}
      </ul>
    </aside>
  );
}
