// reconcile 순수 로직 단위 테스트 — node:test(무의존). `node --test reconcile.test.mjs`.
// app 의존(spawn/commands/scheduler)은 reconcileTick 에 주입해 fake 로 검증.
import test from "node:test";
import assert from "node:assert/strict";
import { isDone, pickReady, execResultToEdit, reconcileTick, makeReconcileState, buildAddParams, buildLedger, registerPromptTemplates, genSkeletonArgs, validateDraftDoc, applyDraftDoc, buildSecretEnvMap, buildSpawnCmd } from "./main.js";

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

test("pickReady — audit(다른 task 의존)는 덩어리에 검수전 항목 남으면 not-ready (#6 hunt 추가항목 게이트)", () => {
  // audit.blockedBy=[원래 항목들, hunt] 는 정적이라 hunt 가 동적 발행한 추가항목(검수전)을 안 기다린다.
  // → hunt done 되면 audit ready → 미검증 항목 섞인 ledger 로 완결 인증(버그). 덩어리에 검수전 남으면 막는다.
  const nodes = [
    { id: "chunk", kind: "chunk", parentId: null, status: "todo" },
    { id: "g0", kind: "group", parentId: "chunk", status: "todo" },
    { id: "i1", kind: "item", parentId: "g0", badge: "o", blockedBy: [], status: "todo" },
    { id: "hunt", kind: "task", parentId: "chunk", blockedBy: ["i1"], status: "done" },
    { id: "add0", kind: "item", parentId: "chunk", badge: "검수전", blockedBy: [], status: "todo" }, // hunt 추가항목 — 미검증
    { id: "audit", kind: "task", parentId: "chunk", blockedBy: ["i1", "hunt"], status: "todo" },
  ];
  // add0(미검증 leaf)만 ready, audit 는 덩어리에 검수전 남아 게이트.
  assert.deepEqual(pickReady(nodes).map((n) => n.id).sort(), ["add0"]);
});

