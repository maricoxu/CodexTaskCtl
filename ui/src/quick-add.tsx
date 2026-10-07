import React, {useEffect, useRef, useState} from "react";
import {CalendarDays, Flag, List, Plus, X, AlignLeft, AlertCircle, Play} from "lucide-react";
import {DueEditor} from "./date-editor";
import {Select} from "./pickers";
import {listChoices} from "./interactions";
import type {RecordData as D} from "./bridge";
import {readCaptureImage, type CaptureImage} from "./quick-capture";

/** A preserved draft, placed above the host's bottom conversation composer. */
export function QuickAdd({draft, update, lists, busy, error, dispatcherWorkspace, close, save}: {
  draft: D; update: (draft: D) => void; lists: D[]; busy: boolean; error: string; dispatcherWorkspace?: string;
  close: () => void; save: (another: boolean) => void;
}) {
  const panel = useRef<HTMLFormElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const [dates, setDates] = useState(false);
  const [notes, setNotes] = useState(Boolean(draft.notes));
  const images = ((draft._capture?.images || []) as CaptureImage[]);
  const [reading, setReading] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const latest = useRef(draft); latest.current = draft;
  const locked = busy || reading || Boolean(draft._capture?.blocked);
  const fieldLocked = locked || Boolean(draft._capture?.reminderId);
  const canSubmit = !busy && !reading && !draft._capture?.blocked && Boolean(draft.title?.trim()) &&
    (!draft._capture?.reminderId || images.some(image => !image.attached));
  const ingest = async (files: File[]) => {
    if (locked || !files.length) return;
    if (images.length + files.length > 4) {setPasteError("Up to 4 images per reminder."); return;}
    setReading(true); setPasteError("");
    try {
      const next = await Promise.all(files.map(readCaptureImage));
      const current = latest.current;
      update({...current, _capture: {...(current._capture || {operationId: crypto.randomUUID(), images: []}),
        images: [...(current._capture?.images || []), ...next]}});
    } catch (error) { setPasteError((error as Error).message); }
    finally {setReading(false);}
  };
  const set = (key: string, value: any) => update({...draft, [key]: value});
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    title.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (!draft.title && !busy) title.current?.focus(); }, [draft.title, busy]);
  const dateLabel = !draft.due ? "When" : new Date(draft.due.slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, {month:"short", day:"numeric"}) + (draft.due.length > 10 ? ` · ${draft.due.slice(11,16)}` : "");
  return <div className="capture-backdrop" onMouseDown={e => {if(e.target === e.currentTarget && !busy && !reading) close();}}>
    <form ref={panel} className="capture-panel" role="dialog" aria-modal="true" aria-label="New reminder"
      onPaste={e => {
        const pasted = Array.from(e.clipboardData.items)
          .filter(item => item.kind === "file" && item.type.startsWith("image/"))
          .map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
        if (pasted.length) {e.preventDefault(); void ingest(pasted);}
      }}
      onSubmit={e => {e.preventDefault(); if (canSubmit) save(false);}}
      onKeyDown={e => {
        if (e.key === "Escape") {e.preventDefault(); e.stopPropagation(); if(dates) setDates(false); else if(!busy && !reading) close();}
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {e.preventDefault(); if(canSubmit) save(true);}
        if (e.key === "Tab") {
          const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') || []).filter(el => el.getClientRects().length);
          if (e.shiftKey && document.activeElement === controls[0]) {e.preventDefault(); controls.at(-1)?.focus();}
          else if (!e.shiftKey && document.activeElement === controls.at(-1)) {e.preventDefault(); controls[0]?.focus();}
        }
      }}>
      <div className="capture-heading"><span>New Reminder</span><button type="button" aria-label="Close quick add" disabled={busy || reading} onClick={close}><X size={17}/></button></div>
      <div className="capture-title"><span className="capture-circle"/><input ref={title} aria-label="New reminder title" placeholder="What do you need to do?" autoComplete="off" maxLength={1024} value={draft.title || ""} disabled={fieldLocked} onChange={e=>set("title",e.target.value)}/></div>
      {notes && <textarea className="capture-notes" aria-label="Reminder notes" placeholder="Add a note…" rows={3} maxLength={16384} value={draft.notes || ""} disabled={fieldLocked} onChange={e=>set("notes",e.target.value)}/>}
      {images.length > 0 && <div className="capture-images" aria-label={`${images.length} pasted images`}>
        {images.map((file, index) => <span className="capture-image-chip" key={file.id}><img className="capture-image-thumbnail" src={"data:" + file.mimeType + ";base64," + file.data} alt="Pasted preview"/><span>{file.name || "Pasted image"}</span><button type="button" aria-label={`Remove image ${index + 1}`} disabled={busy || reading || file.attached || Boolean(draft._capture?.blocked)} onClick={() => update({...draft, _capture: {...(draft._capture || {operationId: crypto.randomUUID(), images: []}), images: images.filter((_, i) => i !== index)}})}><X size={12}/></button></span>)}
      </div>}
      {pasteError && <div className="capture-error" role="alert"><AlertCircle size={15}/><span>{pasteError}</span></div>}
      <div className="capture-chips">
        <label className="capture-chip capture-list"><Select aria-label="Reminder list" disabled={fieldLocked || Boolean(draft.parent_id)} value={draft.list_id || draft.list || ""} onChange={e=>update({...draft,list_id:e.target.value ? Number(e.target.value) : undefined,list:undefined,section_id:undefined,section:undefined})}
          options={[{value: "", label: "Default list", text: "Default list", icon: <List size={14}/>}, ...(draft.list && !lists.some(l=>l.title===draft.list) ? [{value: draft.list, label: draft.list, text: draft.list}] : []), ...listChoices(lists)]}/></label>
        <button type="button" className={"capture-chip " + (draft.due ? "chosen" : "")} aria-expanded={dates} onClick={()=>setDates(!dates)} disabled={fieldLocked}><CalendarDays size={14}/>{dateLabel}</button>
        <label className={"capture-chip " + (draft.priority && draft.priority !== "none" ? "chosen" : "")}><span className="capture-priority">!</span><Select aria-label="Reminder priority" disabled={fieldLocked} value={draft.priority || "none"} onChange={e=>set("priority",e.target.value)}><option value="none">Priority</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select></label>
        <button type="button" className={"capture-chip capture-icon " + (draft.flagged ? "flagged" : "")} aria-label="Flag reminder" aria-pressed={Boolean(draft.flagged)} disabled={locked} onClick={()=>set("flagged",!draft.flagged)}><Flag size={15} fill={draft.flagged ? "currentColor" : "none"}/></button>
        <button type="button" className="capture-chip capture-icon" aria-label="Add notes" aria-expanded={notes} disabled={fieldLocked} onClick={()=>setNotes(!notes)}><AlignLeft size={15}/></button>
        <button type="button" className={"capture-chip capture-icon " + (draft.dispatch_now ? "chosen" : "")} aria-label="Run with Codex immediately" aria-pressed={Boolean(draft.dispatch_now)} title={dispatcherWorkspace ? "Save and start Codex immediately" : "Set a dispatcher workspace in Settings first"} disabled={fieldLocked || !dispatcherWorkspace} onClick={()=>set("dispatch_now",!draft.dispatch_now)}><Play size={15} fill={draft.dispatch_now ? "currentColor" : "none"}/></button>
      </div>
      {dates && <div className="capture-date"><DueEditor value={draft.due || ""} change={v=>set("due",v)}/></div>}
      {error && <div className="capture-error" role="alert"><AlertCircle size={15}/><span>{error}</span></div>}
      <div className="capture-footer"><span><kbd>⌘ ↵</kbd> Add another</span><button type="submit" className="primary" disabled={!canSubmit}><Plus size={15}/>{busy ? "Saving…" : draft._capture?.reminderId ? "Retry remaining images" : "Add Reminder"}</button></div>
    </form>
  </div>;
}
