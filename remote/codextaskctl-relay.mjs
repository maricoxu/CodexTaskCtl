#!/usr/bin/env node

/**
 * Small OAuth + MCP relay for CodexTaskCtl.
 *
 * It is intentionally dependency-free and uses an in-memory store for the
 * first local replay. A production deployment must replace RelayStore with a
 * durable, encrypted store and put this HTTP server behind HTTPS.
 */
import http from "node:http";
import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import {URL} from "node:url";

export const REMOTE_TOOLS = [
  {name:"get_task_context", title:"Task Context", description:"Read reminder lists and active reminders for planning.", inputSchema:{type:"object", properties:{query:{type:"string"}, list:{type:"string"}, limit:{type:"integer", minimum:1, maximum:200}}, additionalProperties:false}, annotations:{readOnlyHint:true, destructiveHint:false, idempotentHint:true}},
  {name:"preview_task_plan", title:"Preview Task Plan", description:"Validate proposed task operations, find exact duplicates, and return a confirmation token without writing.", inputSchema:{type:"object", required:["idempotency_key","operations"], properties:{idempotency_key:{type:"string", minLength:8}, operations:{type:"array", minItems:1, maxItems:50, items:{type:"object"}}, source_context:{type:"string"}}, additionalProperties:false}, annotations:{readOnlyHint:true, destructiveHint:false, idempotentHint:true}},
  {name:"apply_task_plan", title:"Apply Task Plan", description:"Apply a previewed plan after explicit confirmation.", inputSchema:{type:"object", required:["plan_id","confirmation_token","confirmed"], properties:{plan_id:{type:"string"}, confirmation_token:{type:"string"}, confirmed:{type:"boolean"}}, additionalProperties:false}, annotations:{readOnlyHint:false, destructiveHint:false, idempotentHint:true}},
  {name:"capture_reminder", title:"Capture Reminder", description:"Create one reminder in the selected list. Use this for quick conversational capture.", inputSchema:{type:"object", required:["title"], properties:{title:{type:"string", maxLength:1024}, notes:{type:"string", maxLength:16384}, list:{type:"string", maxLength:512}, due:{type:"string", maxLength:128}, priority:{type:"string", enum:["none","low","medium","high"]}}, additionalProperties:false}, annotations:{readOnlyHint:false, destructiveHint:false, idempotentHint:false}},
];

const TOOL_NAMES = new Set(REMOTE_TOOLS.map(tool => tool.name));
const b64u = value => Buffer.from(value).toString("base64url");
const sha256 = value => createHash("sha256").update(value).digest("base64url");
const randomId = prefix => `${prefix}_${randomBytes(18).toString("hex")}`;
const nowMs = () => Date.now();

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {"content-type":"application/json; charset=utf-8", "cache-control":"no-store", "content-length":Buffer.byteLength(body), ...headers});
  res.end(body);
}
function html(res, status, value) {
  res.writeHead(status, {"content-type":"text/html; charset=utf-8", "cache-control":"no-store"});
  res.end(value);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {body += chunk; if (body.length > 4 * 1024 * 1024) reject(new Error("body too large"));});
    req.on("end", () => {
      if (!body) return resolve({});
      try {resolve(req.headers["content-type"]?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body));}
      catch (error) {reject(error);}
    });
    req.on("error", reject);
  });
}
function bearer(req) { const value = String(req.headers.authorization || ""); return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : ""; }
function safeEqual(a, b) { const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b)); return aa.length === bb.length && timingSafeEqual(aa, bb); }

