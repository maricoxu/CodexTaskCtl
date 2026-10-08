#!/usr/bin/env node

/**
 * Capture/delivery reconciliation for CodexTaskCtl.
 *
 * Reminders are intentionally not a mirror of Codex runtime state. This
 * module only finds deferred captures and retries a confirmed delivery
 * writeback; it never moves reminders through running/review lists.
 */
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export const DEFAULT_STATE = path.join(os.homedir(), ".config", "remctl", "desktop", "dispatcher-state.json");
export const LISTS = Object.freeze({ inbox: "收集箱", deferred: "延后交给 Codex" });
export const STATUSES = Object.freeze({ dispatching: "dispatching", delivered: "delivered", unknown: "unknown" });

function todayInShanghai(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai"}).format(now);
}

export function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {version: Number(state.version) || 3, lists: {...(state.lists || {})}, items: {...(state.items || {})}, meta: {...(state.meta || {})}};
}

export async function readState(statePath = DEFAULT_STATE) {
  try { return normalizeState(JSON.parse(await readFile(statePath, "utf8"))); }
  catch (error) { if (error?.code === "ENOENT") return normalizeState(); throw error; }
}

export async function writeState(statePath, state) {
  const normalized = normalizeState(state);
  await mkdir(path.dirname(statePath), {recursive: true, mode: 0o700});
  const temp = `${statePath}.${process.pid}.reconciler.tmp`;
  await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, {mode: 0o600});
  await rename(temp, statePath);
  return normalized;
}

function idOf(reminder) { return Number(reminder?.id ?? reminder?.reminderId); }
function listOf(reminder) { return String(reminder?.list ?? reminder?.listName ?? ""); }

export function buildReconciliationPlan({state, reminders = [], today = todayInShanghai()}) {
  const normalized = normalizeState(state);
  const snapshot = Array.isArray(reminders) ? reminders : [];
  const byId = new Map(snapshot.map(item => [String(idOf(item)), item]));
  const candidates = [];
  const actions = [];
  for (const reminder of snapshot) {
    if (reminder.completed || reminder.isSubtask || listOf(reminder) !== LISTS.deferred) continue;
    const key = String(idOf(reminder));
    const entry = normalized.items[key] || Object.values(normalized.items).find(item => Number(item.reminderId) === idOf(reminder) || (item.reminderIds || []).includes(idOf(reminder)));
    if (!entry) {
      const candidate = {type: "candidate", reminderId: idOf(reminder), title: reminder.title || "", list: LISTS.deferred, dispatchable: true};
      candidates.push(candidate); actions.push(candidate);
    }
  }
  for (const [key, entry] of Object.entries(normalized.items)) {
    const reminder = byId.get(String(entry.reminderId ?? entry.originalReminderId));
    if (entry.completionWritebackPending && entry.turnStatus === "completed" && entry.completionDecision === "DONE" && reminder && !reminder.completed) {
      actions.push({type: "complete", key, reminderId: idOf(reminder)});
    }
  }
  return {version: 2, today, candidates, actions};
}

export async function applyReconciliationPlan({plan, state, adapter, now = new Date().toISOString()}) {
  if (!adapter || typeof adapter.completeReminder !== "function") throw new TypeError("reconciler adapter must implement completeReminder");
  const nextState = normalizeState(state); const results = [];
  for (const action of plan?.actions || []) {
    if (action.type === "candidate") { results.push({...action, applied: false}); continue; }
    const entry = nextState.items[action.key];
    if (entry?.turnStatus !== "completed" || entry?.completionDecision !== "DONE") {
      results.push({...action, applied: false, error: "No confirmed DONE turn"}); continue;
    }
    try {
      await adapter.completeReminder(action.reminderId);
      if (entry) { entry.status = "completed"; entry.completionWritebackPending = false; entry.reminderCompletedAt ||= now; entry.reconciledAt = now; }
      results.push({...action, applied: true});
    } catch (error) { results.push({...action, applied: false, error: error?.message || String(error)}); }
  }
  return {state: nextState, results};
}

export async function reconcileOnce({state, reminders, readReminders, adapter, today = todayInShanghai(), dryRun = false, now = new Date().toISOString()}) {
  const snapshot = reminders || (typeof readReminders === "function" ? await readReminders() : []);
  const plan = buildReconciliationPlan({state, reminders: snapshot, today});
  if (dryRun || !adapter) return {plan, state: normalizeState(state), results: plan.actions.map(action => ({...action, applied: false}))};
  const applied = await applyReconciliationPlan({plan, state, adapter, now});
  return {plan, ...applied};
}

export default {DEFAULT_STATE, LISTS, STATUSES, applyReconciliationPlan, buildReconciliationPlan, normalizeState, readState, reconcileOnce, todayInShanghai, writeState};
