import test from "node:test";
import assert from "node:assert/strict";
import {LISTS, applyReconciliationPlan, buildReconciliationPlan, normalizeState, reconcileOnce} from "../scripts/codextaskctl-reconciler.mjs";

const state = (items = {}) => normalizeState({version: 3, items});

test("only deferred captures become periodic candidates", () => {
  const result = buildReconciliationPlan({state: state(), reminders: [
    {id: 1, title: "收集中的事", list: LISTS.inbox, completed: false},
    {id: 2, title: "延后任务", list: LISTS.deferred, completed: false},
    {id: 3, title: "已归档", list: LISTS.deferred, completed: true},
  ]});
  assert.deepEqual(result.candidates.map(item => item.reminderId), [2]);
  assert.deepEqual(result.actions.map(item => item.type), ["candidate"]);
});

test("delivered writeback retries completion without moving lists", async () => {
  const initial = state({"7": {reminderId: 7, status: "delivered", completionWritebackPending: true, threadId: "thread-7"}});
  const plan = buildReconciliationPlan({state: initial, reminders: [{id: 7, title: "延后任务", list: LISTS.deferred, completed: false}]});
  const calls = [];
  const result = await applyReconciliationPlan({plan, state: initial, now: "2026-10-08T00:00:00Z", adapter: {async completeReminder(id) {calls.push(id);}}});
  assert.deepEqual(calls, [7]);
  assert.equal(result.state.items["7"].completionWritebackPending, false);
  assert.equal(result.results[0].type, "complete");
});

test("dry run never invokes the Reminders adapter", async () => {
  let called = false;
  const result = await reconcileOnce({state: state(), reminders: [{id: 2, list: LISTS.deferred, completed: false}], dryRun: true, adapter: {async completeReminder() {called = true;}}});
  assert.equal(result.plan.candidates.length, 1);
  assert.equal(called, false);
});

test("completion writeback errors stay visible and do not mutate the source list", async () => {
  const initial = state({"7": {reminderId: 7, status: "delivered", completionWritebackPending: true}});
  const plan = buildReconciliationPlan({state: initial, reminders: [{id: 7, list: LISTS.deferred, completed: false}]});
  const result = await applyReconciliationPlan({plan, state: initial, adapter: {async completeReminder() {throw new Error("temporary");}}});
  assert.equal(result.results[0].applied, false);
  assert.equal(result.state.items["7"].completionWritebackPending, true);
});
