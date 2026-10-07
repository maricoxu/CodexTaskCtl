import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CodexSessionTransport,
  DispatcherStateStore,
  bindReminder,
  createSessionEntry,
  emptyDispatcherState,
  findSessionEntry,
  normalizeDispatcherState,
  readDispatcherState,
  reminderIdentity,
  sessionFingerprint,
  updateSessionEntry,
  writeDispatcherState,
} from "../scripts/codextaskctl-session.mjs";

class FakeStream extends EventEmitter {
  setEncoding() {}
}

class FakeCodexProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.turns = [];
    this.stdin = {
      write: line => {
        const message = JSON.parse(line);
        if (message.id == null) return;
        const result = this.#result(message);
        setImmediate(() => this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
      },
    };
  }

  #result(message) {
    if (message.method === "initialize") return {};
    if (message.method === "thread/start") return { thread: { id: "thread-test-1" } };
    if (message.method === "turn/start") {
      this.turns = [{ id: "turn-test-1", status: "inProgress", items: [] }];
      return { turn: this.turns[0] };
    }
    if (message.method === "thread/read") return { thread: { id: "thread-test-1", turns: this.turns } };
    throw new Error(`unexpected method ${message.method}`);
  }

  complete(text = "done") {
    this.turns = [{ id: "turn-test-1", status: "completed", items: [{ type: "agentMessage", text }] }];
    setImmediate(() => this.stdout.emit("data", `${JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-test-1", turn: this.turns[0] },
    })}\n`));
  }

  kill() {}
}

test("session transport starts a thread and turn and reads the durable turn state", async () => {
  let process;
  const transport = new CodexSessionTransport({ spawnImpl: () => (process = new FakeCodexProcess()) });
  await transport.start();
  const started = await transport.startSession({ cwd: "/tmp/work", input: [{ type: "text", text: "hello" }] });
  assert.deepEqual({ threadId: started.threadId, turnId: started.turnId }, {
    threadId: "thread-test-1",
    turnId: "turn-test-1",
  });
  assert.equal((await transport.getTurnState(started.threadId, started.turnId)).status, "inProgress");
  process.complete("CODEX_TASKCTL_STATE: DONE");
  await new Promise(resolve => setImmediate(resolve));
  const completed = await transport.getTurnState(started.threadId, started.turnId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.response, "CODEX_TASKCTL_STATE: DONE");
  assert.equal(completed.source, "event");
  transport.close();
});

test("session transport exposes thread/read and times out without guessing completion", async () => {
  const transport = new CodexSessionTransport({ spawnImpl: () => new FakeCodexProcess(), requestTimeoutMs: 1000 });
  await transport.start();
  const { threadId, turnId } = await transport.startSession({ input: [] });
  const thread = await transport.readThread(threadId);
  assert.equal(thread.thread.id, threadId);
  assert.equal((await transport.readTurn(threadId, turnId)).status, "inProgress");
  const timedOut = await transport.waitForTurn(threadId, turnId, { timeoutMs: 1, pollMs: 1 });
  assert.equal(timedOut.status, "unknown");
  assert.equal(timedOut.source, "timeout");
  transport.close();
});

test("state helpers preserve the v2 dispatcher contract and support session updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codextaskctl-session-"));
  const file = path.join(dir, "dispatcher-state.json");
  try {
    const initial = emptyDispatcherState();
    initial.lists["执行中"] = 33;
    const entry = createSessionEntry({
      originalReminderId: 762,
      fingerprint: "fp",
      projectKey: "technical",
      projectId: "project-1",
    });
    initial.items["762"] = entry;
    await writeDispatcherState(file, initial);
    const loaded = await readDispatcherState(file);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.lists["执行中"], 33);
    assert.equal(loaded.items["762"].originalReminderId, 762);
    assert.equal(loaded.items["762"].attemptId, entry.attemptId);
    const store = new DispatcherStateStore(file);
    const updated = await store.upsert(762, current => updateSessionEntry(current, {
      threadId: "thread-test-1",
      turnId: "turn-test-1",
      status: "review",
      response: "needs review",
    }));
    assert.equal(updated.status, "review");
    assert.equal((await store.get(762)).threadId, "thread-test-1");
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 2);
    assert.equal(raw.items["762"].turnId, "turn-test-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalization keeps existing fields and maps missing IDs conservatively", () => {
  const state = normalizeDispatcherState({ version: 1, items: { "9": { reminderId: 9, status: "failed", custom: true } } });
  assert.equal(state.version, 2);
  assert.equal(state.items["9"].originalReminderId, 9);
  assert.equal(state.items["9"].status, "failed");
  assert.equal(state.items["9"].custom, true);
  assert.equal(normalizeDispatcherState({version: 1, items: {"9": {reminderId: 9}}}).items["9"].taskUid, state.items["9"].taskUid);
  assert.equal(sessionFingerprint({ a: 1 }), sessionFingerprint({ a: 1 }));
});

test("binding survives a Reminders move and numeric id remap", () => {
  const entry = createSessionEntry({originalReminderId: 7, reminderIdentity: "cloudkit-7", threadId: "thread-7"});
  const state = {items: {"7": entry}};
  const moved = bindReminder(entry, {id: 107, cloudKitId: "cloudkit-7"});
  state.items["7"] = moved;
  assert.equal(reminderIdentity({id: 107, cloudKitId: "cloudkit-7"}), "cloudkit-7");
  assert.equal(findSessionEntry(state, {id: 107, cloudKitId: "cloudkit-7"}).threadId, "thread-7");
  assert.deepEqual(moved.reminderIds.sort((a, b) => a - b), [7, 107]);
});

test("stable identity wins when Reminders reuses a numeric id", () => {
  const oldTask = createSessionEntry({originalReminderId: 7, reminderId: 7, reminderIdentity: "cloudkit-old", threadId: "old-thread"});
  const newTask = createSessionEntry({originalReminderId: 8, reminderId: 8, reminderIdentity: "cloudkit-new", threadId: "new-thread"});
  const found = findSessionEntry({items: {old: oldTask, new: newTask}}, {id: 7, cloudKitId: "cloudkit-new"});
  assert.equal(found.threadId, "new-thread");
});

test("a new App Server transport can reconcile a persisted binding after Codex process restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codextaskctl-restart-"));
  const stateFile = path.join(dir, "dispatcher-state.json");
  let firstProcess;
  const first = new CodexSessionTransport({spawnImpl: () => (firstProcess = new FakeCodexProcess())});
  await first.start();
  const started = await first.startSession({cwd: "/tmp/work", input: [{type: "text", text: "hello"}]});
  const persisted = emptyDispatcherState();
  persisted.items["7"] = createSessionEntry({originalReminderId: 7, reminderId: 7, taskUid: "task-restart", reminderIdentity: "cloudkit-7", threadId: started.threadId, turnId: started.turnId, status: "running"});
  await writeDispatcherState(stateFile, persisted);
  firstProcess.emit("exit", 0, null);
  first.close();

  let secondProcess;
  const second = new CodexSessionTransport({spawnImpl: () => (secondProcess = new FakeCodexProcess())});
  await second.start();
  const restored = await readDispatcherState(stateFile);
  assert.equal(restored.items["7"].taskUid, "task-restart");
  assert.equal(restored.items["7"].threadId, started.threadId);
  const snapshot = await second.readThread(started.threadId);
  assert.equal(snapshot.thread.id, started.threadId);
  assert.equal(started.threadId, "thread-test-1");
  assert.equal(started.turnId, "turn-test-1");
  second.close();
  assert.ok(firstProcess && secondProcess);
  await rm(dir, {recursive: true, force: true});
});
