#!/usr/bin/env node
// mcp-verify — 검색 기질(substrate) 게이트. provider.rs default_search_servers 가 배선하는 MCP 서버가
// 리서치 프롬프트가 요구하는 도구를 실제로 노출하는지 프로브로 검증한다. 규칙: "노출할 것이다" 가정 배선
// 금지 — 이 게이트를 통과한 서버만 배선한다(@z_ai/mcp-server 를 검색으로 착각한 오류의 재발 방지 도구).
//
// 사용: node tools/mcp-verify.mjs            # 도구 노출 검증(하나라도 결핍이면 exit 1)
//       node tools/mcp-verify.mjs --call     # 도구 호출까지(실데이터 반환 확인, 네트워크 필요)
//       ZAI_TOKEN=... 있으면 z.ai web_search_prime(정식 웹검색)도 검증.
import { spawn } from "node:child_process";

const ZAI = process.env.ZAI_TOKEN || process.env.Z_AI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";

// 배선 정본과 동기. transport=stdio(npx) | http(원격 API).
const SUBSTRATE = [
  { name: "context7", transport: "stdio", pkg: "@upstash/context7-mcp",
    expect: ["resolve-library-id", "query-docs"],
    probe: { tool: "resolve-library-id", args: { query: "next.js", libraryName: "next.js" } } },
  // z.ai/glm 프로필만 z.ai 웹검색을 배선한다(Anthropic WebSearch 미지원 대체). real claude 는 native
  // WebSearch 를 쓰므로 웹검색 MCP 가 없다(프로브 대상 아님) — provider.rs default_search_servers 와 동기.
  ...(ZAI ? [{
    name: "web-search-prime", transport: "http",
    url: "https://api.z.ai/api/mcp/web_search_prime/mcp", auth: `Bearer ${ZAI}`,
    expect: ["web_search_prime"],
    probe: { tool: "web_search_prime", args: { search_query: "Node.js current LTS version 2026" } },
  }] : []),
];

function stdioSession(pkg, want) {
  return new Promise((resolve) => {
    const p = spawn("npx", ["-y", pkg], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "", tools = null, callRes = null, done = false;
    const send = (o) => { try { p.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
    const finish = () => { if (done) return; done = true; try { p.kill(); } catch {} resolve({ tools, callRes, err: err.slice(0, 300) }); };
    p.stdout.on("data", (d) => {
      buf += d; const lines = buf.split("\n"); buf = lines.pop();
      for (const l of lines) { if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id === 1 && m.result) {
          tools = (m.result.tools || []).map((t) => t.name);
          if (want) setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: want.tool, arguments: want.args } }), 200);
          else setTimeout(finish, 100);
        }
        if (m.id === 2) { callRes = m.result?.content?.map((x) => x.text || "").join(" ").slice(0, 200) || JSON.stringify(m.error || "").slice(0, 200); setTimeout(finish, 100); }
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { err += "spawn:" + e.message; finish(); });
    send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-verify", version: "1" } } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 250);
    setTimeout(() => send({ jsonrpc: "2.0", id: 1, method: "tools/list" }), 500);
    setTimeout(finish, 55000);
  });
}

async function httpSession(url, auth, want) {
  let sid = null;
  const parse = (t) => { for (const line of t.split("\n")) { const s = line.startsWith("data:") ? line.slice(5).trim() : line.trim(); if (!s) continue; try { return JSON.parse(s); } catch {} } return null; };
  const call = async (body) => {
    const h = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": auth };
    if (sid) h["Mcp-Session-Id"] = sid;
    const r = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
    const s = r.headers.get("mcp-session-id"); if (s) sid = s;
    return parse(await r.text());
  };
  try {
    await call({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-verify", version: "1" } } });
    await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tl = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (tl?.result?.tools || []).map((t) => t.name);
    let callRes = null;
    if (want) { const cr = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: want.tool, arguments: want.args } }); callRes = cr?.result?.content?.map((x) => x.text || "").join(" ").slice(0, 200) || JSON.stringify(cr?.error || "").slice(0, 200); }
    return { tools, callRes, err: "" };
  } catch (e) { return { tools: null, callRes: null, err: String(e).slice(0, 300) }; }
}

const doCall = process.argv.includes("--call");
let failed = 0;
for (const s of SUBSTRATE) {
  const r = s.transport === "http"
    ? await httpSession(s.url, s.auth, doCall ? s.probe : null)
    : await stdioSession(s.pkg, doCall ? s.probe : null);
  const missing = r.tools ? s.expect.filter((t) => !r.tools.includes(t)) : s.expect;
  const ok = r.tools && missing.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"} ${s.name} [${s.transport}]`);
  console.log(`  tools: ${r.tools ? r.tools.join(", ") : "(응답 없음) " + r.err}`);
  if (missing.length) console.log(`  결핍: ${missing.join(", ")}`);
  if (doCall && r.callRes) console.log(`  ${s.probe.tool} 반환: ${r.callRes}`);
  if (!ok) failed++;
}
if (failed) { console.error(`\n${failed}개 서버가 기대 도구를 노출하지 못함 — 배선 금지.`); process.exit(1); }
console.log("\n전 서버 게이트 통과 — 배선 검증됨.");
