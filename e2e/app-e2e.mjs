#!/usr/bin/env node
// app-e2e — 실행 중인 soksak 앱에서 워크플로 전 체인을 레지스트리 커맨드로만 구동·관찰하는 멱등 하네스.
// 사이드카 직접 호출 금지(PLUGIN-CONTRACT §5) — 완결 판정은 실경로(spawn·IPC·stdin EOF·secretEnv) 경유.
//
//   node e2e/app-e2e.mjs run      # 발사+완주 관찰(멱등 — 보드에 draft chunk 있으면 발사 생략)
//   node e2e/app-e2e.mjs observe  # 관찰만(발사 없음)
//   node e2e/app-e2e.mjs ping     # provider 헬스 프로브(workflow.ping — 보드 무접촉)
//   node e2e/app-e2e.mjs status   # 일회 진단: 앱/플러그인/볼트/보드 체인 요약(멱등·무변경)
//   node e2e/app-e2e.mjs contract # 계약-핀 e2e: 발견→투영→갱신→서비스 해소→회수 (LLM 0·멱등·인증 불요)
//
// env: SOKSAK_SOCKET(기본 ~/.soksak-dev/com.soksak.dev.sock — A17 identity 홈), IDEA_FILE(기본 e2e/idea.txt),
//      ANTHROPIC_*(run-e2e.zsh 가 캡처 주입 — run/ping 에 필요), APP_E2E_MAX_HOURS(기본 8).
// 멱등성: run 재실행은 안전 — 이미 발행됐으면 관찰만, 완주됐으면 즉시 판정 반환.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCK = process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak-dev", "com.soksak.dev.sock");
let WINDOW = process.env.SOKSAK_WINDOW || null; // 워크스페이스 창(w-*) — 플러그인 호스트. 미지정 시 자동 발견.
const WF = "plugin.soksak-plugin-workflow";
// 보드는 계약으로 발견한다 — 하니스도 구현체 이름을 모른다. 이름을 알면 하니스는 플러그인이 계약으로
// 발견하는지 아니면 그냥 아는 보드를 부르는지 구별하지 못한다(자기가 정답을 알려주는 시험이 된다).
const BOARD_CONTRACT = "soksak-spec-plugin-issue-board";
const PROMPT_CONTRACT = "soksak-spec-plugin-prompt-store";
let KB = null; // 발견된 구현체의 명령 접두 — resolveBoard() 가 채운다.
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
    s.on("connect", () => s.write(JSON.stringify({ id: 1, method, params, timeoutMs, ...(WINDOW ? { window: WINDOW } : {}) }) + "\n"));
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

/** 응답 언랩 — 신형 {code:"OK",data} 우선, 구형 {ok:true} 수용. 그 외 = 명시 실패. */
function unwrap(r) {
  if (r && r.code === "OK") return r.data ?? r;
  if (r && r.ok === true) return r;
  throw new Error(`응답 실패: ${JSON.stringify(r).slice(0, 200)}`);
}

/** discoverWindow — 워크스페이스 창(w-*) 자동 발견(제어판 main 은 플러그인 미로드 — A17 창 분리). */
async function discoverWindow() {
  const saved = WINDOW;
  WINDOW = null; // window.projects 는 제어판 대상
  try {
    const r = unwrap(await call("window.projects"));
    const w = (r.projects || [])[0];
    WINDOW = w ? w.window : saved;
    return WINDOW;
  } catch {
    WINDOW = saved;
    return null;
  }
}

/** 두 계약을 모두 구현한 활성 플러그인 — 플러그인이 하는 해소를 하니스가 독립으로 되풀이한다. */
async function resolveBoard() {
  const of = async (contract) => {
    const r = unwrap(await call("plugin.implementers", { id: contract }));
    return (r.implementers || []).filter((i) => i.status === "enabled").map((i) => i.id);
  };
  const stores = new Set(await of(PROMPT_CONTRACT));
  const id = (await of(BOARD_CONTRACT)).find((x) => stores.has(x));
  KB = id ? `plugin.${id}` : null;
  return id;
}

