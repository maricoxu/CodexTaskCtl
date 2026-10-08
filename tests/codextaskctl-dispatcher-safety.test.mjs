import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLock, CodexAppServer, findEntry, parseArgs, runFingerprint, scan, startCandidate } from '../scripts/codextaskctl-dispatcher.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codextaskctl-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reminder = { id: 1, deepLink: 'reminder://stable-one', title: 'Codex Test', notes: '', list: '延后交给 Codex', completed: false };
  const state = { version: 3, lists: {}, items: {}, meta: {} };
  const options = parseArgs(['--once', '--state', path.join(dir, 'state.json'), '--workspace', dir, '--list', '延后交给 Codex']);
  const calls = [];
  let completeFailure = false;
  options.remctlCall = async args => {
    calls.push(args);
    if (args[0] === 'info') return { ...reminder };
    if (args[0] === 'show') return { items: [{ ...reminder }] };
    if (args[0] === 'done') {
      if (completeFailure) throw new Error('completion write failed');
      reminder.completed = true;
      return { id: reminder.id, completed: true };
    }
    if (args[0] === 'lists') return { items: [] };
    if (args[0] === 'edit') throw new Error('Reminders must not be moved by the delivery dispatcher');
    throw new Error(`Unexpected mutation: ${args}`);
  };
  const saved = () => readFile(options.state, 'utf8').then(JSON.parse);
  const server = {
    sends: 0,
    takeCompleted: () => null,
    readThread: async () => ({ thread: { turns: [{ id: 'turn-one', status: 'inProgress' }] } }),
    startTurn: async (_cwd, _input, opts) => {
      server.sends++;
      assert.equal(_cwd, options.workspace);
      assert.equal((await saved()).items['1'].status, 'dispatching');
      await opts.onThreadStarted('thread-one');
      assert.equal((await saved()).items['1'].threadId, 'thread-one');
      return { threadId: 'thread-one', turnId: 'turn-one' };
    },
  };
  return {dir, options, state, reminder, calls, server, saved, setCompleteFailure: value => {completeFailure = value;}};
}

test('delivery marks the reminder completed and never moves it to execution lists', async t => {
  const f = await fixture(t);
  const result = await startCandidate(f.options, f.server, f.state, f.reminder);
  assert.equal(result.status, 'delivered');
  assert.equal(f.reminder.completed, true);
  assert.equal(f.state.items['1'].status, 'delivered');
  assert.equal(f.calls.some(args => args[0] === 'edit'), false);
});

test('completion writeback failure retains delivered claim and does not redispatch', async t => {
  const f = await fixture(t); f.setCompleteFailure(true);
  const first = await startCandidate(f.options, f.server, f.state, f.reminder);
  assert.equal(first.status, 'delivered');
  assert.equal(f.state.items['1'].completionWritebackPending, true);
  const saved = await f.saved();
  const second = await startCandidate(f.options, f.server, saved, f.reminder);
  assert.equal(second.status, 'skipped');
  assert.equal(f.server.sends, 1);
});

test('immediate delivery is recorded separately from deferred delivery', async t => {
  const f = await fixture(t);
  const result = await startCandidate({...f.options, dispatchTrigger: 'immediate'}, f.server, f.state, f.reminder);
  assert.equal(result.status, 'delivered');
  assert.equal(f.state.items['1'].trigger, 'immediate');
  assert.equal(f.state.items['1'].attempts[0].trigger, 'immediate');
});

test('turn/start uncertainty keeps the reminder uncompleted and preserves thread binding', async t => {
  const f = await fixture(t);
  f.server.startTurn = async (_c, _i, opts) => { f.server.sends++; await opts.onThreadStarted('accepted-thread'); throw new Error('turn/start timed out'); };
  assert.equal((await startCandidate(f.options, f.server, f.state, f.reminder)).status, 'unknown');
  assert.equal(f.reminder.completed, false);
  const restarted = await f.saved();
  assert.equal(restarted.items['1'].threadId, 'accepted-thread');
  assert.equal((await startCandidate(f.options, f.server, restarted, f.reminder)).status, 'skipped');
  assert.equal(f.server.sends, 1);
});

