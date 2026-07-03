#!/usr/bin/env node
// app-e2e — 실행 중인 soksak 앱에서 워크플로 전 체인을 레지스트리 커맨드로만 구동·관찰하는 멱등 하네스.
// 사이드카 직접 호출 금지(PLUGIN-CONTRACT §5) — 완결 판정은 실경로(spawn·IPC·stdin EOF·secretEnv) 경유.
//
//   node e2e/app-e2e.mjs run     # 발사+완주 관찰(멱등 — 보드에 draft chunk 있으면 발사 생략)
//   node e2e/app-e2e.mjs observe # 관찰만(발사 없음)
//   node e2e/app-e2e.mjs ping    # provider 헬스 프로브(workflow.ping — 보드 무접촉)
//   node e2e/app-e2e.mjs status  # 일회 진단: 앱/플러그인/볼트/보드 체인 요약(멱등·무변경)
//
// env: SOKSAK_SOCKET(기본 ~/.soksak/com.soksak.dev.sock), IDEA_FILE(기본 e2e/idea.txt),
//      ANTHROPIC_*(run-e2e.zsh 가 캡처 주입 — run/ping 에 필요), APP_E2E_MAX_HOURS(기본 8).
// 멱등성: run 재실행은 안전 — 이미 발행됐으면 관찰만, 완주됐으면 즉시 판정 반환.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCK = process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const WF = "plugin.soksak-plugin-workflow";
const KB = "plugin.soksak-plugin-kanban";
const DEADLINE = Date.now() + Number(process.env.APP_E2E_MAX_HOURS || 8) * 3600_000;
const FIRE_BACKOFF_MS = 600_000; // 발사 유실 후 재발사 간격(provider 529 는 사이드카가 30s 재실행 — 여긴 상위 방어)
const MAX_FIRES = 4;

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 소켓 JSON-RPC 1왕복. timeoutMs 는 코어 라우트 타임아웃(기본 10s → 명시). */
function call(method, params = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCK);
    let buf = "";
    const t = setTimeout(() => { s.destroy(); reject(new Error("클라이언트 대기 초과")); }, timeoutMs + 60_000);
    s.on("connect", () => s.write(JSON.stringify({ id: 1, method, params, timeoutMs }) + "\n"));
    s.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(t);
        s.end();
        const line = buf.slice(0, nl).trim();
        if (!line) return reject(new Error("빈 응답"));
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      }
    });
    s.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function appReady() {
  try {
    const r = await call("plugin.list");
    if (!r.ok) return null;
    const st = (id) => r.plugins.find((p) => p.id === id)?.status;
    return st("soksak-plugin-workflow") === "enabled" && st("soksak-plugin-kanban") === "enabled" ? r : null;
  } catch {
    return null;
  }
}

async function board() {
  const r = await call(`${KB}.node.list`, { limit: 100_000 });
  return r.nodes || [];
}

function summarize(ns) {
  const by = (k) => ns.filter((n) => n.kind === k);
  const chunks = by("chunk");
  const items = by("item");
  const badges = {};
  for (const n of items) badges[n.badge || "-"] = (badges[n.badge || "-"] || 0) + 1;
  return {
    chunks,
    items,
    badges,
    tasks: Object.fromEntries(by("task").map((t) => [t.title || t.id, t.status])),
    facts: by("fact").length,
    planUnits: by("plan-unit").length,
  };
}

function captureEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("ANTHROPIC_") || k === "CLAUDE_ACCOUNT_NAME") env[k] = v;
  }
  return env;
}

async function cmdPing() {
  const r = await call(`${WF}.workflow.ping`, { env: captureEnv() }, 900_000);
  log("ping →", JSON.stringify(r));
  process.exit(r.ok && r.oxf === "o" ? 0 : 1);
}

async function fire(idea) {
  log("workflow.run 발사");
  try {
    const r = await call(`${WF}.workflow.run`, { idea, env: captureEnv() }, 3_600_000);
    log("workflow.run →", JSON.stringify(r).slice(0, 300));
    return r.ok;
  } catch (e) {
    log("run 응답 유실(핸들러 생존 가능):", String(e).slice(0, 80));
    return null;
  }
}

