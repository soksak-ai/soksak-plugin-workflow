// reconcile 순수 로직 단위 테스트 — node:test(무의존). `node --test reconcile.test.mjs`.
// app 의존(spawn/commands/scheduler)은 reconcileTick 에 주입해 fake 로 검증.
import test from "node:test";
import assert from "node:assert/strict";
import { isDone, pickReady, execResultToEdit, reconcileTick, buildAddParams, buildLedger } from "./main.js";

test("isDone — status done 만 true, 미존재=false", () => {
  assert.equal(isDone({ status: "done" }), true);
  assert.equal(isDone({ status: "todo" }), false);
  assert.equal(isDone(undefined), false);
});

test("isDone — 항목(kind=item)은 badge o/x/f 가 done(status 축 아님) — ① deadlock 방지", () => {
  // 항목은 검증 시 badge 만 받고 status 는 영영 todo(execResultToEdit 가 badge 만 박음). status 로 done 판정하면
  // hunt.blockedBy=[itemIds] 의 depsDone 이 영구 false → hunt/audit 영구 미실행(deadlock). 항목은 badge 로 done 판정.
  assert.equal(isDone({ kind: "item", badge: "o", status: "todo" }), true);
  assert.equal(isDone({ kind: "item", badge: "x", status: "todo" }), true);
  assert.equal(isDone({ kind: "item", badge: "f", status: "todo" }), true);
  assert.equal(isDone({ kind: "item", badge: "검수전", status: "todo" }), false, "미검증 항목은 done 아님");
  assert.equal(isDone({ kind: "item", status: "todo" }), false, "badge 없으면 done 아님");
});

test("pickReady — 검증된 항목(badge)을 blockedBy 로 가진 hunt task 가 풀린다 — ① deadlock 해소", () => {
  // 항목들이 검증(badge o/x)됐는데 status 는 todo. hunt 는 그 항목들에 blockedBy. ① 전엔 isDone=false 라 영구 미실행.
  const nodes = [
    { id: "i1", kind: "item", badge: "o", status: "todo", parentId: "g0", blockedBy: [] },
    { id: "i2", kind: "item", badge: "x", status: "todo", parentId: "g0", blockedBy: [] },
    { id: "hunt", kind: "task", status: "todo", parentId: "chunk", blockedBy: ["i1", "i2"] },
  ];
  // i1/i2 는 이미 검증(badge≠검수전)이라 제외, hunt 는 deps 충족 → ready.
  assert.deepEqual(pickReady(nodes).map((n) => n.id), ["hunt"]);
});

test("pickReady — 검수전 ∧ leaf ∧ 의존 done 만", () => {
  const nodes = [
    { id: "a", badge: "검수전", blockedBy: [], parentId: null, status: "todo" }, // ready
    { id: "b", badge: "o", blockedBy: [], parentId: null, status: "todo" }, // 이미 검증됨 — 제외
    { id: "c", badge: "검수전", blockedBy: ["a"], parentId: null, status: "todo" }, // a 미완 — 제외
    { id: "p", badge: "검수전", blockedBy: [], parentId: null, status: "todo" }, // 자식 있음(컨테이너) — 제외
    { id: "ch", badge: "검수전", blockedBy: [], parentId: "p", status: "todo" }, // leaf, 의존 없음 — ready
  ];
  const ready = pickReady(nodes).map((n) => n.id).sort();
  assert.deepEqual(ready, ["a", "ch"]);
});

test("pickReady — blockedBy done 이면 ready 로 풀린다", () => {
  const nodes = [
    { id: "a", badge: "o", blockedBy: [], parentId: null, status: "done" },
    { id: "c", badge: "검수전", blockedBy: ["a"], parentId: null, status: "todo" },
  ];
  assert.deepEqual(pickReady(nodes).map((n) => n.id), ["c"]);
});

test("pickReady — stage 작업(kind=task)은 status≠done 으로 ready(badge 없이)", () => {
  const nodes = [
    { id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: null }, // Generate — ready(배지 없음)
    { id: "aud", kind: "task", status: "done", blockedBy: [], parentId: null }, // 이미 실행됨 — 제외
    { id: "hunt", kind: "task", status: "todo", blockedBy: ["gen"], parentId: null }, // gen 미완 — 제외
  ];
  assert.deepEqual(pickReady(nodes).map((n) => n.id), ["gen"]);
});