export class RelayStore {
  constructor({issuer="http://127.0.0.1:8787", clock=nowMs, approvalCode=null} = {}) {
    this.issuer = issuer.replace(/\/$/, "");
    this.clock = clock;
    this.approvalCode = approvalCode || randomBytes(6).toString("hex").toUpperCase();
    this.clients = new Map(); this.authRequests = new Map(); this.authCodes = new Map();
    this.accessTokens = new Map(); this.refreshTokens = new Map(); this.agentTokens = new Map();
    this.jobs = new Map(); this.queues = new Map(); this.results = new Map();
    this.plans = new Map(); this.idempotency = new Map();
  }
  metadata() { return {issuer:this.issuer, authorization_endpoint:`${this.issuer}/oauth/authorize`, token_endpoint:`${this.issuer}/oauth/token`, registration_endpoint:`${this.issuer}/oauth/register`, code_challenge_methods_supported:["S256"], grant_types_supported:["authorization_code","refresh_token"]}; }
  registerClient({redirect_uris, client_name="ChatGPT"} = {}) {
    if (!Array.isArray(redirect_uris) || !redirect_uris.length) throw new Error("redirect_uris is required");
    const client_id = randomId("client"); this.clients.set(client_id, {client_id, redirect_uris, client_name});
    return {client_id, client_name, redirect_uris, token_endpoint_auth_method:"none", grant_types:["authorization_code","refresh_token"], response_types:["code"]};
  }
  beginAuthorize(params) {
    const client = this.clients.get(params.client_id);
    if (!client || !client.redirect_uris.includes(params.redirect_uri)) throw new Error("invalid client or redirect_uri");
    if (!params.code_challenge || params.code_challenge_method !== "S256") throw new Error("S256 PKCE is required");
    const request_id = randomId("auth");
    this.authRequests.set(request_id, {...params, request_id, expires_at:this.clock() + 10 * 60 * 1000});
    return this.authRequests.get(request_id);
  }
  approveAuthorize(request_id, approval_code) {
    const request = this.authRequests.get(request_id);
    if (!request || request.expires_at < this.clock()) throw new Error("authorization request expired");
    if (!safeEqual(approval_code, this.approvalCode)) throw new Error("invalid approval code");
    const code = randomId("code"); this.authCodes.set(code, {...request, expires_at:this.clock() + 60 * 1000}); this.authRequests.delete(request_id);
    const redirect = new URL(request.redirect_uri); redirect.searchParams.set("code", code); if (request.state) redirect.searchParams.set("state", request.state);
    return redirect.toString();
  }
  exchangeToken({grant_type, code, redirect_uri, client_id, code_verifier, refresh_token}) {
    if (grant_type === "authorization_code") {
      const record = this.authCodes.get(code); if (!record || record.expires_at < this.clock()) throw new Error("invalid authorization code");
      if (record.client_id !== client_id || record.redirect_uri !== redirect_uri || sha256(code_verifier || "") !== record.code_challenge) throw new Error("PKCE verification failed");
      this.authCodes.delete(code); return this.issueTokens(record.client_id);
    }
    if (grant_type === "refresh_token") {
      const record = this.refreshTokens.get(refresh_token); if (!record || record.expires_at < this.clock()) throw new Error("invalid refresh token");
      if (record.client_id !== client_id) throw new Error("refresh token client mismatch");
      this.refreshTokens.delete(refresh_token); return this.issueTokens(client_id);
    }
    throw new Error("unsupported grant_type");
  }
  issueTokens(client_id) {
    const access_token = randomId("at"); const refresh_token = randomId("rt");
    this.accessTokens.set(access_token, {client_id, expires_at:this.clock() + 60 * 60 * 1000});
    this.refreshTokens.set(refresh_token, {client_id, expires_at:this.clock() + 90 * 24 * 60 * 60 * 1000});
    return {access_token, token_type:"Bearer", expires_in:3600, refresh_token};
  }
  authenticateAccess(token) { const record = this.accessTokens.get(token); if (!record || record.expires_at < this.clock()) return null; return record.client_id; }
  pairAgent(approval_code) { if (!safeEqual(approval_code, this.approvalCode)) throw new Error("invalid pairing code"); const token = randomId("agent"); this.agentTokens.set(token, {user_id:"primary", expires_at:this.clock() + 365 * 24 * 60 * 60 * 1000}); return {agent_token:token, user_id:"primary"}; }
  authenticateAgent(token) { const record = this.agentTokens.get(token); return record && record.expires_at >= this.clock() ? record.user_id : null; }
  enqueue(user_id, tool, args) { const job_id = randomId("job"); const job = {job_id, user_id, tool, args, created_at:this.clock(), expires_at:this.clock() + 60 * 1000}; this.jobs.set(job_id, job); if (!this.queues.has(user_id)) this.queues.set(user_id, []); this.queues.get(user_id).push(job_id); return job; }
  poll(user_id) { const queue = this.queues.get(user_id) || []; while (queue.length) { const id = queue.shift(); const job = this.jobs.get(id); if (job && job.expires_at >= this.clock()) return job; } return null; }
  putResult(user_id, job_id, result) { const job = this.jobs.get(job_id); if (!job || job.user_id !== user_id) throw new Error("job not found"); this.results.set(job_id, {result, expires_at:this.clock() + 60 * 1000}); }
  takeResult(job_id) { const item = this.results.get(job_id); if (!item || item.expires_at < this.clock()) return null; return item.result; }
  savePlan(plan) { this.plans.set(plan.plan_id, plan); this.idempotency.set(plan.idempotency_key, plan); }
  getPlan(plan_id) { return this.plans.get(plan_id); }
  getIdempotent(key) { return this.idempotency.get(key); }
}

