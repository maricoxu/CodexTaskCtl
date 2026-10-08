#!/usr/bin/env node

/**
 * Trusted local dispatcher for CodexTaskCtl.
 *
 * Reminders are capture and delivery queues. Mark a reminder completed after
 * Codex accepts its first turn; do not mirror Codex execution states.
 *
 * Keep one App Server connection alive while polling. Closing the client while
 * a turn is running interrupts that turn.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, stat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const DEFAULT_KEYWORD = "";
const DEFAULT_LIST = "延后交给 Codex";
const DEFAULT_STATE = path.join(os.homedir(), ".config", "remctl", "desktop", "dispatcher-state.json");
const IMMEDIATE_REQUEST_DIR = `${DEFAULT_STATE}.requests`;
const DEFAULT_REMCTL = path.join(os.homedir(), "bin", "remctl");
const DEFAULT_CODEX = "codex";
const DEFAULT_WORKSPACE = process.env.CODEX_TASKCTL_WORKSPACE || process.cwd();
const PROJECTS = {
  technical: { key: "technical", label: "提效基建", projectId: "7eb9a247-0887-484b-8fce-e8c7b2cdbd96", cwd: process.env.CODEX_TASKCTL_TECHNICAL_CWD },
  writing: { key: "writing", label: "微信公众号", projectId: "8003b1cb-0d9c-4412-b134-6b7de3caf311", cwd: process.env.CODEX_TASKCTL_WRITING_CWD },
  fallback: { key: "fallback", label: "yehua的笔记", projectId: "local-1af721bfef62a5c6b9b23cc54c074be1", cwd: process.env.CODEX_TASKCTL_FALLBACK_CWD },
};

const DISPATCHER_DEVELOPER_INSTRUCTIONS = [
  "这是由 CodexTaskCtl 分发的提醒事项。只执行用户消息中的任务内容。",
].join("\n");

function parseArgs(argv) {
  const options = {
    once: false, keyword: process.env.CODEX_TASKCTL_KEYWORD ?? DEFAULT_KEYWORD,
    list: process.env.CODEX_TASKCTL_LIST || DEFAULT_LIST, listId: process.env.CODEX_TASKCTL_LIST_ID || "",
    state: process.env.CODEX_TASKCTL_STATE || DEFAULT_STATE, workspace: DEFAULT_WORKSPACE,
    remctl: process.env.REMCTL_PATH || DEFAULT_REMCTL, codex: process.env.CODEX_PATH || DEFAULT_CODEX,
    intervalMs: Number(process.env.CODEX_TASKCTL_INTERVAL_MS || 600_000),
    turnTimeoutMs: Number(process.env.CODEX_TASKCTL_TURN_TIMEOUT_MS || 600_000),
    approvalPolicy: process.env.CODEX_TASKCTL_APPROVAL_POLICY || "never",
    sandbox: process.env.CODEX_TASKCTL_SANDBOX || "read-only",
    retryFailed: false, retryUnknown: false, dryRun: false, status: false, reminderId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]; const next = () => argv[++i];
    if (arg === "--once") options.once = true;
    else if (arg === "--retry-failed") options.retryFailed = true;
    else if (arg === "--retry-unknown") options.retryUnknown = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--keyword") options.keyword = next();
    else if (arg === "--list") options.list = next();
    else if (arg === "--list-id") options.listId = next();
    else if (arg === "--state") options.state = next();
    else if (arg === "--workspace") options.workspace = next();
    else if (arg === "--remctl") options.remctl = next();
    else if (arg === "--codex") options.codex = next();
    else if (arg === "--interval-ms") options.intervalMs = Number(next());
    else if (arg === "--turn-timeout-ms") options.turnTimeoutMs = Number(next());
    else if (arg === "--approval-policy") options.approvalPolicy = next();
    else if (arg === "--sandbox") options.sandbox = next();
    else if (arg === "--reminder-id") options.reminderId = Number(next());
    else if (arg === "--help" || arg === "-h") {
      console.log(`CodexTaskCtl trusted dispatcher

  --once Scan once and exit
  --reminder-id ID Dispatch one reminder immediately
  --keyword TEXT Optional title prefix filter; deferred list membership is sufficient by default
  --list NAME | --list-id ID Limit scans to one Reminders list
  --workspace PATH Codex working directory
  --interval-ms N Poll interval (default: 600000)
  --retry-failed Legacy flag; retained claims are never automatically resent
  --retry-unknown Legacy flag; retained claims are never automatically resent
  --dry-run Report candidates without starting Codex
  --status Print dispatcher state and exit without starting Codex
  --sandbox MODE read-only|workspace-write|danger-full-access
`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1_000) throw new Error("--interval-ms must be at least 1000");
  if (!Number.isFinite(options.turnTimeoutMs) || options.turnTimeoutMs < 10_000) throw new Error("--turn-timeout-ms must be at least 10000");
  if (!["read-only", "workspace-write", "danger-full-access"].includes(options.sandbox)) throw new Error("Unsupported --sandbox");
  if (!["never", "on-request"].includes(options.approvalPolicy)) throw new Error("Unsupported --approval-policy");
  if (options.reminderId != null && (!Number.isInteger(options.reminderId) || options.reminderId < 1)) throw new Error("--reminder-id must be a positive integer");
  return options;
}

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

async function writeAtomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
}

async function queueImmediateRequest(options, reminderId) {
  const requestDir = options.requestDir || IMMEDIATE_REQUEST_DIR;
  await mkdir(requestDir, { recursive: true, mode: 0o700 });
  const files = await readdir(requestDir).catch(() => []);
  for (const file of files.filter(name => name.endsWith(".json"))) {
    const request = await readJsonFile(path.join(requestDir, file), null);
    if (Number(request?.reminderId) === Number(reminderId)) {
      return { status: "queued", id: reminderId, requestFile: path.join(requestDir, file), deduplicated: true };
    }
  }
  const file = path.join(requestDir, `${Date.now()}-${randomUUID()}-${reminderId}.json`);
  await writeAtomicJson(file, { reminderId: Number(reminderId), requestedAt: new Date().toISOString(), source: "immediate" });
  const lock = await readFile(`${DEFAULT_STATE}.lock`, "utf8").catch(() => "");
  const owner = Number.parseInt(lock.trim(), 10);
  if (owner && owner !== process.pid) { try { process.kill(owner, "SIGUSR1"); } catch { /* owner exited; next scan consumes the request */ } }
  return { status: "queued", id: reminderId, requestFile: file, deduplicated: false };
}