test("pickReady — 항목(badge)과 stage(kind=task) 혼재 시 둘 다", () => {
  const nodes = [
    { id: "gen", kind: "task", status: "done", blockedBy: [], parentId: null },
    { id: "i1", badge: "검수전", kind: "item", status: "todo", blockedBy: [], parentId: "g0" },
    { id: "hunt", kind: "task", status: "todo", blockedBy: ["gen"], parentId: null }, // gen done → ready
  ];
  assert.deepEqual(pickReady(nodes).map((n) => n.id).sort(), ["hunt", "i1"]);
});

test("pickReady — 빈/비배열 안전", () => {
  assert.deepEqual(pickReady([]), []);
  assert.deepEqual(pickReady(null), []);
});

test("buildAddParams — 항목(prompt/schema)은 body=exec입력, kind/badge 통과", () => {
  const p = buildAddParams(
    { id: "i1", kind: "item", title: "재고 차감", description: "주문 시 차감", prompt: "verify…", schema: { type: "object" }, badge: "검수전" },
    "k-1",
    [],
  );
  assert.equal(p.title, "재고 차감");
  assert.equal(p.parentId, "k-1");
  assert.equal(p.kind, "item");
  assert.equal(p.badge, "검수전");
  assert.equal(p.description, "주문 시 차감", "규칙 B: description=요건설명(사람용, body 와 별개 축)");
  assert.deepEqual(JSON.parse(p.body), { prompt: "verify…", schema: { type: "object" } }, "body=exec-one 입력(verifyPrompt)");
  assert.equal(p.locked, true);
});

test("buildAddParams — 그룹(prompt 없음)은 body 빈 문자열, 드래프트 마커 없음", () => {
  const p = buildAddParams({ id: "g0", kind: "group", title: "재고", category: "재고" }, "chunk-7", []);
  assert.equal(p.kind, "group");
  assert.equal(p.body, "");
  assert.equal(p.description, undefined, "그룹은 description 없음");
  assert.equal(p.badge, undefined, "그룹은 badge 없음");
  assert.equal(p.isDraft, undefined);
});

test("buildAddParams — kind=task + taskCtx → body=exec-stage 입력(skeleton 임베드)", () => {
  // [계약] stage 는 NodeEvent.stage 필드(ev.stage). ev.prompt 아님 — task 노드 prompt 는 비운다.
  const ev = { id: "hunt", kind: "task", title: "Hunt", stage: "hunt" };
  const p = buildAddParams(ev, "k-chunk", [], { skeleton: { program: { type: "Program" } }, directive: "약국 SaaS" });
  assert.equal(p.kind, "task");
  const body = JSON.parse(p.body);
  assert.deepEqual(body.skeleton, { program: { type: "Program" } }, "skeleton 임베드(main.js, draft.js 무관여)");
  assert.equal(body.stage, "hunt", "stage=ev.stage 필드(prompt 아님)");
  assert.equal(body.args.directive, "약국 SaaS");
  assert.equal(body.args.chunkRef, "k-chunk", "chunkRef=부모(덩어리)");
  assert.equal(p.badge, undefined, "stage 작업은 badge 없음");
});

test("buildAddParams — kind=task taskCtx 없으면 body 는 stage 만(skeleton 미임베드)", () => {
  // skeleton 없는 task(방어적) — stage 는 유지(reconcile 가 파싱), skeleton/args 는 없음.
  const p = buildAddParams({ id: "hunt", kind: "task", stage: "hunt" }, "k1", []);
  const body = JSON.parse(p.body);
  assert.equal(body.stage, "hunt", "stage 는 ev.stage 로 유지");
  assert.equal(body.skeleton, undefined, "taskCtx 없으면 skeleton 미임베드");
});

