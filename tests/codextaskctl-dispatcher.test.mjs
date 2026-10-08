import test from "node:test";
import assert from "node:assert/strict";
import { classifyReminder, inputFor, isCandidate, normalizeStateBindings, parseArgs, promptFor, readStatus, runFingerprint, stableTaskUid, taskContentFor } from "../scripts/codextaskctl-dispatcher.mjs";

test("dispatcher selects only explicit codex reminders", () => {
  const options = parseArgs(["--once", "--keyword", "Codex", "--list-id", "2"]);
  assert.equal(isCandidate({id: 1, title: "Codex Read this", notes: "", completed: false}, options), true);
  assert.equal(isCandidate({id: 2, title: "ordinary", notes: "Codex in notes", completed: false}, options), false);
  assert.equal(isCandidate({id: 5, title: "Codex 做这件事", notes: "", completed: false}, options), true);
  assert.equal(isCandidate({id: 6, title: "Codex确认邮箱地址", notes: "", completed: false}, options), false);
  assert.equal(isCandidate({id: 3, title: "Codex done", notes: "", completed: true}, options), false);
  assert.equal(isCandidate({id: 4, title: "Codex child", notes: "", completed: false, isSubtask: true}, options), false);
});

test("ordinary reminders are never candidates for periodic dispatch", () => {
  const options = parseArgs(["--once", "--keyword", "Codex", "--list-id", "2"]);
  for (const title of ["查看微信公众号现在发布的文章状态", "买牛奶", "整理项目周报", "OpenAI 发布会摘要"]) {
    assert.equal(isCandidate({id: 100, title, notes: "", completed: false}, options), false, title);
  }
});

test("Codex titles enter dispatch and classify a WeChat task as writing", () => {
  const options = parseArgs(["--once", "--keyword", "Codex", "--list-id", "2"]);
  const reminder = {id: 101, title: "Codex 查看一下微信公众号现在发布的文章状态", notes: "列出已发布、草稿和失败项", completed: false};
  assert.equal(isCandidate(reminder, options), true);
  assert.equal(classifyReminder(reminder).key, "writing");
  assert.equal(promptFor(reminder), "Codex 查看一下微信公众号现在发布的文章状态：\n列出已发布、草稿和失败项");
});

test("dispatcher prompt contains only reminder content", () => {
  const reminder = {id: 7, title: "[codex] MVP", list: "收集箱", notes: "只回答 OK"};
  const prompt = promptFor(reminder);
  assert.equal(prompt, "[codex] MVP：\n只回答 OK");
  assert.doesNotMatch(prompt, /你是|目标项目|projectId|提醒清单|CODEX_TASKCTL_STATE/);
  assert.equal(taskContentFor(reminder), "[codex] MVP：\n只回答 OK");
  assert.equal(taskContentFor({title: "只执行标题", notes: ""}), "只执行标题");
  assert.equal(taskContentFor({title: "", notes: "只有正文"}), "只有正文");
  assert.equal(taskContentFor({title: "", notes: ""}), "（无内容）");
  assert.equal(runFingerprint(reminder), runFingerprint({...reminder}));
  assert.notEqual(runFingerprint(reminder), runFingerprint({...reminder, notes: "changed"}));
});

test("dispatcher defaults to deferred delivery with safe read-only execution", () => {
  const options = parseArgs(["--once"]);
  assert.equal(options.once, true);
  assert.equal(options.sandbox, "read-only");
  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.retryFailed, false);
  assert.equal(options.keyword, "");
  assert.equal(options.list, "延后交给 Codex");
  assert.equal(options.intervalMs, 600000);
  assert.equal(parseArgs(["--status"]).status, true);
  assert.equal(parseArgs(["--queue-immediate", "42"]).queueImmediateId, 42);
});

test("dispatcher status summarizes persisted state without requiring Codex", async () => {
  const statePath = `/tmp/codextaskctl-status-${process.pid}.json`;
  const options = parseArgs(["--status", "--state", statePath]);
  await import("node:fs/promises").then(fs => fs.writeFile(statePath, JSON.stringify({version: 3, meta: {state: "idle"}, items: {"1": {status: "review"}}, lists: {}})));
  const status = await readStatus(options);
  assert.equal(status.version, 3);
  assert.deepEqual(status.counts, {review: 1});
  await import("node:fs/promises").then(fs => fs.unlink(statePath));
});

test("legacy bindings receive deterministic task UIDs during migration", () => {
  const state = {items: {"757": {originalReminderId: 757, reminderIdentity: "cloudkit-757"}, "762": {originalReminderId: 762}}};
  normalizeStateBindings(state);
  assert.equal(state.items["757"].taskUid, stableTaskUid({reminderIdentity: "cloudkit-757"}));
  assert.equal(state.items["762"].taskUid, stableTaskUid({originalReminderId: 762}));
  assert.equal(normalizeStateBindings(state).items["757"].taskUid, state.items["757"].taskUid);
});

test("dispatcher classifies task routing", () => {
  assert.equal(classifyReminder({title: "Codex 写公众号文章", notes: ""}).key, "writing");
  assert.equal(classifyReminder({title: "Codex 调试 CUDA 算子", notes: ""}).key, "technical");
  assert.equal(classifyReminder({title: "Codex 处理一件杂事", notes: ""}).key, "fallback");
});

test("dispatcher forwards resolved reminder images as local Codex inputs", () => {
  const inputs = inputFor({title: "Codex image", notes: "inspect", attachments: [{path: "/tmp/input.png", resolved: true}]}, {label: "yehua的笔记", projectId: "local"});
  assert.equal(inputs[0].type, "text");
  assert.deepEqual(inputs[1], {type: "localImage", path: "/tmp/input.png", detail: "high"});
});