async function pendingImmediateRequests(options = {}) {
  const requestDir = options.requestDir || IMMEDIATE_REQUEST_DIR;
  await mkdir(requestDir, { recursive: true, mode: 0o700 });
  const files = await readdir(requestDir).catch(() => []);
  const requests = [];
  for (const file of files.filter(name => name.endsWith(".json")).sort()) {
    const requestFile = path.join(requestDir, file);
    const request = await readJsonFile(requestFile, null);
    if (Number.isInteger(Number(request?.reminderId)) && Number(request.reminderId) > 0) requests.push({ ...request, requestFile });
    else await unlink(requestFile).catch(() => {});
  }
  return requests;
}

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
}

async function readStatus(options) {
  const state = normalizeStateBindings(await readJsonFile(options.state, newState()));
  const items = Object.values(state.items || {});
  const counts = items.reduce((result, item) => {
    const status = item.status || "unknown";
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  return { stateFile: options.state, version: state.version || 1, meta: state.meta || {}, counts, items };
}

async function acquireLock(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.sync();
    const owned = await handle.stat();
    return async () => {
      await handle.close();
      const current = await stat(file).catch(() => null);
      if (current?.ino === owned.ino) await unlink(file).catch(() => {});
    };
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        const owner = Number.parseInt((await readFile(file, "utf8")).trim(), 10);
        if (!owner || owner === process.pid) throw new Error(`Dispatcher already running: ${file}`);
        try { process.kill(owner, 0); throw new Error(`Dispatcher already running: ${file}`); }
        catch (probeError) {
          if (probeError?.code !== "ESRCH") throw probeError;
          // Serialize stale-lock recovery so two contenders cannot remove a
          // replacement lock held by the winner.
          const guard = await open(`${file}.recovery`, "wx", 0o600);
          try {
            if (Number.parseInt(await readFile(file, "utf8"), 10) !== owner) throw new Error(`Dispatcher already running: ${file}`);
            await unlink(file);
            return await acquireLock(file);
          } finally { await guard.close(); await unlink(`${file}.recovery`); }
        }
      } catch (staleError) {
        if (staleError?.message?.startsWith("Dispatcher already running:")) throw staleError;
        throw error;
      }
    }
    throw error;
  }
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function runFingerprint(reminder) {
  return createHash("sha256").update(JSON.stringify({
    title: reminder.title || "", notes: reminder.notes || "",
    attachments: (reminder.attachments || []).map(item => item.path || item.filename || ""),
  })).digest("hex");
}