test("pickReady — audit 는 덩어리 검수전 0 이면 ready (#6 게이트 통과)", () => {
  const nodes = [
    { id: "chunk", kind: "chunk", parentId: null, status: "todo" },
    { id: "i1", kind: "item", parentId: "chunk", badge: "o", blockedBy: [], status: "todo" },
    { id: "hunt", kind: "task", parentId: "chunk", blockedBy: ["i1"], status: "done" },
    { id: "add0", kind: "item", parentId: "chunk", badge: "x", blockedBy: [], status: "todo" }, // 검증됨
    { id: "audit", kind: "task", parentId: "chunk", blockedBy: ["i1", "hunt"], status: "todo" },
  ];
  assert.deepEqual(pickReady(nodes).map((n) => n.id), ["audit"]);
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

test("buildLedger — 덩어리 자손 항목(kind=item)만, id 포함 + category=항목 자신 필드(평탄, classify 전엔 빈 값)", () => {
  const nodes = [
    { id: "chunk", kind: "chunk", parentId: null },
    { id: "i1", kind: "item", parentId: "chunk", title: "재고 차감", badge: "o", category: "재고 관리" }, // classify 후(category 부여됨)
    { id: "i2", kind: "item", parentId: "chunk", title: "창고 연결", badge: "검수전" }, // classify 전(category 없음)
    { id: "other", kind: "item", parentId: "other-chunk", title: "남의 항목", badge: "o" }, // 다른 덩어리 — 제외
    { id: "gen", kind: "task", parentId: "chunk" }, // task — 제외
  ];
  const ledger = buildLedger(nodes, "chunk");
  assert.equal(ledger.length, 2, "이 덩어리 항목만");
  assert.deepEqual(ledger[0], { id: "i1", title: "재고 차감", badge: "o", category: "재고 관리" }, "id 포함 + category=항목 자신 필드");
  assert.deepEqual(ledger[1], { id: "i2", title: "창고 연결", badge: "검수전", category: undefined }, "classify 전엔 category 빈 값");
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

test("reconcileTick — classify task 도 ledger materialize 해 exec-stage args 주입(완성 원장 분류)", async () => {
  const nodes = [{ id: "classify", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"classify","args":{"directive":"약국"}}' }];
  const deps = fakeDeps(nodes, null, { children: [], result: { dimension: "", assignments: [] } });
  deps.materializeLedger = async (chunkId) => {
    assert.equal(chunkId, "chunk", "덩어리 id 로 ledger 요청");
    return [{ id: "i0", title: "재고 차감", badge: "o" }];
  };
  await reconcileTick(deps);
  const sent = JSON.parse(deps.calls.stage[0]);
  assert.deepEqual(sent.args.ledger, [{ id: "i0", title: "재고 차감", badge: "o" }], "exec-stage args.ledger 주입됨(id 포함)");
  assert.equal(sent.stage, "classify");
});

test("reconcileTick — classify 결과 {dimension,assignments} → 각 항목 node.edit(category) + dimension→덩어리 result", async () => {
  const nodes = [{ id: "classify", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"classify"}' }];
  const staged = { children: [], result: { dimension: "기능 영역", assignments: [{ id: "i0", category: "재고" }, { id: "i1", category: "발주" }] } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [{ id: "i0", title: "차감", badge: "o" }, { id: "i1", title: "발주", badge: "o" }];
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.equal(r.stage, true);
  assert.equal(r.assigned, 2, "assignment 2개 → node.edit(category) 2회");
  const e0 = deps.calls.edit.find((e) => e.id === "i0");
  assert.deepEqual(e0.fields, { category: "재고" }, "항목 i0 에 category 부여(reparent 아님 — 메타만)");
  const e1 = deps.calls.edit.find((e) => e.id === "i1");
  assert.deepEqual(e1.fields, { category: "발주" });
  const chunkEdit = deps.calls.edit.find((e) => e.id === "chunk");
  assert.equal(chunkEdit.fields.result, "기능 영역", "dimension → 덩어리 result");
  const done = deps.calls.edit.find((e) => e.id === "classify");
  assert.equal(done.fields.status, "done", "classify task done(멱등)");
  assert.equal(deps.calls.poke, 1);
  assert.equal(deps.calls.add.length, 0, "classify 는 노드 발행 0(기존 항목에 메타만)");
});

test("reconcileTick — classify 는 재실행 가드 없음(멱등키 부재; 항목 발행 0이라 중복 없음) — 정상 실행", async () => {
  // classify 는 노드를 발행하지 않고 기존 항목에 category 메타만 부여 → 재실행해도 같은 category 재기록(무해).
  // generate/hunt 처럼 발행-완료 마커가 필요 없다(중복 발행 위험 0). 항상 execStage 실행.
  const nodes = [
    { id: "classify", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"classify"}' },
    { id: "i0", kind: "item", status: "todo", parentId: "chunk", badge: "o", category: "재고" }, // 이미 분류된 항목(재진입)
  ];
  const staged = { children: [], result: { dimension: "기능 영역", assignments: [{ id: "i0", category: "재고" }] } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [{ id: "i0", title: "차감", badge: "o", category: "재고" }];
  const r = await reconcileTick(deps);
  assert.equal(deps.calls.stage.length, 1, "classify 는 항상 execStage 실행(발행 마커 가드 없음)");
  assert.equal(r.assigned, 1, "재배정(같은 category 재기록 — 무해)");
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

test("reconcileTick — hunt 재진입: 추가항목 이미 발행됐으면 execStage 재실행·중복 0 (② hunt 멱등 가드)", async () => {
  // hunt 가 추가항목(덩어리 직속 item)을 발행한 뒤 status=done commit 직전 실패/크래시 → 재pick.
  // 덩어리 직속 item 자식이 있으면 hunt 발행 완료(generate 항목은 그룹 밑이라 덩어리 직속 아님) →
  // exec-stage(hunt) 재실행·추가항목 중복 발행 차단(generate 와 같은 마커 패턴).
  const nodes = [
    { id: "hunt", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"hunt"}' },
    { id: "add0", kind: "item", status: "todo", parentId: "chunk", badge: "검수전", blockedBy: [] }, // hunt 가 발행한 추가항목(덩어리 직속)
  ];
  const staged = { children: [{ ev: "add", id: "add0", kind: "item", parent: "chunk", title: "중복 추가!", prompt: "v", badge: "검수전" }], result: {} };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [{ title: "x", badge: "o" }];
  const r = await reconcileTick(deps);
  assert.equal(deps.calls.stage.length, 0, "추가항목 마커 있으면 exec-stage(hunt) 재실행 안 함");
  assert.equal(deps.calls.add.length, 0, "추가항목 중복 발행 0");
  const done = deps.calls.edit.find((e) => e.id === "hunt");
  assert.equal(done.fields.status, "done", "재진입은 status=done 만 멱등 재확정");
  assert.equal(r.ok, true);
});

test("reconcileTick — hunt 첫 실행(추가항목 없음)은 정상 실행(가드 오발 없음)", async () => {
  // 덩어리 직속 item(hunt 추가항목) 마커가 없으면 hunt 미실행 → 정상 ledger materialize + execStage.
  // generate 항목은 그룹 밑이라 덩어리 직속 item 이 아니므로 마커 오발 없음.
  const nodes = [
    { id: "hunt", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"hunt"}' },
    { id: "g0", kind: "group", status: "todo", parentId: "chunk" },
    { id: "g0i0", kind: "item", status: "todo", parentId: "g0", badge: "o" }, // generate 항목(그룹 밑) — 덩어리 직속 아님
  ];
  const deps = fakeDeps(nodes, null, { children: [], result: null });
  deps.materializeLedger = async () => [{ title: "x", badge: "o" }];
  await reconcileTick(deps);
  assert.equal(deps.calls.stage.length, 1, "추가항목 마커 없으면 hunt 정상 실행");
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

// ── 프롬프트 정규화(콘텐츠 주소화) ──

test("buildAddParams — 정규화 item(promptRole+vars)은 body={promptHash,vars,schema}(완성 프롬프트 안 박음)", () => {
  const roleToHash = new Map([["verify", "abc123"]]);
  const ev = { kind: "item", prompt_role: "verify", vars: { title: "T" }, schema: { type: "object" }, title: "요건", badge: "검수전" };
  const p = buildAddParams(ev, "gid", [], undefined, roleToHash);
  const body = JSON.parse(p.body);
  assert.equal(body.promptHash, "abc123", "role→hash 치환");
  assert.deepEqual(body.vars, { title: "T" });
  assert.ok(body.schema, "schema 유지");
  assert.equal(body.prompt, undefined, "완성 프롬프트 안 박음(참조만)");
  assert.equal(p.badge, "검수전");
});

test("buildAddParams — 정규화 item varRefs → body.refs(role→hash): directive 콘텐츠 주소 참조(vars 에 텍스트 안 박음)", () => {
  const roleToHash = new Map([["verify", "hT"], ["directive", "hD"]]);
  const ev = { kind: "item", prompt_role: "verify", vars: { title: "T", category: "재고" }, var_refs: { directive: "directive" }, title: "요건", badge: "검수전" };
  const p = buildAddParams(ev, "gid", [], undefined, roleToHash);
  const body = JSON.parse(p.body);
  assert.equal(body.promptHash, "hT");
  assert.deepEqual(body.vars, { title: "T", category: "재고" }, "작은 per-item 값만 인라인");
  assert.deepEqual(body.refs, { directive: "hD" }, "directive 는 hash 참조(항목마다 복붙 X)");
  assert.equal(body.vars.directive, undefined, "directive 텍스트가 vars 에 없음");
});

test("buildAddParams — item schema_ref → body.schemaHash(콘텐츠 주소, 인라인 schema 47× 복붙 제거)", () => {
  const roleToHash = new Map([["verify", "hT"], ["schema", "hS"]]);
  const ev = { kind: "item", prompt_role: "verify", vars: { title: "T" }, schema_ref: "schema", title: "요건", badge: "검수전" };
  const p = buildAddParams(ev, "gid", [], undefined, roleToHash);
  const body = JSON.parse(p.body);
  assert.equal(body.schemaHash, "hS", "schemaRef→schemaHash");
  assert.equal(body.schema, undefined, "인라인 schema 안 박음(1행 참조)");
});

test("buildAddParams — schema_ref 없으면 인라인 schema(하위호환)", () => {
  const ev = { kind: "item", prompt_role: "verify", vars: {}, schema: { type: "object" }, title: "요건" };
  const p = buildAddParams(ev, "gid", [], undefined, new Map([["verify", "hT"]]));
  const body = JSON.parse(p.body);
  assert.deepEqual(body.schema, { type: "object" }, "하위호환: 인라인 schema 유지");
  assert.equal(body.schemaHash, undefined);
});

test("buildAddParams — promptRole 없으면 기존 {prompt}(하위호환)", () => {
  const ev = { kind: "item", prompt: "완성 프롬프트", schema: { x: 1 } };
  const p = buildAddParams(ev, "gid", [], undefined, new Map());
  const body = JSON.parse(p.body);
  assert.equal(body.prompt, "완성 프롬프트", "하위호환: prompt 그대로");
  assert.equal(body.promptHash, undefined);
});

test("registerPromptTemplates — {role:text} → prompt.put → role→hash 맵", async () => {
  const puts = [];
  const putPrompt = async (text) => { puts.push(text); return { ok: true, hash: "h_" + text.length }; };
  const reg = await registerPromptTemplates({ verify: "VVV", hunt: "HH" }, putPrompt);
  assert.equal(reg.get("verify"), "h_3");
  assert.equal(reg.get("hunt"), "h_2");
  assert.equal(puts.length, 2, "각 템플릿 1회 등록");
});

test("reconcileTick — 정규화 item(promptHash) 은 prompt.resolve 로 조립 후 exec-one", async () => {
  const resolved = [];
  const deps = {
    listNodes: async () => ({ nodes: [{ id: "i1", kind: "item", badge: "검수전" }] }),
    getNode: async () => ({ node: { body: JSON.stringify({ promptHash: "H1", vars: { title: "슬롯" }, schema: { x: 1 } }) } }),
    resolvePrompt: async (hash, vars) => { resolved.push([hash, vars]); return { ok: true, prompt: "완성:" + vars.title }; },
    execOne: async (body) => { const b = JSON.parse(body); return { oxf: "o", result: "ok", _execPrompt: b.prompt }; },
    editNode: async () => {},
    poke: async () => {},
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.deepEqual(resolved[0], ["H1", { title: "슬롯" }], "promptHash+vars 로 resolve");
  // exec-one 이 받은 body 는 조립된 완성 prompt(+schema)
});

test("reconcileTick — 정규화 item refs 를 prompt.resolve 로 전달(directive 콘텐츠 주소 deref)", async () => {
  const resolved = [];
  const deps = {
    listNodes: async () => ({ nodes: [{ id: "i1", kind: "item", badge: "검수전" }] }),
    getNode: async () => ({ node: { body: JSON.stringify({ promptHash: "H1", vars: { title: "슬롯" }, refs: { directive: "hD" } }) } }),
    resolvePrompt: async (hash, vars, refs) => { resolved.push([hash, vars, refs]); return { ok: true, prompt: "완성" }; },
    execOne: async () => ({ oxf: "o", result: "ok" }),
    editNode: async () => {},
    poke: async () => {},
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.deepEqual(resolved[0], ["H1", { title: "슬롯" }, { directive: "hD" }], "hash+vars+refs 전달(directive deref)");
});

test("reconcileTick — item schemaHash 를 getPrompt 로 deref+parse → exec-one schema", async () => {
  const execd = [];
  const deps = {
    listNodes: async () => ({ nodes: [{ id: "i1", kind: "item", badge: "검수전" }] }),
    getNode: async () => ({ node: { body: JSON.stringify({ promptHash: "H1", vars: {}, schemaHash: "hS" }) } }),
    resolvePrompt: async () => ({ ok: true, prompt: "완성 프롬프트" }),
    getPrompt: async (hash) => (hash === "hS" ? { ok: true, value: { type: "object", required: ["oxf"] } } : { ok: true, value: null }),
    execOne: async (body) => { execd.push(JSON.parse(body)); return { oxf: "o", result: "ok" }; },
    editNode: async () => {},
    poke: async () => {},
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.deepEqual(execd[0].schema, { type: "object", required: ["oxf"] }, "schemaHash deref+parse → exec-one schema");
  assert.equal(execd[0].prompt, "완성 프롬프트");
});

test("reconcileTick — 평탄 정규화 item vars 를 노드 필드(title/description)에서 조립(category 없음 — 부모 그룹 없음)", async () => {
  const resolved = [];
  const deps = {
    listNodes: async () => ({ nodes: [
      { id: "chunk", kind: "chunk", title: "덩어리" },
      { id: "i1", kind: "item", badge: "검수전", parentId: "chunk" }, // 평탄: 덩어리 직속(그룹 없음)
    ] }),
    getNode: async () => ({ node: { title: "슬롯≠재고", description: "슬롯은 위치", parentId: "chunk", body: JSON.stringify({ promptHash: "H1", refs: { directive: "hD" } }) } }),
    resolvePrompt: async (hash, vars, refs) => { resolved.push([hash, vars, refs]); return { ok: true, prompt: "완성" }; },
    execOne: async () => ({ oxf: "o", result: "ok" }),
    editNode: async () => {},
    poke: async () => {},
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.deepEqual(
    resolved[0],
    ["H1", { title: "슬롯≠재고", description: "슬롯은 위치" }, { directive: "hD" }],
    "vars(title/description←노드 필드) 소비 시점 조립 — category 없음(검증 시점 미분류; VERIFY_TMPL 에 {{category}} 없음), refs 유지",
  );
});

test("reconcileTick — 하위호환: promptHash 없는 body 는 그대로 exec-one(resolve 안 함)", async () => {
  let resolveCalled = false;
  const deps = {
    listNodes: async () => ({ nodes: [{ id: "i1", kind: "item", badge: "검수전" }] }),
    getNode: async () => ({ node: { body: JSON.stringify({ prompt: "옛 완성", schema: { x: 1 } }) } }),
    resolvePrompt: async () => { resolveCalled = true; return { ok: true, prompt: "X" }; },
    execOne: async (body) => { assert.equal(JSON.parse(body).prompt, "옛 완성", "옛 body 그대로"); return { oxf: "o", result: "ok" }; },
    editNode: async () => {},
    poke: async () => {},
  };
  await reconcileTick(deps);
  assert.equal(resolveCalled, false, "promptHash 없으면 resolve 안 함");
});

test("reconcileTick — 정규화 item 템플릿 미발견 시 안전 실패(ok:false, 노드 미변경)", async () => {
  const edits = [];
  const deps = {
    listNodes: async () => ({ nodes: [{ id: "i1", kind: "item", badge: "검수전" }] }),
    getNode: async () => ({ node: { body: JSON.stringify({ promptHash: "MISSING", vars: {} }) } }),
    resolvePrompt: async () => ({ ok: false, prompt: null }), // 미발견
    execOne: async (body) => {
      // resolve 실패 → body 그대로({promptHash,...}) → exec-one 이 prompt 없어 throw(실제 exec_one.rs). fake 로 재현.
      const b = JSON.parse(body);
      if (!b.prompt) throw new Error("exec-one 입력에 prompt 필수");
      return { oxf: "o" };
    },
    editNode: async (id, e) => edits.push(e),
    poke: async () => {},
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false, "미발견 → 안전 실패(backoff 대상)");
  assert.equal(edits.length, 0, "노드 미변경(멱등)");
});

// ── generate-skeleton 인자 조립(workflow.run idea 배선의 순수부) ──
test("genSkeletonArgs — idea 만: generate-skeleton --idea --lang ko", () => {
  assert.deepEqual(genSkeletonArgs({ idea: "약국 SaaS" }), ["generate-skeleton", "--idea", "약국 SaaS", "--lang", "ko"]);
});

test("genSkeletonArgs — model/refs/gen-out 추가 + lang 오버라이드", () => {
  const args = genSkeletonArgs({ idea: "novel", model: "glm-5.2", refs: "/cc/references", genOut: "/o/gen.js", lang: "en" });
  assert.deepEqual(args, ["generate-skeleton", "--idea", "novel", "--lang", "en", "--model", "glm-5.2", "--refs", "/cc/references", "--gen-out", "/o/gen.js"]);
});

test("genSkeletonArgs — idea 없으면 throw(발행 오입력 차단)", () => {
  assert.throws(() => genSkeletonArgs({ model: "x" }), /idea 필수/);
});

// ── DraftDoc(id 기반 정규형) relay: validateDraftDoc(JS 미러) + applyDraftDoc(prompt.put+node.add) ──

/** 정상 DraftDoc — Rust draft_doc build 산출 미러(snake_case wire). **평탄**(category 없음, task 3개 hunt→classify→audit). validate 통과 형태. */
function goodDraftDoc() {
  return {
    kind: "draft-chunk",
    chunk_ref: "chunk",
    verify_contract: {
      template: "VERIFY_TMPL {{title}} {{directive}}",
      directive: "약국 SaaS 지시어",
      schema: { type: "object", required: ["oxf", "origin"], properties: { oxf: { type: "string" } } },
      initial_badge: "검수전",
    },
    requirements: [
      { id: "i0", title: "재고 차감", description: "판매 시 차감", origin: "user", badge: "검수전" },
      { id: "i1", title: "유통기한 경고", description: "만료 임박", origin: "agent", badge: "검수전" },
    ],
    tasks: [
      { id: "hunt", stage: "hunt", blocked_by: ["i0", "i1"] },
      { id: "classify", stage: "classify", blocked_by: ["i0", "i1", "hunt"] },
      { id: "audit", stage: "audit", blocked_by: ["i0", "i1", "hunt", "classify"] },
    ],
  };
}

test("validateDraftDoc — 정상 문서는 위반 0(통과)", () => {
  assert.deepEqual(validateDraftDoc(goodDraftDoc()), []);
});

test("validateDraftDoc — ① id 중복 검출", () => {
  const d = goodDraftDoc();
  d.requirements[1].id = "i0"; // 중복
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[①]")), v.join(","));
});

test("validateDraftDoc — 평탄: category_id 없음(요건에 분류 슬롯 X — category FK 규칙 제거)", () => {
  const d = goodDraftDoc();
  // 평탄 요건은 category_id 를 안 가진다(분류는 classify 가 나중에 node.edit). 임의 category_id 를 얹어도 검증 대상 아님(통과).
  d.requirements[0].category_id = "gX";
  assert.deepEqual(validateDraftDoc(d), [], "평탄엔 category FK 규칙 없음 — 임의 category_id 무시(통과)");
});

test("validateDraftDoc — ② blocked_by FK 위반 검출", () => {
  const d = goodDraftDoc();
  d.tasks[0].blocked_by = ["nope"];
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[②]") && x.includes("blocked_by")), v.join(","));
});

test("validateDraftDoc — ③ 빈 title/description·잘못된 origin 검출", () => {
  const d = goodDraftDoc();
  d.requirements[0].title = "";
  d.requirements[1].origin = "made-up";
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[③]") && x.includes("title")), v.join(","));
  assert.ok(v.some((x) => x.includes("[③]") && x.includes("origin")), v.join(","));
});

test("validateDraftDoc — ⑤ hunt/audit 트리 위반 검출", () => {
  const d = goodDraftDoc();
  d.tasks[0].blocked_by = ["i0"]; // hunt 이 전 요건 아님
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[⑤]") && x.includes("hunt")), v.join(","));
});

test("validateDraftDoc — ⑤ classify 트리 위반 검출(hunt 후행)", () => {
  const d = goodDraftDoc();
  d.tasks.find((t) => t.stage === "classify").blocked_by = ["i0", "i1"]; // hunt 빠짐
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[⑤]") && x.includes("classify")), v.join(","));
});

test("validateDraftDoc — ⑤ audit 트리 위반 검출(hunt∪classify 후행)", () => {
  const d = goodDraftDoc();
  d.tasks.find((t) => t.stage === "audit").blocked_by = ["i0", "i1", "hunt"]; // classify 빠짐
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[⑤]") && x.includes("audit")), v.join(","));
});

test("validateDraftDoc — ⑦ 빈 requirements 검출(평탄: categories 규칙 없음)", () => {
  const d = goodDraftDoc();
  d.requirements = [];
  d.tasks = [];
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[⑦]") && x.includes("requirements")), v.join(","));
});

/** applyDraftDoc 테스트용 deps — putPrompt(값→고정 hash 매핑), addNode(순번 칸반 id), editNode 기록. */
function draftDeps() {
  const calls = { put: [], add: [], edit: [] };
  const hashOf = new Map();
  let hn = 0;
  return {
    calls,
    putPrompt: async (value) => {
      const key = typeof value === "string" ? value : JSON.stringify(value);
      if (!hashOf.has(key)) hashOf.set(key, "h" + ++hn);
      calls.put.push(value);
      return { ok: true, hash: hashOf.get(key) };
    },
    addNode: async (params) => {
      calls.add.push(params);
      return "k-" + calls.add.length;
    },
    editNode: async (id, fields) => {
      calls.edit.push({ id, fields });
      return { ok: true };
    },
    poke: async () => {},
  };
}

test("applyDraftDoc — verify_contract 3값 prompt.put → 요건 body={promptHash,refs.directive,schemaHash}", async () => {
  const deps = draftDeps();
  const doc = goodDraftDoc();
  const published = await applyDraftDoc(deps, doc, "k-chunk", undefined);
  // put 3회(template/directive/schema).
  assert.equal(deps.calls.put.length, 3, "verify_contract 3값 put");
  // 발행(평탄): 그룹 0 + item2 + task3(hunt/classify/audit) = 5.
  assert.equal(published, 5);
  assert.equal(deps.calls.add.length, 5);
  assert.equal(deps.calls.add.filter((p) => p.kind === "group").length, 0, "평탄: 그룹 발행 0");
  const item = deps.calls.add.find((p) => p.kind === "item");
  const body = JSON.parse(item.body);
  assert.ok(body.promptHash, "item body 에 promptHash(=template hash)");
  assert.ok(body.refs && body.refs.directive, "item body refs.directive(콘텐츠 주소)");
  assert.ok(body.schemaHash, "item body schemaHash(콘텐츠 주소)");
  assert.equal(body.vars, undefined, "vars 는 소비 시점 노드 필드로 조립 — body 에 안 박음");
  assert.equal(body.schema, undefined, "인라인 schema 없음(정규화)");
});

test("applyDraftDoc — 요건 노드 필드(title/description/origin/badge)+평탄 부모=덩어리 칸반 id(그룹 없음)", async () => {
  const deps = draftDeps();
  await applyDraftDoc(deps, goodDraftDoc(), "k-chunk", undefined);
  assert.equal(deps.calls.add.filter((p) => p.kind === "group").length, 0, "평탄: 그룹 노드 없음");
  const item0 = deps.calls.add.filter((p) => p.kind === "item")[0];
  assert.equal(item0.title, "재고 차감");
  assert.equal(item0.description, "판매 시 차감");
  assert.equal(item0.origin, "user");
  assert.equal(item0.badge, "검수전");
  assert.equal(item0.category, undefined, "평탄: generate 항목엔 category 없음(classify 가 나중에 부여)");
  assert.equal(item0.parentId, "k-chunk", "item parent = 덩어리 칸반 id 직속(그룹 없음)");
});

test("applyDraftDoc — hunt/classify/audit blockedBy 를 DraftDoc id→칸반 id 해석(트리 순서)", async () => {
  const deps = draftDeps();
  await applyDraftDoc(deps, goodDraftDoc(), "k-chunk", undefined);
  // 평탄: item i0=k-1, i1=k-2, hunt=k-3, classify=k-4, audit=k-5.
  const hunt = deps.calls.add.find((p) => p.kind === "task" && p.title === "hunt");
  assert.deepEqual(hunt.blockedBy, ["k-1", "k-2"], "hunt blockedBy = 항목 칸반 id");
  const classify = deps.calls.add.find((p) => p.kind === "task" && p.title === "classify");
  assert.deepEqual(classify.blockedBy, ["k-1", "k-2", "k-3"], "classify blockedBy = 항목 + hunt 칸반 id");
  const audit = deps.calls.add.find((p) => p.kind === "task" && p.title === "audit");
  assert.deepEqual(audit.blockedBy, ["k-1", "k-2", "k-3", "k-4"], "audit blockedBy = 항목 + hunt + classify 칸반 id");
});

test("applyDraftDoc — taskCtx 있으면 hunt/audit body 에 skeleton 임베드(exec-stage 입력)", async () => {
  const deps = draftDeps();
  const ctx = { skeleton: { program: { type: "Program" } }, directive: "약국 SaaS" };
  await applyDraftDoc(deps, goodDraftDoc(), "k-chunk", ctx);
  const hunt = deps.calls.add.find((p) => p.kind === "task" && p.title === "hunt");
  const body = JSON.parse(hunt.body);
  assert.ok(body.skeleton, "task body 에 skeleton 임베드");
  assert.equal(body.stage, "hunt");
  assert.equal(body.args.chunkRef, "k-chunk");
  assert.equal(body.args.directive, "약국 SaaS");
});

test("applyDraftDoc — chunk_title 있으면 덩어리 title 갱신", async () => {
  const deps = draftDeps();
  const doc = goodDraftDoc();
  doc.chunk_title = "약국 재고 SaaS";
  await applyDraftDoc(deps, doc, "k-chunk", undefined);
  const chunkEdit = deps.calls.edit.find((e) => e.id === "k-chunk");
  assert.equal(chunkEdit.fields.title, "약국 재고 SaaS");
});

test("reconcileTick — generate DraftDoc: validate 통과 → applyDraftDoc 발행 + status=done + poke", async () => {
  const nodes = [{ id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: "chunk-7", body: '{"stage":"generate"}' }];
  const deps = fakeDeps(nodes, null, null);
  // execStage 가 DraftDoc(단일 문서) 반환.
  deps.execStage = async (body) => {
    deps.calls.stage.push(body);
    return { draftDoc: { ...goodDraftDoc(), chunk_ref: "chunk-7", chunk_title: "약국 SaaS" } };
  };
  // applyDraftDoc 용 putPrompt.
  let hn = 0;
  deps.putPrompt = async () => ({ ok: true, hash: "h" + ++hn });
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  assert.equal(r.stage, true);
  assert.equal(r.published, 5, "평탄: item2+task3(hunt/classify/audit) 발행");
  assert.equal(deps.calls.add.length, 5, "DraftDoc 순회 node.add");
  const doneEdit = deps.calls.edit.find((e) => e.id === "gen");
  assert.equal(doneEdit.fields.status, "done", "generate task done(멱등)");
  const chunkEdit = deps.calls.edit.find((e) => e.id === "chunk-7");
  assert.equal(chunkEdit.fields.title, "약국 SaaS", "덩어리 title=chunk_title");
  assert.equal(deps.calls.poke, 1);
});

test("reconcileTick — generate DraftDoc 검증 실패면 발행 거부(ok:false·노드 미변경·backoff)", async () => {
  const nodes = [{ id: "gen", kind: "task", status: "todo", blockedBy: [], parentId: "chunk-7", body: '{"stage":"generate"}' }];
  const deps = fakeDeps(nodes, null, null);
  deps.execStage = async () => ({ draftDoc: { ...goodDraftDoc(), requirements: [] } }); // ⑦(requirements≥1)·⑤(hunt.blockedBy≠전 요건) 위반
  deps.putPrompt = async () => ({ ok: true, hash: "h1" });
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false, "위반 문서 발행 거부");
  assert.equal(deps.calls.add.length, 0, "발행 0(거부)");
  assert.equal(deps.calls.edit.length, 0, "노드 미변경(status todo 유지 → backoff)");
});

// ── M1 결함 수정 — hunt 멱등 마커(평탄), 무판정 상한, 기아 방지, classify 배정 검증, spawn/secretEnv 조립 ──

test("reconcileTick — 평탄: hunt 첫 진입은 execStage 실행(blockedBy 항목=generate 발행분은 마커 아님 — 오발 수정)", async () => {
  // 평탄화(28febc9) 후 generate 항목도 덩어리 직속 item — "직속 item 존재"를 마커로 쓰면 hunt 첫 진입부터
  // 항상 참이 되어 hunt 가 영영 실행되지 않는다(침묵). hunt.blockedBy(=generate 항목 칸반 id 동결 집합)에
  // 속한 항목은 마커에서 제외 — blockedBy 밖 직속 item 만 hunt 발행분이다.
  const nodes = [
    { id: "hunt", kind: "task", status: "todo", parentId: "chunk", blockedBy: ["i1", "i2"], body: '{"stage":"hunt"}' },
    { id: "i1", kind: "item", status: "todo", parentId: "chunk", badge: "o", blockedBy: [] },
    { id: "i2", kind: "item", status: "todo", parentId: "chunk", badge: "x", blockedBy: [] },
  ];
  const deps = fakeDeps(nodes, null, { children: [], result: null });
  deps.materializeLedger = async () => [
    { id: "i1", title: "a", badge: "o" },
    { id: "i2", title: "b", badge: "x" },
  ];
  await reconcileTick(deps);
  assert.equal(deps.calls.stage.length, 1, "직속 item 이 전부 blockedBy(generate 발행분)면 hunt 는 미발행 — 실행돼야 함");
});

test("reconcileTick — 평탄: hunt 재진입(blockedBy 밖 직속 item=추가항목 존재)은 execStage 없이 done 멱등", async () => {
  const nodes = [
    { id: "hunt", kind: "task", status: "todo", parentId: "chunk", blockedBy: ["i1"], body: '{"stage":"hunt"}' },
    { id: "i1", kind: "item", status: "todo", parentId: "chunk", badge: "o", blockedBy: [] },
    { id: "add0", kind: "item", status: "todo", parentId: "chunk", badge: "검수전", blockedBy: [] }, // hunt 발행 추가항목
  ];
  const deps = fakeDeps(nodes, null, { children: [], result: null });
  deps.materializeLedger = async () => [];
  const r = await reconcileTick(deps);
  assert.equal(deps.calls.stage.length, 0, "추가항목(blockedBy 밖) 존재 = 발행 완료 마커 → 재실행 안 함");
  const done = deps.calls.edit.find((e) => e.id === "hunt");
  assert.equal(done.fields.status, "done", "status=done 멱등 재확정");
  assert.equal(r.ok, true);
});

test("reconcileTick — 무판정 연속 3회면 badge=f 확정(무한 LLM 재실행 루프 유한화, fail-loud)", async () => {
  // 무판정 result 기록이 kanban:changed → poke → 같은 항목 재선택 → LLM 재실행 무한 루프가 될 수 있다.
  // 상한(3회) 도달 시 f 확정 — 원인(스키마 부재/모델 이탈)을 result 로 표면화, 체인은 f(done)로 풀린다.
  const nodes = [{ id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"x"}' }];
  const st = makeReconcileState();
  const mk = () => fakeDeps(nodes, { oxf: null, result: "무판정 출력" });
  const d1 = mk();
  const r1 = await reconcileTick(d1, st);
  assert.equal(r1.badge, null);
  assert.equal(d1.calls.edit[0].fields.badge, undefined, "1회: badge 미변경(result 만)");
  assert.equal(d1.calls.poke, 0, "1회: self-poke 억제 유지");
  const d2 = mk();
  await reconcileTick(d2, st);
  assert.equal(d2.calls.edit[0].fields.badge, undefined, "2회: badge 미변경");
  const d3 = mk();
  const r3 = await reconcileTick(d3, st);
  assert.equal(d3.calls.edit[0].fields.badge, "f", "3회: 자동 f 확정");
  assert.match(d3.calls.edit[0].fields.result, /무판정 3회/, "원인 표면화(result)");
  assert.equal(d3.calls.poke, 1, "f 확정=진척 → poke");
  assert.equal(r3.badge, "f");
});

test("reconcileTick — 무판정 카운터는 판정 성공 시 리셋(간헐 무판정이 f 로 오확정되지 않음)", async () => {
  const nodes = [{ id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"x"}' }];
  const st = makeReconcileState();
  await reconcileTick(fakeDeps(nodes, { oxf: null, result: "무판정" }), st); // 1회 무판정
  await reconcileTick(fakeDeps(nodes, { oxf: null, result: "무판정" }), st); // 2회 무판정
  const dOk = fakeDeps(nodes, { oxf: "o", result: "판정" });
  await reconcileTick(dOk, st); // 판정 성공 → 카운터 리셋
  assert.equal(dOk.calls.edit[0].fields.badge, "o");
  // 다시 무판정 2회 — 리셋됐으므로 f 확정(3회 도달) 아님.
  const d4 = fakeDeps(nodes, { oxf: null, result: "무판정" });
  await reconcileTick(d4, st);
  assert.equal(d4.calls.edit[0].fields.badge, undefined, "리셋 후 1회째 — f 아님");
});

test("reconcileTick — 연속 실패 노드는 뒤로: ready 중 실패 최소 노드 선택(head-of-line 기아 방지)", async () => {
  const nodes = [
    { id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"a"}' },
    { id: "n2", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"b"}' },
  ];
  const st = makeReconcileState();
  const deps1 = fakeDeps(nodes, null);
  deps1.execOne = async () => {
    throw new Error("영구 실패(promptHash 미발견 등)");
  };
  const r1 = await reconcileTick(deps1, st);
  assert.equal(r1.ok, false);
  assert.equal(r1.id, "n1", "첫 틱은 ready[0]=n1");
  const deps2 = fakeDeps(nodes, { oxf: "o", result: "ok" });
  const r2 = await reconcileTick(deps2, st);
  assert.equal(r2.id, "n2", "n1 실패 기록 → 다음 틱은 n2(실패 0) 선택 — n1 이 큐를 못 막음");
  assert.equal(r2.badge, "o");
});

test("reconcileTick — classify 원장 밖 id(환각)는 전량 거부: category edit 0 + ok:false(backoff 재시도)", async () => {
  // LLM 환각 id 를 그대로 node.edit 하면 칸반 resolve 가 key(대소문자 무시)까지 매칭해 무관 노드를 오염시킬 수 있다.
  const nodes = [{ id: "classify", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"classify"}' }];
  const staged = { children: [], result: { dimension: "d", assignments: [{ id: "i0", category: "재고" }, { id: "ghost", category: "유령" }] } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [{ id: "i0", title: "차감", badge: "o" }];
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /원장 밖 id: ghost/);
  assert.equal(deps.calls.edit.length, 0, "부분 적용 0 — category edit·status done 없음");
});

test("reconcileTick — classify 중복 배정 거부", async () => {
  const nodes = [{ id: "classify", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"classify"}' }];
  const staged = { children: [], result: { dimension: "d", assignments: [{ id: "i0", category: "재고" }, { id: "i0", category: "발주" }] } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [{ id: "i0", title: "차감", badge: "o" }];
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /중복 배정: i0/);
  assert.equal(deps.calls.edit.length, 0);
});

test("reconcileTick — classify 미배정(원장 커버 미달) 거부 — 전 요건 정확히 1회 배정 계약", async () => {
  const nodes = [{ id: "classify", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"classify"}' }];
  const staged = { children: [], result: { dimension: "d", assignments: [{ id: "i0", category: "재고" }] } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [
    { id: "i0", title: "차감", badge: "o" },
    { id: "i1", title: "발주", badge: "o" },
  ];
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /미배정: i1/);
  assert.equal(deps.calls.edit.length, 0);
});

test("reconcileTick — classify category 기록 실패(editNode ok:false)는 성공 위장 없이 ok:false", async () => {
  const nodes = [{ id: "classify", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"classify"}' }];
  const staged = { children: [], result: { dimension: "d", assignments: [{ id: "i0", category: "재고" }] } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [{ id: "i0", title: "차감", badge: "o" }];
  const base = deps.editNode;
  deps.editNode = async (id, fields) => {
    await base(id, fields);
    return fields.category ? { ok: false, error: "거부" } : { ok: true };
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /category 기록 실패\(i0\)/);
});

test("buildSecretEnvMap — env:* 키만 envVar→secretKey 매핑(그 외·빈 키 무시, 비배열 안전)", () => {
  assert.deepEqual(buildSecretEnvMap(["env:ANTHROPIC_BASE_URL", "env:ANTHROPIC_AUTH_TOKEN", "other", "env:"]), {
    ANTHROPIC_BASE_URL: "env:ANTHROPIC_BASE_URL",
    ANTHROPIC_AUTH_TOKEN: "env:ANTHROPIC_AUTH_TOKEN",
  });
  assert.deepEqual(buildSecretEnvMap(null), {});
  assert.deepEqual(buildSecretEnvMap([]), {});
});

test("buildSpawnCmd — bin 명시면 직접 spawn, 없으면 로그인셸 랩(단일 폴더 컨벤션 + SOKSAK_WORKFLOW_BIN 오버라이드)", () => {
  // 플러그인은 Blob 로드라 자기 경로 불명 + GUI(Finder) 실행은 셸 PATH 미상속 → sh -l 랩이 둘 다 해소.
  assert.deepEqual(buildSpawnCmd("/x/bin/wf", ["exec-one"]), { cmd: "/x/bin/wf", args: ["exec-one"] });
  const wrapped = buildSpawnCmd(null, ["exec-one", "--lang", "ko"]);
  assert.equal(wrapped.cmd, "/bin/sh");
  assert.equal(wrapped.args[0], "-lc");
  assert.match(wrapped.args[1], /SOKSAK_WORKFLOW_BIN/, "env 오버라이드 지원");
  assert.match(wrapped.args[1], /\.soksak\/plugins\/soksak-plugin-workflow/, "단일 폴더 플러그인 컨벤션 기본 경로");
  assert.deepEqual(wrapped.args.slice(3), ["exec-one", "--lang", "ko"], '실제 인자는 "$@" 로 전달($0 자리 다음)');
});

test("validateDraftDoc — ⑧ 비enum badge 거부(칸반 드랍→영구 not-done 무음 정지 차단)", () => {
  const d = goodDraftDoc();
  d.requirements[0].badge = "pending";
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[⑧]") && x.includes("pending")), v.join(","));
  const d2 = goodDraftDoc();
  d2.verify_contract.initial_badge = "todo";
  assert.ok(validateDraftDoc(d2).some((x) => x.includes("[⑧]") && x.includes("initial_badge")));
  const d3 = goodDraftDoc();
  d3.requirements[0].badge = ""; // 빈 badge = initial_badge 폴백 — 허용
  assert.deepEqual(validateDraftDoc(d3), []);
});

test("validateDraftDoc — ⑨ 빈 verify_contract 거부(빈 계약=소비 시점 무한 backoff 로 전락 — 발행 시점 fail-loud)", () => {
  const d = goodDraftDoc();
  d.verify_contract = { template: "", directive: "", schema: null, initial_badge: "검수전" };
  const v = validateDraftDoc(d);
  assert.ok(v.some((x) => x.includes("[⑨]") && x.includes("template")), v.join(","));
  assert.ok(v.some((x) => x.includes("[⑨]") && x.includes("directive")), v.join(","));
  assert.ok(v.some((x) => x.includes("[⑨]") && x.includes("schema")), v.join(","));
});

// ── M2 인증 상태 기계 — audit complete 소비 + 원장 f 집계 → 덩어리 badge(o=인증/f=폐기) ──

test("reconcileTick — audit complete=true ∧ 원장 f=0 → 덩어리 badge='o'(인증) + verdict→result + done", async () => {
  const nodes = [{ id: "audit", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"audit"}' }];
  const staged = { children: [], result: { verdict: "완결 — 목표 도달", complete: true } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [
    { id: "i0", title: "a", badge: "o" },
    { id: "i1", title: "b", badge: "x" }, // x 는 정당한 부결(kept) — 폐기 사유 아님
  ];
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  const chunkEdit = deps.calls.edit.find((e) => e.id === "chunk");
  assert.equal(chunkEdit.fields.badge, "o", "인증 — complete ∧ f=0");
  assert.equal(chunkEdit.fields.result, "완결 — 목표 도달", "verdict → 덩어리 result");
  const done = deps.calls.edit.find((e) => e.id === "audit");
  assert.equal(done.fields.status, "done");
});

test("reconcileTick — audit 원장에 f≥1 이면 complete=true 여도 덩어리 badge='f'(폐기 — fail 전파)", async () => {
  const nodes = [{ id: "audit", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"audit"}' }];
  const staged = { children: [], result: { verdict: "감사 통과 주장", complete: true } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [
    { id: "i0", title: "a", badge: "o" },
    { id: "i1", title: "b", badge: "f" }, // 치명 실패 항목 — 어떤 노드가 원인인지는 항목 badge 가 보여줌
  ];
  const r = await reconcileTick(deps);
  assert.equal(r.ok, true);
  const chunkEdit = deps.calls.edit.find((e) => e.id === "chunk");
  assert.equal(chunkEdit.fields.badge, "f", "f≥1 → 폐기(LLM complete 주장으로 우회 불가)");
});

test("reconcileTick — audit complete=false 면 원장 f=0 이어도 badge='f'", async () => {
  const nodes = [{ id: "audit", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"audit"}' }];
  const staged = { children: [], result: { verdict: "누락 존재", complete: false } };
  const deps = fakeDeps(nodes, null, staged);
  deps.materializeLedger = async () => [{ id: "i0", title: "a", badge: "o" }];
  await reconcileTick(deps);
  const chunkEdit = deps.calls.edit.find((e) => e.id === "chunk");
  assert.equal(chunkEdit.fields.badge, "f");
  assert.equal(chunkEdit.fields.result, "누락 존재");
});

test("reconcileTick — audit 결과 없음(result null)은 ok:false — 감사 없는 완결 금지", async () => {
  const nodes = [{ id: "audit", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"audit"}' }];
  const deps = fakeDeps(nodes, null, { children: [], result: null });
  deps.materializeLedger = async () => [{ id: "i0", title: "a", badge: "o" }];
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /audit 결과 없음/);
  assert.equal(deps.calls.edit.length, 0, "chunk badge·status done 미기록(재시도 대상 유지)");
});

test("reconcileTick — classify/audit 원장 materialize 실패는 실행 전 거부(ok:false, execStage 미호출)", async () => {
  const nodes = [{ id: "audit", kind: "task", status: "todo", blockedBy: [], parentId: "chunk", body: '{"stage":"audit"}' }];
  const deps = fakeDeps(nodes, null, { children: [], result: { verdict: "v", complete: true } });
  deps.materializeLedger = async () => {
    throw new Error("kanban 응답 없음");
  };
  const r = await reconcileTick(deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /원장 materialize 실패\(audit\)/);
  assert.equal(deps.calls.stage.length, 0, "원장 없이 감사(f 집계 불가) 실행 금지");
});
