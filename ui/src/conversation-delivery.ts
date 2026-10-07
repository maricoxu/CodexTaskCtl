import type {ContentBlock} from "@modelcontextprotocol/sdk/types.js";

export type DeliveryPhase = "preparing" | "waiting" | "accepted" | "rejected" | "unknown";
export type DeliveryState = {phase: DeliveryPhase; message: string};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Sender = (params: {role: "user"; content: ContentBlock[]; _meta: {"openai/message": {target: "active" | "new"; send: true}}}, options: {timeout: number; maxTotalTimeout: number}) => Promise<{isError?: boolean}>;

export const DELIVERY_TIMEOUT_MS = 10 * 60 * 1000;
const STORAGE_KEY = "remctl-conversation-delivery-v1";
const UNKNOWN_MESSAGE = "投递结果未确认。宿主可能仍在等待确认，或已经创建会话。请先检查 Codex，避免重复发送。";

export class ConversationDelivery {
  private state: DeliveryState | null = null;
  private listeners = new Set<(state: DeliveryState | null) => void>();
  constructor(private storage?: Storage) {
    // Reloading the view loses the original promise, not the fact that a send
    // may already have reached Codex. No payload is stored here.
    try { if (storage?.getItem(STORAGE_KEY)) this.state = {phase: "unknown", message: UNKNOWN_MESSAGE}; } catch {}
  }
  get current() { return this.state; }
  get locked() { return ["preparing", "waiting", "unknown"].includes(this.state?.phase || ""); }
  subscribe(listener: (state: DeliveryState | null) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private update(state: DeliveryState | null) {
    this.state = state;
    try { state?.phase === "waiting" || state?.phase === "unknown" ? this.storage?.setItem(STORAGE_KEY, "pending") : this.storage?.removeItem(STORAGE_KEY); } catch {}
    this.listeners.forEach(listener => listener(state));
  }
  acknowledge() {
    if (this.state?.phase === "preparing" || this.state?.phase === "waiting") return;
    this.update(null);
  }
  async start(intent: string, target: "active" | "new", prepare: () => Promise<ContentBlock[]>, send: Sender) {
    if (this.locked) return;
    this.update({phase: "preparing", message: "正在准备所选提醒的内容…"});
    let dispatched = false;
    try {
      const content = await prepare();
      this.update({phase: "waiting", message: "已请求发送，正在等待 Codex 接受。若宿主弹出内容确认窗口，请在该窗口处理。"});
      dispatched = true;
      // Keep the receipt. send:true requests immediate delivery but cannot
      // override the host's review of untrusted app input. Allow review time.
      const result = await send({role: "user", content: [{type: "text", text: intent}, ...content], _meta: {"openai/message": {target, send: true}}}, {timeout: DELIVERY_TIMEOUT_MS, maxTotalTimeout: DELIVERY_TIMEOUT_MS});
      this.update(result.isError ? {phase: "rejected", message: "Codex 拒绝了这次消息投递，请检查宿主提示后再发送。"} : {phase: "accepted", message: "Codex 已接受消息。请在会话中查看执行结果；提醒事项的完成状态未改变。"});
    } catch (error: unknown) {
      const code = (error as {code?: number})?.code;
      const message = error instanceof Error ? error.message : String(error);
      // A timeout/transport failure does not establish non-delivery.
      const rejected = !dispatched || code === -32601 || code === -32602;
      this.update(rejected ? {phase: "rejected", message: `未能发送：${message}`} : {phase: "unknown", message: `${UNKNOWN_MESSAGE}（${code === -32001 ? "等待宿主回执超时" : message}）`});
    }
  }
}