function stableTaskUid(entry) {
  if (entry.taskUid) return entry.taskUid;
  const identity = entry.reminderIdentity || entry.originalReminderId || entry.reminderId || "unknown";
  return `ctc-${createHash("sha256").update(String(identity)).digest("hex").slice(0, 32)}`;
}

function normalizeStateBindings(state) {
  for (const entry of Object.values(state.items || {})) {
    entry.taskUid = stableTaskUid(entry);
    if (entry.reminderId != null && !Array.isArray(entry.reminderIds)) entry.reminderIds = [entry.reminderId];
    if (entry.reminderIdentity && !Array.isArray(entry.reminderIdentities)) entry.reminderIdentities = [entry.reminderIdentity];
    if (!Array.isArray(entry.attempts)) entry.attempts = [];
  }
  return state;
}

function reminderIdentity(reminder) {
  return reminder.cloudKitId || reminder.objectUUID || reminder.deepLink || `reminder:${reminder.id}`;
}

function findEntry(state, reminder) {
  const id = Number(reminder.id);
  const stableIdentity = reminder.cloudKitId || reminder.objectUUID || reminder.deepLink;
  const entries = Object.values(state.items || {});
  if (stableIdentity) {
    const byIdentity = entries.find(entry => entry.reminderIdentity === stableIdentity || (entry.reminderIdentities || []).includes(stableIdentity));
    if (byIdentity) return byIdentity;
  }
  return entries.find(entry => [entry.originalReminderId, entry.reminderId, ...(entry.reminderIds || [])].some(value => Number(value) === id));
}

