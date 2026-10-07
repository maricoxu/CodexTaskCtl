#!/usr/bin/env node

/**
 * Session and persistence primitives for the CodexTaskCtl dispatcher.
 *
 * This module deliberately has no Reminders or project-routing code.  It owns
 * only the Codex App Server JSON-RPC transport and the durable session fields
 * needed by a later reconciler.  The existing dispatcher can adopt these
 * primitives without changing the v2 dispatcher-state.json shape.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

export const DISPATCHER_STATE_VERSION = 2;
export const DEFAULT_SESSION_STATE = path.join(
  os.homedir(),
  ".config",
  "remctl",
  "desktop",
  "dispatcher-state.json",
);

// `failed` is retained for backwards compatibility with older state files.
// New callers should use unknown when delivery or completion is ambiguous.
export const SESSION_STATUSES = Object.freeze([
  "running",
  "review",
  "completed",
  "unknown",
  "failed",
]);

export function reminderIdentity(reminder = {}) {
  return reminder.cloudKitId || reminder.objectUUID || reminder.deepLink || `reminder:${reminder.id ?? reminder.reminderId}`;
}

export function ensureTaskUid(entry = {}) {
  if (entry.taskUid) return entry.taskUid;
  const stable = entry.reminderIdentity || entry.originalReminderId || entry.reminderId || "unknown";
  return `ctc-${createHash("sha256").update(String(stable)).digest("hex").slice(0, 32)}`;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isoNow() {
  return new Date().toISOString();
}

function asReminderKey(value) {
  return String(value);
}

/** Return an empty v2 state without changing the user-facing state model. */
export function emptyDispatcherState() {
  return { version: DISPATCHER_STATE_VERSION, lists: {}, items: {} };
}

/**
 * Normalize a state loaded from disk while preserving unknown fields.  This is
 * intentionally additive: existing dispatcher entries and list IDs survive
 * a later session-layer read/write cycle.
 */
export function normalizeDispatcherState(input) {
  const source = objectOrEmpty(input);
  const state = {
    ...source,
    version: DISPATCHER_STATE_VERSION,
    lists: objectOrEmpty(source.lists),
    items: {},
  };
  for (const [key, value] of Object.entries(objectOrEmpty(source.items))) {
    state.items[key] = normalizeSessionEntry(value);
  }
  return state;
}

/** Normalize one persisted reminder/session binding, preserving extra fields. */
export function normalizeSessionEntry(input) {
  const entry = { ...objectOrEmpty(input) };
  entry.taskUid = ensureTaskUid(entry);
  if (entry.originalReminderId == null && entry.reminderId != null) {
    entry.originalReminderId = entry.reminderId;
  }
  if (entry.reminderId == null && entry.originalReminderId != null) {
    entry.reminderId = entry.originalReminderId;
  }
  if (entry.status == null) entry.status = "unknown";
  if (entry.lastEventAt == null && entry.startedAt != null) entry.lastEventAt = entry.startedAt;
  if (entry.reminderId != null && !Array.isArray(entry.reminderIds)) entry.reminderIds = [entry.reminderId];
  if (entry.reminderIdentity && !Array.isArray(entry.reminderIdentities)) entry.reminderIdentities = [entry.reminderIdentity];
  return entry;
}

export function findSessionEntry(state, reminder = {}) {
  const id = Number(reminder.id ?? reminder.reminderId);
  const stableIdentity = reminder.cloudKitId || reminder.objectUUID || reminder.deepLink;
  const entries = Object.values(objectOrEmpty(state?.items));
  if (stableIdentity) {
    const byIdentity = entries.find(entry => entry.reminderIdentity === stableIdentity || (entry.reminderIdentities || []).includes(stableIdentity));
    if (byIdentity) return byIdentity;
  }
  return entries.find(entry => [entry.originalReminderId, entry.reminderId, ...(entry.reminderIds || [])].some(value => Number(value) === id)) || null;
}