test('fingerprint ignores reminder list and numeric id changes', () => {
  assert.equal(runFingerprint({id: 1, title: 'same', list: '收集箱'}), runFingerprint({id: 9, title: 'same', list: '延后交给 Codex'}));
});

test('stable identity wins over a reused numeric ID', async t => {
  const f = await fixture(t);
  f.state.items.old = {originalReminderId: 7, reminderId: 7, reminderIdentity: 'cloudkit-old', threadId: 'old-thread', status: 'delivered'};
  f.state.items.new = {originalReminderId: 8, reminderId: 8, reminderIdentity: 'cloudkit-new', threadId: 'new-thread', status: 'delivered'};
  assert.equal(findEntry(f.state, {id: 7, cloudKitId: 'cloudkit-new'}).threadId, 'new-thread');
});

test('periodic scan ignores ordinary inbox captures and dispatches deferred captures', async t => {
  const f = await fixture(t);
  f.options.remctlCall = async args => {
    if (args[0] === 'show') return {items: [{...f.reminder, list: '延后交给 Codex'}, {id: 2, title: '普通收集', list: '收集箱', completed: false}]};
    if (args[0] === 'info') return {...f.reminder};
    if (args[0] === 'done') {f.reminder.completed = true; return {id: 1, completed: true};}
    throw new Error(`Unexpected ${args}`);
  };
  const result = await scan(f.options, f.server, f.state);
  assert.equal(result.delivered, 1);
  assert.equal(f.server.sends, 1);
});

test('periodic scan accepts RemCTL show JSON arrays from the real CLI', async t => {
  const f = await fixture(t);
  f.options.remctlCall = async args => {
    if (args[0] === 'show') return [{...f.reminder}];
    if (args[0] === 'info') return {...f.reminder};
    if (args[0] === 'done') { f.reminder.completed = true; return {id: 1, completed: true}; }
    throw new Error(`Unexpected ${args}`);
  };
  const result = await scan(f.options, f.server, f.state);
  assert.equal(result.delivered, 1);
  assert.equal(f.reminder.completed, true);
});

test('a dry scan never writes state or completes reminders', async t => {
  const f = await fixture(t); f.options.dryRun = true;
  await scan(f.options, null, f.state);
  assert.equal(f.reminder.completed, false);
  await assert.rejects(readFile(f.options.state), {code: 'ENOENT'});
});

test('single-writer lock rejects a second process and recovers an exited owner', async t => {
  const f = await fixture(t); const lock = path.join(f.dir, 'dispatcher.lock');
  const moduleURL = new URL('../scripts/codextaskctl-dispatcher.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(moduleURL)}; await acquireLock(${JSON.stringify(lock)}); console.log('ready'); setInterval(()=>{},1000);`], {stdio: ['ignore','pipe','pipe']});
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  await assert.rejects(acquireLock(lock), /already running/);
  child.kill(); await once(child, 'exit');
  const release = await acquireLock(lock); await release();
  await assert.rejects(readFile(lock), {code: 'ENOENT'});
});

test('thread binding is persisted before turn/start', async t => {
  const f = await fixture(t);
  f.server.startTurn = async (_c, _i, opts) => { await opts.onThreadStarted('thread-before-turn'); assert.equal((await f.saved()).items['1'].threadId, 'thread-before-turn'); throw new Error('uncertain'); };
  await startCandidate(f.options, f.server, f.state, f.reminder);
  assert.equal((await f.saved()).items['1'].threadId, 'thread-before-turn');
});

test('dispatcher protocol keeps user input separate from developer instructions', async () => {
  const server = new CodexAppServer('unused'); const calls = [];
  server.request = async (method, params) => { calls.push({method, params}); return method === 'thread/start' ? {thread: {id: 'thread'}} : {turn: {id: 'turn'}}; };
  const input = [{type: 'text', text: '任务标题：\n任务正文'}];
  await server.startTurn('/tmp/work', input, {sandbox: 'read-only', approvalPolicy: 'never'});
  assert.doesNotMatch(calls[0].params.developerInstructions, /CODEX_TASKCTL_STATE/);
  assert.match(calls[0].params.developerInstructions, /只执行用户消息中的任务内容/);
  assert.deepEqual(calls[1].params.input, input);
});