async function remctlJson(options, args) {
  if (options.remctlCall) return options.remctlCall(args);
  const { stdout } = await execFileAsync(options.remctl, args, { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function resultItems(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

async function findReminders(options) {
  if (options.reminderId != null) return [await remctlJson(options, ["info", String(options.reminderId), "--json"])]
  const args = options.keyword.trim() ? ["search", options.keyword, "--limit", "500", "--json"] : ["show"];
  if (options.listId) args.push("--list-id", String(options.listId)); else if (options.list) {
    if (args[0] === "show") args.push(options.list); else args.push("--list", options.list);
  }
  if (args[0] === "show") args.push("--json");
  const result = await remctlJson(options, args);
  return resultItems(result);
}

function isCandidate(reminder, options) {
  if (!reminder || reminder.completed || reminder.isSubtask) return false;
  if (options.reminderId != null) return true;
  const title = String(reminder.title || "").trim().toLocaleLowerCase();
  const keyword = options.keyword.trim().toLocaleLowerCase();
  if (!keyword) return true;
  return title === keyword || title.startsWith(`${keyword} `) || title.startsWith(`${keyword}:`) || title.startsWith(`${keyword}：`) || title.startsWith(`[${keyword}]`) || title.startsWith(`${keyword}做`);
}

function classifyReminder(reminder) {
  const text = `${reminder.title || ""}\n${reminder.notes || ""}`.toLocaleLowerCase();
  if (/(公众号|微信公众号|写作|文章|科普|排版|草稿|发布)/.test(text)) return PROJECTS.writing;
  if (/(代码|编译|调试|cuda|pytorch|triton|sglang|xpu|昆仑芯|技术|源码|性能)/.test(text)) return PROJECTS.technical;
  return PROJECTS.fallback;
}

function taskContentFor(reminder) {
  const title = String(reminder?.title || "").trim();
  const notes = String(reminder?.notes || "").trim();
  if (title && notes) return `${title}：\n${notes}`;
  return title || notes || "（无内容）";
}

function promptFor(reminder) {
  return taskContentFor(reminder);
}

function turnText(turn) {
  return (turn?.items || []).filter(item => item.type === "agentMessage" && typeof item.text === "string").map(item => item.text).join("\n").trim();
}

function inputFor(reminder) {
  const inputs = [{ type: "text", text: promptFor(reminder) }];
  for (const attachment of (reminder.attachments || []).slice(0, 8)) {
    if (attachment?.path && attachment.resolved !== false) inputs.push({ type: "localImage", path: attachment.path, detail: "high" });
  }
  return inputs;
}

class CodexAppServer {
  constructor(command) { this.command = command; this.child = null; this.buffer = ""; this.nextId = 0; this.pending = new Map(); this.notifications = []; }

  async start() {
    this.child = spawn(this.command, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.#consume(chunk));
    this.child.stderr.on("data", chunk => process.stderr.write(`[codex] ${chunk}`));
    this.child.on("exit", (code, signal) => { for (const entry of this.pending.values()) entry.reject(new Error(`Codex app-server exited ${code ?? signal}`)); this.pending.clear(); });
    await this.request("initialize", { clientInfo: { name: "CodexTaskCtl Dispatcher", version: "0.2.0" }, capabilities: {} }, 30_000);
    this.notify("initialized", {});
  }

  #consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const end = this.buffer.indexOf("\n"); if (end < 0) return;
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1); if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || `Codex RPC ${message.error.code}`)); else entry.resolve(message.result);
      } else if (message.method) this.notifications.push(message);
    }
  }

  notify(method, params) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }

  request(method, params, timeoutMs) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async startTurn(cwd, inputs, options) {
    const thread = await this.request("thread/start", {
      cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
      developerInstructions: DISPATCHER_DEVELOPER_INSTRUCTIONS,
      threadSource: "codextaskctl",
    }, 60_000);
    const threadId = thread?.thread?.id; if (!threadId) throw new Error("Codex did not return thread id");
    // Persist the binding before sending a turn. An uncertain turn/start must
    // never cause a second thread/start for this reminder.
    await options.onThreadStarted?.(threadId);
    const turn = await this.request("turn/start", { threadId, input: inputs }, 60_000);
    const turnId = turn?.turn?.id; if (!turnId) throw new Error("Codex did not return turn id");
    return { threadId, turnId };
  }

  takeCompleted(threadId, turnId) {
    const index = this.notifications.findIndex(item => item.method === "turn/completed" && item.params?.threadId === threadId && item.params?.turn?.id === turnId);
    if (index < 0) return null;
    return this.notifications.splice(index, 1)[0].params.turn;
  }

  async readThread(threadId) { return this.request("thread/read", { threadId, includeTurns: true }, 30_000); }

  close() { this.child?.kill("SIGTERM"); }
}

async function completeReminder(options, reminderId) {
  const before = await remctlJson(options, ["info", String(reminderId), "--json"]);
  if (before?.completed) return before;
  await remctlJson(options, ["done", String(reminderId), "--json"]);
  const current = await remctlJson(options, ["info", String(reminderId), "--json"]);
  if (!current?.completed) throw new Error(`Reminder ${reminderId} completion was not confirmed`);
  return current;
}

async function hydrate(options, reminder) {
  if (reminder.attachments || reminder.notes !== undefined) return reminder;
  return remctlJson(options, ["info", String(reminder.id), "--json"]);
}

function newState() { return { version: 3, lists: {}, items: {}, meta: {} }; }

async function processCompletedTurn(options, state, entry, turn) {
  const response = turnText(turn); entry.response = response; entry.turnStatus = turn.status; entry.lastEventAt = new Date().toISOString();
  entry.turnCompletedAt = entry.turnCompletedAt || entry.lastEventAt;
  const attempt = (entry.attempts || []).find(item => item.turnId === entry.turnId);
  if (attempt) { attempt.status = turn.status; attempt.finishedAt = entry.turnCompletedAt; attempt.response = response; }
  if (turn.status !== "completed") entry.turnError = turn.error?.message || `turn ${turn.status}`;
  await writeJsonFile(options.state, state);
  return true;
}

