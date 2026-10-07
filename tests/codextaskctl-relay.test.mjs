import test from "node:test";
import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {RelayStore, createRelayServer} from "../remote/codextaskctl-relay.mjs";

const b64u = value => Buffer.from(value).toString("base64url");

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("OAuth authorization code and refresh token are one-time and PKCE protected", async () => {
  const store = new RelayStore({issuer:"http://relay.test", approvalCode:"PAIR-123"});
  const client = store.registerClient({redirect_uris:["https://chatgpt.test/callback"]});
  const verifier = b64u(randomBytes(32));
  const request = store.beginAuthorize({client_id:client.client_id, redirect_uri:client.redirect_uris[0], code_challenge:b64u(createHash("sha256").update(verifier).digest()), code_challenge_method:"S256", state:"s"});
  const redirect = store.approveAuthorize(request.request_id, "PAIR-123");
  const code = new URL(redirect).searchParams.get("code");
  const tokens = store.exchangeToken({grant_type:"authorization_code", code, redirect_uri:client.redirect_uris[0], client_id:client.client_id, code_verifier:verifier});
  assert.ok(tokens.access_token); assert.ok(tokens.refresh_token); assert.equal(store.authenticateAccess(tokens.access_token), client.client_id);
  assert.throws(() => store.exchangeToken({grant_type:"authorization_code", code, redirect_uri:client.redirect_uris[0], client_id:client.client_id, code_verifier:verifier}), /invalid authorization code/);
  const refreshed = store.exchangeToken({grant_type:"refresh_token", refresh_token:tokens.refresh_token, client_id:client.client_id});
  assert.ok(refreshed.access_token); assert.notEqual(refreshed.access_token, tokens.access_token);
});

test("remote MCP tool call is queued to the paired Mac agent", async () => {
  const store = new RelayStore({approvalCode:"PAIR-456"});
  const client = store.registerClient({redirect_uris:["https://chatgpt.test/callback"]});
  const verifier = b64u(randomBytes(32));
  const request = store.beginAuthorize({client_id:client.client_id, redirect_uri:client.redirect_uris[0], code_challenge:b64u(createHash("sha256").update(verifier).digest()), code_challenge_method:"S256"});
  const code = new URL(store.approveAuthorize(request.request_id, "PAIR-456")).searchParams.get("code");
  const tokens = store.exchangeToken({grant_type:"authorization_code", code, redirect_uri:client.redirect_uris[0], client_id:client.client_id, code_verifier:verifier});
  const agent = store.pairAgent("PAIR-456");
  const server = createRelayServer({store}); const base = await listen(server);
  try {
    const call = fetch(`${base}/mcp`, {method:"POST", headers:{authorization:`Bearer ${tokens.access_token}`, "content-type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0", id:1, method:"tools/call", params:{name:"capture_reminder", arguments:{title:"Relay test"}}})});
    let job;
    for (let i=0;i<20 && !job;i++) { job = store.poll("primary"); if (!job) await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(job.tool, "capture_reminder"); assert.equal(job.args.title, "Relay test");
    store.putResult(agent.user_id, job.job_id, {status:"created", id:42});
    const response = await (await call).json();
    assert.equal(response.result.structuredContent.id, 42);
  } finally { server.close(); }
});

test("relay exposes task plan preview and confirmation token", async () => {
  const store = new RelayStore({approvalCode:"PAIR-789"}); const client = store.registerClient({redirect_uris:["https://chatgpt.test/callback"]});
  const verifier = b64u(randomBytes(32)); const request = store.beginAuthorize({client_id:client.client_id, redirect_uri:client.redirect_uris[0], code_challenge:b64u(createHash("sha256").update(verifier).digest()), code_challenge_method:"S256"});
  const code = new URL(store.approveAuthorize(request.request_id, "PAIR-789")).searchParams.get("code");
  const tokens = store.exchangeToken({grant_type:"authorization_code", code, redirect_uri:client.redirect_uris[0], client_id:client.client_id, code_verifier:verifier}); store.pairAgent("PAIR-789");
  const server = createRelayServer({store}); const base = await listen(server);
  try {
    const call = fetch(`${base}/mcp`, {method:"POST", headers:{authorization:`Bearer ${tokens.access_token}`, "content-type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0", id:2, method:"tools/call", params:{name:"preview_task_plan", arguments:{idempotency_key:"relay-plan-1", operations:[{action:"create", title:"Plan item"}]}}})});
    let job; for (let i=0;i<20 && !job;i++) {job=store.poll("primary"); if(!job) await new Promise(resolve=>setTimeout(resolve,5));}
    store.putResult("primary", job.job_id, {duplicates:[], readOnly:true}); const response=await (await call).json();
    assert.equal(response.result.structuredContent.requires_confirmation, true); assert.ok(response.result.structuredContent.confirmation_token);
  } finally { server.close(); }
});