test("buildLedger — 덩어리 자손 항목(kind=item)만, category=그룹 title", () => {
  const nodes = [
    { id: "chunk", kind: "chunk", parentId: null },
    { id: "g0", kind: "group", parentId: "chunk", title: "재고 관리" },
    { id: "i1", kind: "item", parentId: "g0", title: "재고 차감", badge: "o" },
    { id: "i2", kind: "item", parentId: "g0", title: "창고 연결", badge: "검수전" },
    { id: "other", kind: "item", parentId: "other-chunk", title: "남의 항목", badge: "o" }, // 다른 덩어리 — 제외
    { id: "gen", kind: "task", parentId: "chunk" }, // task — 제외
  ];
  const ledger = buildLedger(nodes, "chunk");
  assert.equal(ledger.length, 2, "이 덩어리 항목만");
  assert.deepEqual(ledger[0], { title: "재고 차감", badge: "o", category: "재고 관리" });
  assert.equal(ledger[1].badge, "검수전");
});

test("reconcileTick — hunt task 는 ledger materialize 해 exec-stage args 주입", async () => {
  const nodes = [{ id: "hunt", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"skeleton":{},"stage":"hunt","args":{"directive":"약국"}}' }];
  const deps = fakeDeps(nodes, null, { children: [], result: null });
  deps.materializeLedger = async (chunkId) => {
    assert.equal(chunkId, "chunk", "덩어리 id 로 ledger 요청");
    return [{ title: "재고 차감", badge: "o" }];
  };
  await reconcileTick(deps);
  const sent = JSON.parse(deps.calls.stage[0]);
  assert.deepEqual(sent.args.ledger, [{ title: "재고 차감", badge: "o" }], "exec-stage args.ledger 주입됨");
  assert.equal(sent.stage, "hunt");
});

test("execResultToEdit — oxf o/x/f 면 badge+result", () => {
  assert.deepEqual(execResultToEdit({ oxf: "o", result: { reason: "실재" } }), {
    badge: "o",
    result: JSON.stringify({ reason: "실재" }),
  });
  assert.deepEqual(execResultToEdit({ oxf: "f", result: "치명" }), { badge: "f", result: "치명" });
});

test("execResultToEdit — oxf 없으면 result 만(badge 미변경)", () => {
  const e = execResultToEdit({ oxf: null, result: { items: [1, 2] } });
  assert.equal(e.badge, undefined);
  assert.equal(e.result, JSON.stringify({ items: [1, 2] }));
});

// reconcileTick — fake deps 로 오케스트레이션 검증. staged = exec-stage 산출(task 경로용).
function fakeDeps(nodes, execOut, staged) {
  const calls = { get: [], edit: [], exec: [], stage: [], add: [], poke: 0 };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    calls,
    listNodes: async () => ({ ok: true, nodes }),
    getNode: async (id) => {
      calls.get.push(id);
      return { ok: true, node: { ...byId.get(id), body: byId.get(id).body || "" } };
    },
    editNode: async (id, fields) => {
      calls.edit.push({ id, fields });
      return { ok: true };
    },
    execOne: async (body) => {
      calls.exec.push(body);
      return execOut;
    },
    execStage: async (body) => {
      calls.stage.push(body);
      return staged;
    },
    addNode: async (params) => {
      calls.add.push(params);
      return "k-" + calls.add.length; // 가짜 칸반 nodeId
    },
    poke: async () => {
      calls.poke += 1;
    },
  };
}

test("reconcileTick — ready 1개 처리: get→exec→edit(badge)→poke", async () => {
  const nodes = [{ id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"verify"}' }];
  const deps = fakeDeps(nodes, { oxf: "o", result: { reason: "실재 요건" } });
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.equal(r.processed, 1);
  assert.equal(r.id, "n1");
  assert.equal(r.badge, "o");
  assert.deepEqual(deps.calls.get, ["n1"]);
  assert.deepEqual(deps.calls.exec, ['{"prompt":"verify"}'], "node.body 를 exec-one 에 그대로");
  assert.equal(deps.calls.edit.length, 1);
  assert.equal(deps.calls.edit[0].fields.badge, "o");
  assert.equal(deps.calls.poke, 1, "진척 시 다음 틱 poke");
});

test("reconcileTick — ready 없으면 아무것도 안 함(ok:true, no exec/edit/poke)", async () => {
  const nodes = [{ id: "n1", badge: "o", blockedBy: [], parentId: null, status: "done" }];
  const deps = fakeDeps(nodes, { oxf: "o", result: {} });
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true, "할 일 없음은 실패 아님");
  assert.equal(r.processed, 0);
  assert.equal(deps.calls.exec.length, 0);
  assert.equal(deps.calls.edit.length, 0);
  assert.equal(deps.calls.poke, 0);
});