async function processCompletion(options, server, state, entry) {
  const deadline = entry.turnDeadlineAt
    ? Date.parse(entry.turnDeadlineAt)
    : (entry.turnStartedAt ? Date.parse(entry.turnStartedAt) + options.turnTimeoutMs : 0);
  try {
    const eventTurn = server.takeCompleted(entry.threadId, entry.turnId);
    if (eventTurn) return processCompletedTurn(options, state, entry, eventTurn);
    const snapshot = await server.readThread(entry.threadId);
    const turns = snapshot?.thread?.turns || [];
    const turn = turns.find(item => item.id === entry.turnId);
    if (turn && ["completed", "interrupted", "failed", "cancelled", "canceled"].includes(turn.status)) return processCompletedTurn(options, state, entry, turn);
    if (deadline && Date.now() >= deadline) {
      entry.overdueAt ||= new Date().toISOString();
      entry.lastPollError = "Turn exceeded expected duration; still observing the original session, without redispatch";
      await writeJsonFile(options.state, state);
    }
    if (entry.pollErrorCount) { entry.pollErrorCount = 0; await writeJsonFile(options.state, state); }
  } catch (error) {
    entry.pollErrorCount = (entry.pollErrorCount || 0) + 1;
    entry.lastPollError = error.message;
    // A single failed read is a transient observation error. Only stop retrying
    // after repeated failures; a confirmed timeout still becomes unknown above.
    if (entry.pollErrorCount >= 3) {
      entry.turnStatus = "unknown";
      entry.turnObservationError = `Codex completion could not be observed after ${entry.pollErrorCount} polls: ${error.message}`;
      entry.failedAt = new Date().toISOString();
    }
    await writeJsonFile(options.state, state);
    return entry.status === "unknown";
  }
  return false;
}

async function startCandidate(options, server, state, reminder) {
  const project = classifyReminder(reminder);
  const current = await hydrate(options, reminder);
  const originalId = Number(current.id);
  const fingerprint = runFingerprint(current);
  const previous = findEntry(state, current);
  // Content changes and list moves are not new task identities. Even failed or
  // uncertain submissions retain their claim; retry flags cannot bypass it.
  if (previous) return { status: "skipped", id: originalId, reason: previous.status, threadId: previous.threadId };
  if (options.dryRun) return { status: "candidate", id: originalId, project: project.key };

  const trigger = options.dispatchTrigger || (options.reminderId != null ? "immediate" : "deferred");
  const entry = { taskUid: randomUUID(), originalReminderId: originalId, reminderId: originalId, reminderIdentity: reminderIdentity(current), reminderIdentities: [reminderIdentity(current)], reminderIds: [originalId], fingerprint, title: current.title, projectKey: project.key, projectId: project.projectId, workspace: project.cwd || options.workspace, status: "dispatching", attemptId: randomUUID(), attempts: [], trigger, startedAt: new Date().toISOString() };
  state.items[String(originalId)] = entry; await writeJsonFile(options.state, state);
  try {
    const started = await server.startTurn(project.cwd || options.workspace, inputFor(current), {
      ...options, onThreadStarted: async threadId => {
        entry.threadId = threadId;
        entry.threadCreatedAt = new Date().toISOString();
        await writeJsonFile(options.state, state);
      },
    });
    const turnStartedAt = new Date();
    Object.assign(entry, started, { status: "delivered", deliveryState: "delivered",
      turnStartedAt: turnStartedAt.toISOString(),
      turnDeadlineAt: new Date(turnStartedAt.getTime() + options.turnTimeoutMs).toISOString(),
    }); await writeJsonFile(options.state, state);
    entry.attempts.push({ attemptId: entry.attemptId, threadId: entry.threadId, turnId: entry.turnId, fingerprint: entry.fingerprint, startedAt: entry.startedAt, status: "delivered", trigger });
    await writeJsonFile(options.state, state);
    try {
      await completeReminder(options, entry.reminderId);
      entry.reminderCompletedAt = new Date().toISOString();
      entry.completionWritebackPending = false;
    } catch (error) {
      entry.completionWritebackPending = true;
      entry.completionWritebackError = error.message;
    }
    await writeJsonFile(options.state, state);
    return { status: "delivered", id: originalId, reminderId: entry.reminderId, threadId: entry.threadId, turnId: entry.turnId, project: project.key, completionWritebackPending: Boolean(entry.completionWritebackPending) };
  } catch (error) {
    // A failed reminder move must not erase a successful dispatch.
    if (!entry.turnId) entry.status = "unknown";
    entry.error = error.message; entry.failedAt = new Date().toISOString(); await writeJsonFile(options.state, state);
    if (entry.turnId) return { status: "delivered", id: originalId, threadId: entry.threadId, turnId: entry.turnId, completionWritebackPending: true, error: error.message };
    return { status: "unknown", id: originalId, error: error.message };
  }
}