/** status — 일회 진단 스냅샷(멱등·무변경). 매 진단마다 임시 스크립트를 짜는 대신 이걸 쓴다. */
async function cmdStatus() {
  let plugins;
  try {
    plugins = await call("plugin.list");
  } catch (e) {
    log("앱: 다운 —", String(e).slice(0, 60));
    process.exit(1);
  }
  for (const id of ["soksak-plugin-workflow", "soksak-plugin-kanban"]) {
    const p = plugins.plugins.find((x) => x.id === id);
    log(`${id}: ${p?.status}${p?.error ? " | " + p.error.slice(0, 60) : ""}`);
  }
  try {
    await call("secret.keys", { ns: "soksak-plugin-workflow" });
    log("볼트: unlocked");
  } catch (e) {
    log("볼트:", String(e).slice(0, 40), "(잠김이면 세션 env 폴백 — run 모드가 ping 재주입)");
  }
  const s = summarize(await board());
  log(`chunk ${s.chunks.length} ${s.chunks.map((c) => c.badge || "검수전")} | items ${s.items.length} ${JSON.stringify(s.badges)} | tasks ${JSON.stringify(s.tasks)} | facts ${s.facts} | plan-units ${s.planUnits}`);
  process.exit(0);
}

async function main() {
  const mode = process.argv[2] || "run";
  if (mode === "ping") return cmdPing();
  if (mode === "status") return cmdStatus();
  const ideaFile = process.env.IDEA_FILE || new URL("./idea.txt", import.meta.url).pathname;
  const idea = mode === "run" ? fs.readFileSync(ideaFile, "utf8").trim() : null;

  let fires = 0;
  let lastFire = 0;
  let prev = "";
  let envSeeded = false;
  while (Date.now() < DEADLINE) {
    if (!(await appReady())) {
      log("앱 대기(다운/재빌드/플러그인 부팅)");
      await sleep(20_000);
      continue;
    }
    let ns;
    try {
      ns = await board();
    } catch (e) {
      log("보드 조회 실패:", String(e).slice(0, 60));
      await sleep(20_000);
      continue;
    }
    const s = summarize(ns);

    if (s.chunks.length === 0) {
      if (mode !== "run") {
        log("관찰 모드 — 발행 대기");
        await sleep(30_000);
        continue;
      }
      if (Date.now() - lastFire > FIRE_BACKOFF_MS) {
        if (fires >= MAX_FIRES) {
          log(`FAIL: 발사 ${MAX_FIRES}회 소진 — chunk 미발행`);
          process.exit(3);
        }
        fires += 1;
        lastFire = Date.now();
        log(`발사 ${fires}/${MAX_FIRES}`);
        await fire(idea);
      }
      await sleep(10_000);
      continue;
    }

    if (!envSeeded && mode === "run") {
      // 앱 재기동 시 세션 env 휘발 + 볼트 잠김이면 reconcile exec 가 인증 없이 공회전한다(실측:
      // "프로필 인증 토큰 미설정"). ping 이 env 를 세션에 재주입하고, reconcile 1회로 재개를 민다.
      log("env 재주입(ping) + reconcile poke");
      try {
        await call(`${WF}.workflow.ping`, { env: captureEnv() }, 900_000);
        await call(`${WF}.workflow.reconcile`, {}, 3_600_000);
      } catch (e) {
        log("재주입/poke 실패(다음 사이클 재시도):", String(e).slice(0, 80));
        await sleep(30_000);
        continue;
      }
      envSeeded = true;
    }
    const state = JSON.stringify([s.chunks.map((c) => c.badge || "-"), s.items.length, s.badges, s.tasks, s.facts, s.planUnits]);
    if (state !== prev) {
      log(`chunk ${s.chunks.length} | items ${s.items.length} ${JSON.stringify(s.badges)} | tasks ${JSON.stringify(s.tasks)} | facts ${s.facts} | plan-units ${s.planUnits}`);
      prev = state;
    }
    if (s.chunks.every((c) => c.badge === "o" || c.badge === "f")) {
      log("완주 — 덩어리 인증 확정:", s.chunks.map((c) => `${c.id}=${c.badge}`).join(", "));
      process.exit(s.chunks.every((c) => c.badge === "o") ? 0 : 2);
    }
    await sleep(60_000);
  }
  log("관찰 상한 도달 — 미완");
  process.exit(4);
}

main().catch((e) => { log("FATAL:", e); process.exit(1); });