test("reconcileTick — 무판정(oxf null)이면 result 만 기록·poke 안 함(tight loop 방지)", async () => {
  const nodes = [{ id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"x"}' }];
  const deps = fakeDeps(nodes, { oxf: null, result: "무판정 출력" });
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.equal(r.processed, 1);
  assert.equal(r.badge, null);
  assert.equal(deps.calls.edit[0].fields.badge, undefined, "배지 미변경");
  assert.equal(deps.calls.poke, 0, "무판정은 self-poke 안 함");
});

test("reconcileTick — exec 실패(529)면 ok:false·노드 미변경·poke 안 함(코어 backoff 재시도)", async () => {
  const nodes = [{ id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"x"}' }];
  const deps = fakeDeps(nodes, null);
  deps.execOne = async () => {
    throw new Error("exec-one exit 1 (529)");
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false, "exec 실패 → ok:false (재시도 판정 ok!=true)");
  assert.equal(r.processed, 0);
  assert.equal(deps.calls.edit.length, 0, "노드 미변경(멱등 — 검수전 유지)");
  assert.equal(deps.calls.poke, 0, "실패는 self-poke 안 함");
});

test("reconcileTick — kind=task → exec-stage: 자식 발행 + 덩어리 title + status=done + poke", async () => {
  const nodes = [{ id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: "chunk-7", body: '{"stage":"generate"}' }];
  const staged = {
    children: [
      { ev: "add", id: "g0", kind: "group", parent: "chunk-7", title: "재고" },
      { ev: "add", id: "g0i0", kind: "item", parent: "g0", title: "재고 차감", prompt: "verify…", badge: "검수전" },
    ],
    result: { chunkTitle: "약국 재고 SaaS", titleOrigin: "agent" },
  };
  const deps = fakeDeps(nodes, null, staged);
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.equal(r.stage, true);
  assert.equal(r.published, 2, "그룹+항목 발행");
  assert.deepEqual(deps.calls.stage, ['{"stage":"generate"}'], "node.body 를 exec-stage 에 그대로");
  assert.equal(deps.calls.add.length, 2, "자식 노드 2개 relay→node.add");
  assert.equal(deps.calls.add[0].parentId, "chunk-7", "그룹 parent=기존 덩어리 ref 그대로");
  assert.equal(deps.calls.add[1].kind, "item");
  assert.equal(deps.calls.add[1].parentId, "k-1", "항목 parent=그룹의 칸반 id(배치 keyOf 해결)");
  // 덩어리(chunk-7) title 갱신 + Generate 노드 status=done.
  const chunkEdit = deps.calls.edit.find((e) => e.id === "chunk-7");
  assert.equal(chunkEdit.fields.title, "약국 재고 SaaS", "덩어리 title=generate 결과");
  const doneEdit = deps.calls.edit.find((e) => e.id === "gen");
  assert.equal(doneEdit.fields.status, "done", "stage 작업 done(재-pick 0)");
  assert.equal(deps.calls.poke, 1, "발행된 항목 깨움");
  assert.equal(deps.calls.exec.length, 0, "task 는 exec-one 안 탐");
});

test("reconcileTick — generate 재진입: Hunt/Audit 이미 발행됐으면 execStage 재실행·중복 0 (② 멱등 가드)", async () => {
  // 현실 재진입: generate 가 그룹/항목 + Hunt/Audit task 까지 다 발행했는데 status=done commit 직전 실패(예외/크래시) → 재pick.
  // generate 가 *마지막에* 덩어리 자식으로 발행하는 Hunt/Audit task 가 이미 있으면 = generate 발행 완료 →
  // execStage 재실행·중복 발행 차단(자식 멱등키 부재 — kanban node.add 가 매번 새 id. 비결정 generate 는 콘텐츠 dedup 불가).
  const nodes = [
    { id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"generate"}' },
    { id: "g0", kind: "group", status: "todo", parentId: "chunk" },
    { id: "g0i0", kind: "item", status: "todo", parentId: "g0", badge: "검수전", blockedBy: [] },
    { id: "hunt", kind: "task", status: "todo", parentId: "chunk", blockedBy: ["g0i0"] },
    { id: "audit", kind: "task", status: "todo", parentId: "chunk", blockedBy: ["g0i0", "hunt"] },
  ];
  const staged = { children: [{ ev: "add", id: "g0", kind: "group", parent: "chunk", title: "중복!" }], result: {} };
  const deps = fakeDeps(nodes, null, staged);
  const r = await reconcileTick(deps);
  assert.equal(deps.calls.stage.length, 0, "발행 완료 마커(Hunt/Audit) 있으면 execStage 재실행 안 함");
  assert.equal(deps.calls.add.length, 0, "중복 발행 0");
  const done = deps.calls.edit.find((e) => e.id === "gen");
  assert.equal(done.fields.status, "done", "재진입은 status=done 만 멱등 재확정");
  assert.equal(r.ok, true);
});

test("reconcileTick — generate 첫 실행(마커 없음)은 정상 발행(가드 오발 없음)", async () => {
  // 덩어리에 sibling task(Hunt/Audit)가 없으면 generate 미발행 → 정상 execStage+발행. ② 가드가 첫 실행을 막으면 안 됨.
  const nodes = [{ id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"generate"}' }];
  const staged = { children: [{ ev: "add", id: "g0", kind: "group", parent: "chunk", title: "재고" }], result: {} };
  const deps = fakeDeps(nodes, null, staged);
  await reconcileTick(deps);
  assert.equal(deps.calls.stage.length, 1, "첫 실행은 execStage 정상 호출");
  assert.equal(deps.calls.add.length, 1, "자식 발행됨");
});

test("reconcileTick — exec-stage 자식 relay 가 blockedBy 를 keyOf 로 칸반 id 해석(Hunt 순서)", async () => {
  // [B ② 절반] 자식 ev.blocked_by(로컬 항목 id) → keyOf 해석 → node.blockedBy(칸반 id).
  // Hunt 가 항목들 검증 후 ready 되려면 이 배선 필수 — 없으면 Hunt 가 항목 검증 전 ready 버그.
  const nodes = [{ id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: "chunk-7", body: '{"stage":"generate"}' }];
  const staged = {
    children: [
      { ev: "add", id: "g0", kind: "group", parent: "chunk-7", title: "재고" }, // → k-1
      { ev: "add", id: "g0i0", kind: "item", parent: "g0", title: "차감", prompt: "v", badge: "검수전" }, // → k-2
      { ev: "add", id: "g0i1", kind: "item", parent: "g0", title: "동기화", prompt: "v", badge: "검수전" }, // → k-3
      { ev: "add", id: "hunt", kind: "task", parent: "chunk-7", stage: "hunt", title: "누락 탐색", blocked_by: ["g0i0", "g0i1"] }, // → k-4
      { ev: "add", id: "audit", kind: "task", parent: "chunk-7", stage: "audit", title: "감사", blocked_by: ["g0i0", "g0i1", "hunt"] }, // → k-5
    ],
    result: {},
  };
  const deps = fakeDeps(nodes, null, staged);
  const r = await reconcileTick(deps);
  assert.equal(r.published, 5);
  const huntAdd = deps.calls.add[3];
  assert.equal(huntAdd.kind, "task");
  assert.deepEqual(huntAdd.blockedBy, ["k-2", "k-3"], "Hunt blockedBy=항목들 칸반 id(로컬 g0i0/g0i1 keyOf 해석)");
  const auditAdd = deps.calls.add[4];
  assert.deepEqual(auditAdd.blockedBy, ["k-2", "k-3", "k-4"], "Audit blockedBy=항목들+Hunt 칸반 id(keyOf 해석)");
});

test("reconcileTick — kind=task exec-stage 실패면 ok:false·노드 미변경(backoff)", async () => {
  const nodes = [{ id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: "chunk-7", body: "{}" }];
  const deps = fakeDeps(nodes, null, null);
  deps.execStage = async () => {
    throw new Error("exec-stage exit 1");
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false);
  assert.equal(deps.calls.add.length, 0, "실패 시 발행 0");
  assert.equal(deps.calls.edit.length, 0, "status=done 안 함(재시도 대상 유지)");
  assert.equal(deps.calls.poke, 0);
});