function authorizePage(request_id, params) {
  return `<!doctype html><meta charset="utf-8"><title>CodexTaskCtl 授权</title><h1>允许 ChatGPT 访问 CodexTaskCtl？</h1><p>首次连接需要输入一次本机配对码。之后使用刷新令牌，不需要重复输入。</p><form method="post" action="/oauth/authorize/approve"><input type="hidden" name="request_id" value="${request_id}"><input type="text" name="approval_code" autocomplete="one-time-code" placeholder="配对码" required><button>允许访问</button></form>`;
}

function mcpError(id, code, message) { return {jsonrpc:"2.0", id, error:{code, message}}; }
function normalizeOperation(value) {
  if (!value || typeof value !== "object" || !["create","update"].includes(value.action)) throw new Error("operation.action must be create or update");
  if (value.action === "create" && (!value.title || typeof value.title !== "string")) throw new Error("create.title is required");
  if (value.action === "update" && (!Number.isSafeInteger(value.reminder_id) || value.reminder_id < 1)) throw new Error("update.reminder_id is required");
  return JSON.parse(JSON.stringify(value));
}

async function waitForResult(store, job_id, timeoutMs=50_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = store.takeResult(job_id); if (result !== null) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Mac Agent did not return a result before the timeout");
}

async function handleMcp(store, client_id, message) {
  const id = message.id ?? null; const method = message.method; const params = message.params || {};
  if (method === "initialize") return {jsonrpc:"2.0", id, result:{protocolVersion:"2025-11-25", capabilities:{tools:{listChanged:false}}, serverInfo:{name:"CodexTaskCtl Remote", version:"0.1.0"}}};
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") return {jsonrpc:"2.0", id, result:{tools:REMOTE_TOOLS}};
  if (method !== "tools/call") return mcpError(id, -32601, "Method not found");
  const name = params.name; const args = params.arguments || {};
  if (!TOOL_NAMES.has(name)) return mcpError(id, -32602, `Unknown tool: ${name}`);
  if (name === "apply_task_plan") {
    if (args.confirmed !== true) return mcpError(id, -32602, "confirmed=true is required");
    const plan = store.getPlan(args.plan_id); if (!plan || plan.confirmation_token !== args.confirmation_token || plan.expires_at < Date.now()) return mcpError(id, -32602, "Invalid or expired plan confirmation");
    if (plan.status === "applied") return {jsonrpc:"2.0", id, result:{content:[{type:"text",text:JSON.stringify({status:"already_applied", result:plan.result})}], structuredContent:{status:"already_applied", result:plan.result}}};
    const job = store.enqueue("primary", name, {operations:plan.operations}); const result = await waitForResult(store, job.job_id); plan.status = result.status; plan.result = result;
    return {jsonrpc:"2.0", id, result:{content:[{type:"text",text:JSON.stringify(result)}], structuredContent:result}};
  }
  if (name === "preview_task_plan") {
    if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 50) return mcpError(id, -32602, "operations must contain 1-50 items");
    const operations = args.operations.map(normalizeOperation); const existing = store.getIdempotent(args.idempotency_key); if (existing) return {jsonrpc:"2.0", id, result:{content:[{type:"text",text:JSON.stringify(existing.preview)}], structuredContent:existing.preview}};
    const plan = {plan_id:randomId("plan"), idempotency_key:args.idempotency_key, operations, confirmation_token:randomId("confirm"), expires_at:Date.now()+10*60*1000, status:"awaiting_confirmation"};
    const job = store.enqueue("primary", name, {operations}); const preview = await waitForResult(store, job.job_id); const payload = {...preview, plan_id:plan.plan_id, confirmation_token:plan.confirmation_token, expires_at:plan.expires_at, requires_confirmation:true}; plan.preview = payload; store.savePlan(plan);
    return {jsonrpc:"2.0", id, result:{content:[{type:"text",text:JSON.stringify(payload)}], structuredContent:payload}};
  }
  const job = store.enqueue("primary", name, args); const result = await waitForResult(store, job.job_id);
  return {jsonrpc:"2.0", id, result:{content:[{type:"text",text:JSON.stringify(result)}], structuredContent:result}};
}