export function bindReminder(entry, reminder = {}) {
  const next = normalizeSessionEntry({ ...entry });
  const id = reminder.id ?? reminder.reminderId;
  const identity = reminderIdentity(reminder);
  if (id != null) {
    next.reminderId = id;
    next.reminderIds = [...new Set([...(next.reminderIds || []), id])];
  }
  if (identity) {
    next.reminderIdentity ||= identity;
    next.reminderIdentities = [...new Set([...(next.reminderIdentities || []), identity])];
  }
  next.taskUid ||= ensureTaskUid(next);
  return next;
}

/**
 * Create the durable fields for a newly dispatched reminder.  `threadId` and
 * `turnId` can be added later after the two RPC calls return.
 */
export function createSessionEntry({
  originalReminderId,
  reminderId = originalReminderId,
  fingerprint,
  title,
  projectKey,
  projectId,
  status = "running",
  attemptId = randomUUID(),
  threadId,
  turnId,
  startedAt = isoNow(),
  taskUid = randomUUID(),
  reminderIdentity: stableReminderIdentity,
  ...extra
} = {}) {
  if (originalReminderId == null) throw new TypeError("originalReminderId is required");
  if (!SESSION_STATUSES.includes(status)) throw new TypeError(`Unsupported session status: ${status}`);
  return normalizeSessionEntry({
    originalReminderId,
    reminderId,
    ...(fingerprint == null ? {} : { fingerprint }),
    ...(title == null ? {} : { title }),
    ...(projectKey == null ? {} : { projectKey }),
    ...(projectId == null ? {} : { projectId }),
    status,
    taskUid,
    attemptId,
    ...(threadId == null ? {} : { threadId }),
    ...(turnId == null ? {} : { turnId }),
    startedAt,
    lastEventAt: startedAt,
    ...(stableReminderIdentity == null ? {} : { reminderIdentity: stableReminderIdentity, reminderIdentities: [stableReminderIdentity] }),
    ...extra,
  });
}

/** Apply an event patch and advance lastEventAt unless explicitly supplied. */
export function updateSessionEntry(entry, patch = {}, now = isoNow()) {
  const next = normalizeSessionEntry({ ...entry, ...patch });
  if (patch.lastEventAt == null) next.lastEventAt = now;
  return next;
}

