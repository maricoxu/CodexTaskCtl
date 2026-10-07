#!/usr/bin/env node

import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);
const remctl = process.env.REMCTL_PATH || `${process.env.HOME}/bin/remctl`;

async function request(server, token, path, body) {
  const response = await fetch(`${server.replace(/\/$/, "")}${path}`, {method:"POST", headers:{authorization:`Bearer ${token}`, "content-type":"application/json"}, body:JSON.stringify(body)});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `relay ${response.status}`); return data;
}
async function runRemctl(args) {
  const {stdout} = await execFileAsync(remctl, args, {maxBuffer:4*1024*1024}); return JSON.parse(stdout);
}
function parseOperations(operations) { if (!Array.isArray(operations) || !operations.length || operations.length > 50) throw new Error("operations must contain 1-50 items"); return operations; }
async function getContext(args) {
  const lists = await runRemctl(["lists", "--json"]);
  const search = ["search", "--limit", String(Math.min(Number(args.limit || 50), 200)), "--offset", "0"];
  if (args.list) search.push("--list", String(args.list)); else if (args.list_id) search.push("--list-id", String(args.list_id));
  if (args.include_completed) search.push("--completed"); search.push("--json", "--", String(args.query || ""));
  const items = await runRemctl(search); return {lists:lists.items || [], items:items.items || [], total:items.total ?? items.count ?? 0, readOnly:true};
}
async function preview(args) {
  const operations = parseOperations(args.operations); const duplicates = [];
  for (const operation of operations.filter(item => item.action === "create")) {
    const result = await runRemctl(["search", "--limit", "50", "--offset", "0", "--json", "--", operation.title]);
    const matches = (result.items || []).filter(item => String(item.title || item.name || "").trim().toLocaleLowerCase() === String(operation.title).trim().toLocaleLowerCase());
    if (matches.length) duplicates.push({operation_id:operation.operation_id || operation.title, matches});
  }
  return {duplicates, operations, readOnly:true};
}
function argvForOperation(operation) {
  const args = [operation.action === "create" ? "add" : "edit"];
  if (operation.action === "update") args.push(String(operation.reminder_id));
  if (operation.list_id) args.push("--list-id", String(operation.list_id)); else if (operation.list) args.push("--list", String(operation.list));
  for (const [field, option] of [["title","--title"],["notes","--notes"],["due","--due"],["priority","--priority"],["url","--url"]]) if (operation[field] !== undefined && !(field === "title" && operation.action === "create")) args.push(option, String(operation[field]));
  if (operation.subtasks?.length) {args.push("--private"); for (const item of operation.subtasks) args.push("--subtask", String(item));}
  args.push("--json"); if (operation.action === "create") args.push("--", String(operation.title)); return args;
}
async function applyPlan(args) {
  const results = [];
  for (const operation of parseOperations(args.operations)) {
    try { results.push({operation_id:operation.operation_id || operation.title || String(operation.reminder_id), status:"applied", result:await runRemctl(argvForOperation(operation))}); }
    catch (error) { results.push({operation_id:operation.operation_id || operation.title || String(operation.reminder_id), status:"failed", error:String(error.message || error)}); break; }
  }
  return {status:results.length === args.operations.length && results.every(item => item.status === "applied") ? "applied" : "partial", results};
}
export async function executeJob(job) {
  if (job.tool === "get_task_context") return getContext(job.args || {});
  if (job.tool === "preview_task_plan") return preview(job.args || {});
  if (job.tool === "apply_task_plan") return applyPlan(job.args || {});
  if (job.tool === "capture_reminder") {
    const args = job.args || {}; const argv = ["add", "--json"];
    if (args.list) argv.push("--list", String(args.list)); if (args.due) argv.push("--due", String(args.due)); if (args.priority) argv.push("--priority", String(args.priority)); if (args.notes) argv.push("--notes", String(args.notes)); argv.push("--", String(args.title));
    return runRemctl(argv);
  }
  throw new Error(`Unsupported remote tool: ${job.tool}`);
}
export async function pollOnce(server, token) {
  const response = await request(server, token, "/agent/poll", {}); if (!response.job) return null;
  try { const result = await executeJob(response.job); await request(server, token, "/agent/result", {job_id:response.job.job_id, result}); }
  catch (error) { await request(server, token, "/agent/result", {job_id:response.job.job_id, result:{status:"failed", error:String(error.message || error)}}); }
  return response.job.job_id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = process.env.CODEX_TASKCTL_RELAY_URL; const token = process.env.CODEX_TASKCTL_AGENT_TOKEN;
  if (!server || !token) throw new Error("Set CODEX_TASKCTL_RELAY_URL and CODEX_TASKCTL_AGENT_TOKEN");
  const once = process.argv.includes("--once");
  do { await pollOnce(server, token); if (!once) await new Promise(resolve => setTimeout(resolve, 1000)); } while (!once);
}
