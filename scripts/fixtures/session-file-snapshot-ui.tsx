import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatWindow } from "../../components/ChatWindow";
import { createFileChangeSnapshot } from "../../lib/file-change-snapshot";
import type { SessionInfo } from "../../lib/types";

const files = ["/fixture/project/new.ts", "/fixture/project/edited.ts", "/tmp/external/deleted.md"];
const snapshotA = createFileChangeSnapshot("a-turn-1", files, files.map((filePath, i) => ({ filePath, beforeExists: i !== 0, afterExists: i !== 2 })), 123456);
const snapshotB = createFileChangeSnapshot("b-turn-1", ["/fixture/b/only-b.ts"], [{filePath:"/fixture/b/only-b.ts",beforeExists:true,afterExists:true}], 234567);
const saved = { a: snapshotA, b: snapshotB };
let hold = false;
const pending: (() => void)[] = [];
const original = window.fetch;
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/api/")) return original(input, init);
  if (/\/api\/(roles|skills)(\?|$)/.test(url)) return Response.json([]);
  const sessionId = url.includes("/sessions/b") ? "b" : "a";
  const messages = [{ role:"user", content:[{type:"text",text:"请处理文件。"}],timestamp:1000 },{role:"assistant",content:[{type:"text",text:"本轮文件已处理完成。"}],timestamp:2000,stopReason:"stop"}];
  const context = {messages,entryIds:["u1","a1"],thinkingLevel:"off",model:null,fileChangeSnapshot:structuredClone(saved[sessionId])};
  const payload = { sessionId, context, ...context, totalCount:2,page:{hasMoreBefore:false},models:{},modelList:[],roles:[],skills:[],projects:[],connections:[],status:{wechat:{connected:false,polling:false}},data:{},isRunning:false };
  if (hold && url.includes("/api/sessions/")) await new Promise<void>(resolve=>pending.push(resolve));
  return Response.json(payload);
};
window.EventSource = class extends EventTarget { static OPEN = 1; static CONNECTING = 0; static CLOSED = 2; readyState = 1; close() {} } as unknown as typeof EventSource;
let completions = 0;
function Fixture() {
  const [id, setId] = useState<"a"|"b"|null>("a");
  (globalThis as unknown as {snapshotFixture:unknown}).snapshotFixture = {
    open:setId, close:()=>setId(null), hold:()=>{hold=true;}, pending:()=>pending.length,
    release:()=>{hold=false;pending.splice(0).forEach(fn=>fn());}, completions:()=>completions,
    emit:(event:unknown)=> {
      const client = globalThis.__deerhuxAgentEventClient as unknown as {listeners:Map<string,Set<(event:unknown)=>void>>};
      for (const listener of client.listeners.get(id ?? "a") ?? []) listener(event);
    },
    saveEmpty:()=>{saved.a=createFileChangeSnapshot("a-turn-2",[],[],345678);return saved.a;},
  };
  const session:SessionInfo|null = id ? {id,path:`/fixture/${id}.jsonl`,cwd:`/fixture/${id}`,created:"2026-09-13",modified:"2026-09-13",messageCount:2,firstMessage:"请处理文件。"} : null;
  return <div style={{height:"100dvh",display:"flex",flexDirection:"column"}}><div style={{padding:12}}>会话文件快照验证</div>{session ? <ChatWindow key={session.id} session={session} newSessionCwd={null} onAgentEnd={()=>{completions++;}}/> : <div>窗口已关闭</div>}</div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