export async function readDispatcherState(file = DEFAULT_SESSION_STATE) {
  try {
    return normalizeDispatcherState(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyDispatcherState();
    throw error;
  }
}

export async function writeDispatcherState(file, input) {
  const state = normalizeDispatcherState(input);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return state;
}

/** Small state store for adapters/reconcilers; locking remains the caller's job. */
export class DispatcherStateStore {
  constructor(file = DEFAULT_SESSION_STATE) {
    this.file = file;
  }

  async load() {
    return readDispatcherState(this.file);
  }

  async save(state) {
    return writeDispatcherState(this.file, state);
  }

  async get(reminderId) {
    const state = await this.load();
    return state.items[asReminderKey(reminderId)] || null;
  }

  async find(reminder) {
    return findSessionEntry(await this.load(), reminder);
  }

  async upsert(reminderId, patchOrEntry) {
    const state = await this.load();
    const key = asReminderKey(reminderId);
    const current = state.items[key] || {};
    const next = typeof patchOrEntry === "function"
      ? patchOrEntry(current)
      : { ...current, ...patchOrEntry };
    state.items[key] = normalizeSessionEntry(next);
    await this.save(state);
    return state.items[key];
  }
}

function responseText(turn) {
  return (turn?.items || [])
    .filter(item => item?.type === "agentMessage" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n")
    .trim();
}

function isTerminalTurnStatus(status) {
  return ["completed", "interrupted", "failed", "cancelled", "canceled"].includes(String(status).toLowerCase());
}

/**
 * JSON-RPC stdio transport for `codex app-server --stdio`.
 *
 * `spawnImpl` is injectable so the protocol can be tested without starting a
 * real Codex process.  The public methods return normalized IDs and turn
 * snapshots; raw RPC payloads remain available under `raw` where useful.
 */
export class CodexSessionTransport {
  constructor({
    command = "codex",
    args = ["app-server", "--stdio"],
    spawnImpl = nodeSpawn,
    requestTimeoutMs = 60_000,
    clientInfo = { name: "CodexTaskCtl Session Adapter", version: "0.1.0" },
  } = {}) {
    this.command = command;
    this.args = args;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = clientInfo;
    this.child = null;
    this.buffer = "";
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    this.started = false;
  }

  async start() {
    if (this.started) return this;
    this.child = this.spawnImpl(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    if (!this.child?.stdin || !this.child?.stdout) throw new Error("Codex transport process has no stdio pipes");
    this.child.stdout.setEncoding?.("utf8");
    this.child.stderr?.setEncoding?.("utf8");
    this.child.stdout.on("data", chunk => this.#consume(chunk));
    this.child.on?.("exit", (code, signal) => {
      for (const entry of this.pending.values()) entry.reject(new Error(`Codex app-server exited ${code ?? signal}`));
      this.pending.clear();
      this.started = false;
    });
    await this.request("initialize", { clientInfo: this.clientInfo, capabilities: {} });
    this.notify("initialized", {});
    this.started = true;
    return this;
  }

  #consume(chunk) {
    this.buffer += String(chunk);
    while (true) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || `Codex RPC ${message.error.code}`));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.notifications.push(message);
      }
    }
  }

  notify(method, params) {
    if (!this.child?.stdin?.write) throw new Error("Codex transport is not started");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.child?.stdin?.write) return Promise.reject(new Error("Codex transport is not started"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async startThread({ cwd, approvalPolicy = "never", sandbox = "read-only", threadSource = "codextaskctl" } = {}) {
    const raw = await this.request("thread/start", { cwd, approvalPolicy, sandbox, threadSource });
    const threadId = raw?.thread?.id;
    if (!threadId) throw new Error("Codex did not return thread id");
    return { threadId, raw };
  }

  async startTurn({ threadId, input } = {}) {
    if (!threadId) throw new TypeError("threadId is required");
    const raw = await this.request("turn/start", { threadId, input });
    const turnId = raw?.turn?.id;
    if (!turnId) throw new Error("Codex did not return turn id");
    return { turnId, raw };
  }

  async startSession({ cwd, input, approvalPolicy = "never", sandbox = "read-only", threadSource = "codextaskctl" } = {}) {
    const thread = await this.startThread({ cwd, approvalPolicy, sandbox, threadSource });
    const turn = await this.startTurn({ threadId: thread.threadId, input });
    return { threadId: thread.threadId, turnId: turn.turnId, thread, turn };
  }

  takeCompleted(threadId, turnId) {
    const index = this.notifications.findIndex(item =>
      item.method === "turn/completed"
      && item.params?.threadId === threadId
      && item.params?.turn?.id === turnId);
    if (index < 0) return null;
    return this.notifications.splice(index, 1)[0].params.turn;
  }

  async readThread(threadId) {
    if (!threadId) throw new TypeError("threadId is required");
    return this.request("thread/read", { threadId, includeTurns: true }, 30_000);
  }

  async readTurn(threadId, turnId) {
    const snapshot = await this.readThread(threadId);
    const turns = snapshot?.thread?.turns || [];
    return turns.find(turn => turn.id === turnId) || null;
  }

  async getTurnState(threadId, turnId) {
    const eventTurn = this.takeCompleted(threadId, turnId);
    if (eventTurn) {
      return { status: eventTurn.status || "completed", turn: eventTurn, response: responseText(eventTurn), source: "event" };
    }
    const turn = await this.readTurn(threadId, turnId);
    if (!turn) return { status: "unknown", turn: null, response: "", source: "read" };
    return { status: turn.status || "unknown", turn, response: responseText(turn), source: "read" };
  }

  async waitForTurn(threadId, turnId, { timeoutMs = 600_000, pollMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.getTurnState(threadId, turnId);
      if (isTerminalTurnStatus(state.status)) return state;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return { status: "unknown", turn: null, response: "", source: "timeout", error: "turn timed out" };
  }

  close() {
    this.child?.kill?.("SIGTERM");
    this.child = null;
    this.started = false;
  }
}

/** Stable fingerprint helper for callers that do not want to import dispatcher internals. */
export function sessionFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