export function createRelayServer({store=new RelayStore()} = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", store.issuer);
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, {ok:true, name:"CodexTaskCtl Relay"});
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return json(res, 200, store.metadata());
      if (req.method === "POST" && url.pathname === "/oauth/register") return json(res, 201, store.registerClient(await readBody(req)));
      if (req.method === "GET" && url.pathname === "/oauth/authorize") { const request = store.beginAuthorize(Object.fromEntries(url.searchParams)); return html(res, 200, authorizePage(request.request_id, request)); }
      if (req.method === "POST" && url.pathname === "/oauth/authorize/approve") { const body = await readBody(req); const redirect = store.approveAuthorize(body.request_id, body.approval_code); res.writeHead(302, {location:redirect}); return res.end(); }
      if (req.method === "POST" && url.pathname === "/oauth/token") return json(res, 200, store.exchangeToken(await readBody(req)));
      if (req.method === "POST" && url.pathname === "/agent/pair") return json(res, 200, store.pairAgent((await readBody(req)).pairing_code));
      const agentUser = store.authenticateAgent(bearer(req));
      if (agentUser && req.method === "POST" && url.pathname === "/agent/poll") return json(res, 200, {job:store.poll(agentUser)});
      if (agentUser && req.method === "POST" && url.pathname === "/agent/result") { const body = await readBody(req); store.putResult(agentUser, body.job_id, body.result); return json(res, 202, {ok:true}); }
      const clientId = store.authenticateAccess(bearer(req));
      if (clientId && req.method === "POST" && url.pathname === "/mcp") { const response = await handleMcp(store, clientId, await readBody(req)); if (response === null) return res.writeHead(202).end(); return json(res, 200, response); }
      return json(res, 404, {error:"not_found"});
    } catch (error) { return json(res, 400, {error:error.message || String(error)}); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CODEX_TASKCTL_RELAY_PORT || 8787); const store = new RelayStore({issuer:`http://127.0.0.1:${port}`});
  console.error(`CodexTaskCtl relay pairing code: ${store.approvalCode}`); createRelayServer({store}).listen(port, "127.0.0.1", () => console.error(`CodexTaskCtl relay listening on http://127.0.0.1:${port}`));
}