async function appReady() {
  try {
    if (!WINDOW && !(await discoverWindow())) return null;
    const r = unwrap(await call("plugin.list"));
    const st = (id) => (r.plugins || []).find((p) => p.id === id)?.status;
    if (st("soksak-plugin-workflow") !== "enabled") return null;
    return (await resolveBoard()) ? r : null; // 보드는 이름이 아니라 계약으로 있는지 본다
  } catch {
    return null;
  }
}

async function board() {
  if (!KB && !(await resolveBoard())) throw new Error("두 계약을 모두 구현한 보드 없음");
  const r = unwrap(await call(`${KB}.node.list`, { limit: 100_000 }));
  return r.nodes || [];
}

function summarize(ns) {
  const by = (k) => ns.filter((n) => n.kind === k);
  const badgeDist = (list) => {
    const d = {};
    for (const n of list) d[n.badge || "-"] = (d[n.badge || "-"] || 0) + 1;
    return d;
  };
  const confirmed = (n) => n.badge === "o" || n.badge === "x" || n.badge === "f";
  const chunks = by("chunk");
  const items = by("item");
  const facts = by("fact");
  const units = by("plan-unit");
  const codes = by("code");
  return {
    chunks, items, facts, units, codes,
    badges: badgeDist(items),
    factBadges: badgeDist(facts),
    unitBadges: badgeDist(units),
    codeBadges: badgeDist(codes),
    tasks: Object.fromEntries(by("task").map((t) => [t.title || t.id, t.status])),
    allConfirmed: (list) => list.length > 0 && list.every(confirmed),
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
  await discoverWindow();
  const r = unwrap(await call(`${WF}.ping`, { env: captureEnv() }, 900_000));
  log("ping →", JSON.stringify(r));
  process.exit(r.oxf === "o" ? 0 : 1);
}

async function fire(idea) {
  log("workflow.run 발사");
  try {
    const r = unwrap(await call(`${WF}.run`, { idea, env: captureEnv() }, 3_600_000));
    log("run →", JSON.stringify(r).slice(0, 300));
    return true;
  } catch (e) {
    log("run 응답 유실(핸들러 생존 가능):", String(e).slice(0, 80));
    return null;
  }
}

/** status — 일회 진단 스냅샷(멱등·무변경). 매 진단마다 임시 스크립트를 짜는 대신 이걸 쓴다. */
async function cmdStatus() {
  await discoverWindow();
  let plugins;
  try {
    plugins = unwrap(await call("plugin.list"));
  } catch (e) {
    log("앱: 다운/실패 —", String(e).slice(0, 100));
    process.exit(1);
  }
  if (!Array.isArray(plugins.plugins)) {
    log("plugin.list 형태 이상:", JSON.stringify(plugins).slice(0, 120));
    process.exit(1);
  }
  const boardId = await resolveBoard();
  log(`보드(계약 ${BOARD_CONTRACT} ∩ ${PROMPT_CONTRACT}): ${boardId ?? "없음"}`);
  for (const id of ["soksak-plugin-workflow", boardId].filter(Boolean)) {
    const p = plugins.plugins.find((x) => x.id === id);
    log(`${id}: ${p?.status}${p?.error ? " | " + p.error.slice(0, 60) : ""}`);
  }
  try {
    unwrap(await call("secret.keys", { ns: "soksak-plugin-workflow" }));
    log("볼트: unlocked");
  } catch (e) {
    log("볼트:", String(e).slice(0, 40), "(잠김이면 세션 env 폴백 — run 모드가 ping 재주입)");
  }
  const s = summarize(await board());
  log(`chunk ${s.chunks.length} ${s.chunks.map((c) => c.badge || "검수전")} | items ${s.items.length} ${JSON.stringify(s.badges)} | tasks ${JSON.stringify(s.tasks)} | facts ${JSON.stringify(s.factBadges)} | units ${JSON.stringify(s.unitBadges)} | code ${JSON.stringify(s.codeBadges)}`);
  process.exit(0);
}

/** 한 이슈의 잔재를 원장이 정한 순서대로 걷는다: 리스를 놓고, 그 다음에 항목을 지운다. 원장은 점유
 *  중인 항목의 삭제를 LEASE_HELD 로 거절한다 — 그 게이트는 옳으므로 우회하지 않고 따른다. 항목이
 *  없으면 두 호출 다 무해한 no-op 다. */
async function reclaim(issue) {
  await call(`${WF}.lease.release`, { issue, owner: "e2e" }).catch(() => {});
  await call(`${WF}.entry.remove`, { issue }).catch(() => {});
}

/** contract — 계약-핀 e2e(LLM 0·멱등·자기회수). 이름-핀을 지운 뒤에도 워크플로가 보드에 닿는지,
 *  그리고 그 접촉이 계약 발견을 거쳐 일어나는지 실앱에서 본다. 하니스는 구현체 이름을 모른다.
 *
 *  회수 3축: 원장 항목(데이터) · 보드 카드(표면) · 노드 수 baseline 복귀 — 연속 실행이 GREEN 이어야
 *  진짜 멱등이다(cold-only GREEN 은 가짜). */
async function cmdContract() {
  const ISSUE = "e2e-contract-pin";
  const fail = (m) => { log("FAIL:", m); process.exit(1); };

  if (!(await appReady())) fail("앱/플러그인 미준비");
  const boardId = await resolveBoard();
  if (!boardId) fail("두 계약을 모두 구현한 보드 없음");
  log(`① 발견: ${BOARD_CONTRACT} ∩ ${PROMPT_CONTRACT} → ${boardId}`);

  // 자기 잔재부터 회수한다 — 앞선 실행이 중간에 죽었다면 그 원장 항목·리스·카드가 남아 있고, 그것을
  // 그대로 둔 채 시작하면 다음 실행은 "갓 등록한 이슈"를 검사하면서 지난 실행의 상태를 본다. 시나리오는
  // 자기 것만 지운다(다른 이슈·다른 카드는 건드리지 않는다). 리스를 먼저 놓는다 — 원장은 점유 중인
  // 항목의 삭제를 거절한다(LEASE_HELD). 그 게이트를 우회하지 않고 지킨다.
  await reclaim(ISSUE);

  // baseline — 이 시나리오가 남기는 것이 0 임을 끝에서 이 수로 판정한다. 원장 그룹 카드는 이 시나리오의
  // 산물이 아니라 원장이 보드에 두는 상설 픽스처다: 먼저 만들어 놓고 재야 cold 첫 실행과 warm 재실행이
  // 같은 baseline 을 갖는다(cold 에서만 +1 이 나면 멱등이 아니라 실행 순서를 탄 것이다).
  unwrap(await call(`${WF}.board.sync`));
  const before = (await board()).length;

  // ② JS 반쪽: 원장 → 보드 투영. 매니페스트에 구현체 이름이 없는데도 호출 경계를 통과해야 한다
  //    (통과의 근거는 consumes 계약-핀뿐이다 — 이름-핀은 지워졌다).
  unwrap(await call(`${WF}.entry.add`, { issue: ISSUE, branch: "feat/contract-pin" }));
  const sync = unwrap(await call(`${WF}.board.sync`, { issue: ISSUE }));
  if (sync.board !== boardId) fail(`투영 대상이 발견된 구현체와 다름: ${sync.board} ≠ ${boardId}`);
  if (!(sync.projected || []).some((p) => p.issue === ISSUE)) fail(`투영 안 됨: ${JSON.stringify(sync.skipped)}`);
  const nodeId = sync.projected.find((p) => p.issue === ISSUE).nodeId;
  log(`② 투영: ${ISSUE} → ${boardId} 카드 ${nodeId}`);

  // ③ 카드가 실제로 보드에 있고, 원장 그룹 카드 밑에 달렸는지 — 보드를 되읽어 확인한다.
  const card = (await board()).find((n) => n.id === nodeId);
  if (!card) fail("보드에 카드가 없음(투영 보고와 보드 상태 불일치)");
  if (card.status !== "backlog") fail(`갓 등록한 이슈의 카드 상태가 backlog 가 아님: ${card.status}`);
  const root = (await board()).find((n) => n.id === sync.root);
  if (!root) fail("원장 그룹 카드 없음 — 이슈가 남의 카드 사이에 흩뿌려진다");
  if (card.parentId !== sync.root) fail(`카드가 그룹 밑에 없음: parentId=${card.parentId}`);
  log(`③ 되읽기: 카드 "${card.title}" status=${card.status} · 그룹 "${root.title}" 밑`);

  // ④ 갱신 경로(node.edit)도 계약으로 간다 — 리스를 쥐면 카드가 inprogress 로 바뀌어야 한다.
  unwrap(await call(`${WF}.lease.acquire`, { issue: ISSUE, owner: "e2e" }));
  unwrap(await call(`${WF}.board.sync`, { issue: ISSUE }));
  const held = (await board()).find((n) => n.id === nodeId);
  if (held?.status !== "inprogress") fail(`리스 보유가 카드에 반영 안 됨: ${held?.status}`);
  log(`④ 갱신: 리스 보유 → 카드 status=${held.status}`);

  // ⑤ Rust 반쪽(서비스)도 같은 계약으로 구현체를 해소한다. 없는 chunk 로 부르면 모든 노드가 스코프
  //    밖이라 idle 로 끝난다(LLM 0·리스 0) — 그래도 해소 게이트는 통과해야 한다. 교집합이 비면
  //    여기서 UNAVAILABLE 로 거절된다.
  const nx = unwrap(await call(`${WF}.next`, { chunk: "e2e-contract-pin-nonexistent-scope" }, 60_000));
  if (nx.node) fail(`서비스 next 가 노드를 발급함(공유 보드 부작용 우려): ${JSON.stringify(nx).slice(0, 120)}`);
  log("⑤ 서비스: 계약 해소 통과 → next 유휴, 노드 미발급 (LLM 0)");

  // ⑥ 회수 — 리스를 놓고(원장은 점유 중인 항목의 삭제를 거절한다) 항목을 지우면 카드도 걷힌다.
  //    남으면 남의 화면에 유령 카드가 선다.
  unwrap(await call(`${WF}.lease.release`, { issue: ISSUE, owner: "e2e" }));
  unwrap(await call(`${WF}.entry.remove`, { issue: ISSUE }));
  const after = await board();
  if (after.some((n) => n.id === nodeId)) fail("회수 실패 — 카드가 보드에 남음");
  const left = after.length;
  if (left !== before) fail(`표면 baseline 미복귀: ${before} → ${left} (원장 그룹 카드가 남았을 수 있다)`);
  const ledger = unwrap(await call(`${WF}.lease.list`));
  if ((ledger.entries || []).some((e) => e.issue === ISSUE)) fail("회수 실패 — 원장에 항목이 남음");
  log(`⑥ 회수: 카드·원장 항목 제거, 노드 수 ${before} → ${left} (baseline 복귀)`);

  log("GREEN — 계약-핀 e2e 통과(이름-핀 0)");
  process.exit(0);
}

async function main() {
  const mode = process.argv[2] || "run";
  if (mode === "ping") return cmdPing();
  if (mode === "status") return cmdStatus();
  if (mode === "contract") return cmdContract();
  const ideaFile = process.env.IDEA_FILE || new URL("./idea.txt", import.meta.url).pathname;
  const idea = mode === "run" ? fs.readFileSync(ideaFile, "utf8").trim() : null;

  let fires = 0;
  let lastFire = 0;
  let prev = "";
  let envSeeded = false;
  let lastChangeAt = Date.now();
  const STALL_MS = 5 * 60_000; // 전이 없이 5분 — env 소실/스케줄러 잠듦 의심 → 재주입+poke 재사이클
  while (Date.now() < DEADLINE) {
    if (!(await appReady())) {
      log("앱 대기(다운/재빌드/플러그인 부팅)");
      envSeeded = false; // 앱이 내려갔다 오면 세션 env 휘발 — 복귀 시 재주입 필수
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
        await call(`${WF}.ping`, { env: captureEnv() }, 900_000);
        await call(`${WF}.reconcile`, {}, 3_600_000);
      } catch (e) {
        log("재주입/poke 실패(다음 사이클 재시도):", String(e).slice(0, 80));
        await sleep(30_000);
        continue;
      }
      envSeeded = true;
    }
    const state = JSON.stringify([s.chunks.map((c) => c.badge || "-"), s.items.length, s.badges, s.tasks, s.factBadges, s.unitBadges, s.codeBadges]);
    if (state !== prev) {
      log(`chunk ${s.chunks.map((c) => c.badge || "검수전")} | items ${s.items.length} ${JSON.stringify(s.badges)} | tasks ${JSON.stringify(s.tasks)} | facts ${JSON.stringify(s.factBadges)} | units ${JSON.stringify(s.unitBadges)} | code ${JSON.stringify(s.codeBadges)}`);
      prev = state;
      lastChangeAt = Date.now();
    } else if (mode === "run" && envSeeded && Date.now() - lastChangeAt > STALL_MS) {
      log("정체 감지(5분 무전이) — env 재주입+poke 재사이클");
      envSeeded = false;
      lastChangeAt = Date.now();
    }
    // 전체 파이프라인 오케스트레이션(C1) — 게이트 커맨드는 하네스가 자동 호출, 실행은 전부 스케줄러.
    const chunk = s.chunks[0];
    if (mode === "run" && chunk && chunk.badge === "o") {
      if (s.facts.length === 0) {
        log("audit 인증 감지 → research 체인 발행");
        try {
          unwrap(await call(`${WF}.research`, { chunk: chunk.id }, 3_600_000));
        } catch (e) {
          const msg = String(e);
          if (!msg.includes("ALREADY_DONE")) { log("research 발행 실패(재시도 예정):", msg.slice(0, 100)); await sleep(30_000); continue; }
        }
      } else if (s.allConfirmed(s.facts) && s.allConfirmed(s.units) && s.codes.length === 0) {
        log("fact·unit 전부 확정 감지 → issuerize(파일별 실코드화)");
        try {
          const r = unwrap(await call(`${WF}.issuerize`, { chunk: chunk.id }, 3_600_000));
          log("issuerize →", JSON.stringify(r).slice(0, 150));
        } catch (e) {
          const msg = String(e);
          if (!msg.includes("ALREADY_DONE")) { log("issuerize 거부(게이트/재시도):", msg.slice(0, 120)); await sleep(30_000); continue; }
        }
      } else if (s.codes.length > 0 && s.allConfirmed(s.codes)) {
        log("완주 — 전 파일 code 확정:", s.codes.map((c) => `${c.title}=${c.badge}`).join(", "));
        process.exit(s.codes.every((c) => c.badge === "o") ? 0 : 2);
      }
    }
    if (chunk && chunk.badge === "f") {
      log("종료 — 덩어리 폐기(audit f)");
      process.exit(2);
    }
    await sleep(60_000);
  }
  log("관찰 상한 도달 — 미완");
  process.exit(4);
}

main().catch((e) => { log("FATAL:", e); process.exit(1); });