async function retryCompletionWriteback(options, state, entry) {
  if (!entry.completionWritebackPending) return false;
  try {
    await completeReminder(options, entry.reminderId);
    entry.completionWritebackPending = false;
    entry.reminderCompletedAt ||= new Date().toISOString();
    delete entry.completionWritebackError;
    await writeJsonFile(options.state, state);
    return true;
  } catch (error) {
    entry.completionWritebackError = error.message;
    await writeJsonFile(options.state, state);
    return false;
  }
}

async function scan(options, server, state) {
  if (options.dryRun) {
    const candidates = (await findReminders(options)).filter(item => isCandidate(item, options));
    const items = [];
    for (const reminder of candidates) items.push(await startCandidate(options, server, state, reminder));
    return { scanned: candidates.length, started: 0, candidates: items.filter(item => item.status === "candidate").length, items };
  }
  state.meta ||= {};
  state.meta.lastScanAt = new Date().toISOString();
  state.meta.pid = process.pid;
  state.meta.state = "scanning";
  delete state.meta.lastError;
  await writeJsonFile(options.state, state);
  const result = { scanned: 0, delivered: 0, started: 0, reviewed: 0, completed: 0, skipped: 0, failed: 0, items: [] };
  let immediateHandled = false;
  for (const entry of Object.values(state.items)) {
    await retryCompletionWriteback(options, state, entry);
    if (server && entry.status === "delivered" && entry.threadId && entry.turnId) await processCompletion(options, server, state, entry);
  }
  if (!options.dryRun) {
    for (const request of await pendingImmediateRequests(options)) {
      immediateHandled = true;
      try {
        const reminder = await hydrate(options, await remctlJson(options, ["info", String(request.reminderId), "--json"]));
        const outcome = reminder.completed
          ? { status: "skipped", id: request.reminderId, reason: "completed" }
          : await startCandidate({...options, dispatchTrigger: "immediate"}, server, state, reminder);
        result.items.push({ ...outcome, trigger: "immediate" });
        if (["delivered", "started"].includes(outcome.status)) { result.delivered += 1; result.started += 1; }
        else if (outcome.status === "unknown") result.failed += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1; result.items.push({ status: "unknown", id: request.reminderId, trigger: "immediate", error: error.message });
      } finally { await unlink(request.requestFile).catch(() => {}); }
    }
  }
  // An immediate request is an explicit trigger. Do not let the same scan fall
  // through into the periodic keyword path, even if the turn is already
  // completed or the request was skipped by an existing binding.
  if (immediateHandled) {
    delete state.meta.lastError;
    state.meta.lastResult = result;
    state.meta.lastCompletedAt = new Date().toISOString();
    state.meta.state = "idle";
    await writeJsonFile(options.state, state);
    return result;
  }
  const reminders = (await findReminders(options)).filter(item => isCandidate(item, options)); result.scanned = reminders.length;
  for (const reminder of reminders) {
    const outcome = await startCandidate(options, server, state, reminder); result.items.push(outcome);
    if (outcome.status === "delivered" || outcome.status === "started" || outcome.status === "candidate") { result.delivered += outcome.status === "candidate" ? 0 : 1; result.started += 1; }
    else if (outcome.status === "unknown") result.failed += 1; else result.skipped += 1;
    if (["started", "unknown"].includes(outcome.status)) break;
  }
  state.meta.lastResult = result;
  delete state.meta.lastError;
  state.meta.lastCompletedAt = new Date().toISOString();
  state.meta.state = "idle";
  await writeJsonFile(options.state, state); return result;
}

