// reconcile 순수 로직 단위 테스트 — node:test(무의존). `node --test reconcile.test.mjs`.
// app 의존(spawn/commands/scheduler)은 reconcileTick 에 주입해 fake 로 검증.
import test from "node:test";
import assert from "node:assert/strict";
import { isDone, pickReady, execResultToEdit, reconcileTick, classifyResult, buildAddParams } from "./main.js";

test("isDone — status done 만 true, 미존재=false", () => {
  assert.equal(isDone({ status: "done" }), true);
  assert.equal(isDone({ status: "todo" }), false);
  assert.equal(isDone(undefined), false);
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
  assert.deepEqual(JSON.parse(p.body), { prompt: "verify…", schema: { type: "object" } }, "body=exec-one 입력");
  assert.equal(p.locked, true);
});

test("buildAddParams — 그룹(prompt 없음)은 body=ev.body, 드래프트 마커 없음", () => {
  const p = buildAddParams({ id: "g0", kind: "group", title: "재고", category: "재고" }, "chunk-7", []);
  assert.equal(p.kind, "group");
  assert.equal(p.body, "");
  assert.equal(p.badge, undefined, "그룹은 badge 없음");
  assert.equal(p.isDraft, undefined);
});

test("buildAddParams — kind=task + taskCtx → body=exec-stage 입력(skeleton 임베드)", () => {
  const ev = { id: "gen", kind: "task", title: "Generate", prompt: "generate" };
  const p = buildAddParams(ev, "k-chunk", [], { skeleton: { program: { type: "Program" } }, directive: "약국 SaaS" });
  assert.equal(p.kind, "task");
  const body = JSON.parse(p.body);
  assert.deepEqual(body.skeleton, { program: { type: "Program" } }, "skeleton 임베드(main.js, draft.js 무관여)");
  assert.equal(body.stage, "generate", "stage=ev.prompt(스테이지명)");
  assert.equal(body.args.directive, "약국 SaaS");
  assert.equal(body.args.chunkRef, "k-chunk", "chunkRef=부모(덩어리)");
  assert.equal(p.badge, undefined, "stage 작업은 badge 없음");
});

test("buildAddParams — kind=task 인데 taskCtx 없으면 일반 body(skeleton 미임베드)", () => {
  const p = buildAddParams({ id: "gen", kind: "task", prompt: "generate" }, "k1", []);
  assert.equal(JSON.parse(p.body).prompt, "generate", "taskCtx 없으면 exec-one 입력 형태로 폴백");
});

test("classifyResult — 스테이지 산출 모양으로 분기(모델 B)", () => {
  assert.equal(classifyResult({ title: "약국", groups: [] }), "generate");
  assert.equal(classifyResult({ additions: [{ title: "x" }] }), "hunt");
  assert.equal(classifyResult({ complete: true, verdict: "완결" }), "audit");
  assert.equal(classifyResult({ verdict: "미완" }), "audit");
  assert.equal(classifyResult({ status: "o", reason: "실재" }), "verify");
  assert.equal(classifyResult({ oxf: "f" }), "verify");
  assert.equal(classifyResult("raw 텍스트"), "plain");
  assert.equal(classifyResult({ foo: 1 }), "plain");
  assert.equal(classifyResult(null), "plain");
  // 우선순위: groups 가 status 보다 먼저(generate 가 우선) — 충돌 시 구조적 신호 우선.
  assert.equal(classifyResult({ groups: [], status: "o" }), "generate");
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