async function sleep(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }

function createWakeGate() {
  let wake = null;
  let pending = false;
  const handler = () => { const resolve = wake; wake = null; if (resolve) resolve(); else pending = true; };
  process.on("SIGUSR1", handler);
  return {
    wait(ms) {
      return new Promise(resolve => {
        if (pending) { pending = false; resolve(); return; }
        const timer = setTimeout(() => { wake = null; resolve(); }, ms);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    },
    close() { process.off("SIGUSR1", handler); wake = null; pending = false; },
  };
}

async function run(options) {
  if (options.status) {
    console.log(JSON.stringify(await readStatus(options), null, 2));
    return;
  }
  if (options.reminderId != null) {
    const previous = findEntry(await readJsonFile(options.state, newState()), {id: options.reminderId});
    if (previous) {
      const result = {status: "skipped", id: options.reminderId, reason: previous.status, threadId: previous.threadId};
      console.log(JSON.stringify(result)); return result;
    }
  }
  if (options.dryRun) {
    const result = await scan(options, null, await readJsonFile(options.state, newState()));
    console.log(JSON.stringify(result, null, 2)); return result;
  }
  // All entry points on this Mac share one process lock, including custom-state
  // invocations. Production uses the single default state file.
  let release;
  try { release = await acquireLock(`${DEFAULT_STATE}.lock`); }
  catch (error) {
    if (options.reminderId != null && /Dispatcher already running:/.test(error.message)) {
      const result = await queueImmediateRequest(options, options.reminderId);
      console.log(JSON.stringify(result)); return result;
    }
    throw error;
  }
  const server = new CodexAppServer(options.codex);
  const wakeGate = createWakeGate();
  try {
  const state = await readJsonFile(options.state, newState());
  normalizeStateBindings(state);
  if (!state.items || typeof state.items !== "object") state.items = {};
  if (!state.lists || typeof state.lists !== "object") state.lists = {};
  state.version = 3;
  state.meta ||= {};
  state.meta.lastStartedAt = new Date().toISOString();
  state.meta.pid = process.pid;
  await writeJsonFile(options.state, state);
    for (const entry of Object.values(state.items)) {
      if (entry.status === "dispatching") { entry.status = "unknown"; entry.error = "Dispatcher restarted during dispatch; claim retained"; }
    }
    await writeJsonFile(options.state, state);
    await server.start();
    if (options.reminderId != null || options.once) {
      const result = await scan(options, server, state); console.log(JSON.stringify(result, null, 2));
      // Keep the transport alive for work this invocation actually submitted.
      // --once means one inbox scan, not immediate termination of the turn.
      const submitted = result.items.filter(item => ["started", "delivered"].includes(item.status)).map(item => findEntry(state, {id: item.id}));
      while (submitted.some(item => item?.status === "delivered" && !["completed", "failed", "interrupted", "cancelled", "canceled", "unknown"].includes(item.turnStatus))) {
        await sleep(2000);
        for (const item of submitted.filter(item => item?.status === "delivered" && !["completed", "failed", "interrupted", "cancelled", "canceled", "unknown"].includes(item.turnStatus))) {
          await processCompletion(options, server, state, item);
        }
      }
      return result;
    }
    for (;;) {
      try { const result = await scan(options, server, state); console.log(JSON.stringify(result)); }
      catch (error) { state.meta.lastError = error.message; await writeJsonFile(options.state, state); console.error(error.message); }
      await wakeGate.wait(options.intervalMs);
    }
  } finally { wakeGate.close(); server.close(); await release(); }
}

export { acquireLock, CodexAppServer, classifyReminder, findEntry, findReminders, inputFor, isCandidate, normalizeStateBindings, parseArgs, pendingImmediateRequests, processCompletion, promptFor, queueImmediateRequest, readStatus, reminderIdentity, runFingerprint, scan, stableTaskUid, startCandidate, taskContentFor };

if (path.basename(process.argv[1] || "") === path.basename(fileURLToPath(import.meta.url))) {
  try { await run(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
