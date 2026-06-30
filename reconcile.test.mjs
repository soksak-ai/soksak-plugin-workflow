// reconcile 순수 로직 단위 테스트 — node:test(무의존). `node --test reconcile.test.mjs`.
// app 의존(spawn/commands/scheduler)은 reconcileTick 에 주입해 fake 로 검증.
import test from "node:test";
import assert from "node:assert/strict";
import { isDone, pickReady, execResultToEdit, reconcileTick } from "./main.js";

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

test("pickReady — 빈/비배열 안전", () => {
  assert.deepEqual(pickReady([]), []);
  assert.deepEqual(pickReady(null), []);
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

// reconcileTick — fake deps 로 오케스트레이션 검증.
function fakeDeps(nodes, execOut) {
  const calls = { get: [], edit: [], exec: [], poke: 0 };
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
    poke: async () => {
      calls.poke += 1;
    },
  };
}

test("reconcileTick — ready 1개 처리: get→exec→edit(badge)→poke", async () => {
  const nodes = [{ id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"verify"}' }];
  const deps = fakeDeps(nodes, { oxf: "o", result: { reason: "실재 요건" } });
  const r = await reconcileTick(deps);
  assert.equal(r.processed, 1);
  assert.equal(r.id, "n1");
  assert.equal(r.badge, "o");
  assert.deepEqual(deps.calls.get, ["n1"]);
  assert.deepEqual(deps.calls.exec, ['{"prompt":"verify"}'], "node.body 를 exec-one 에 그대로");
  assert.equal(deps.calls.edit.length, 1);
  assert.equal(deps.calls.edit[0].fields.badge, "o");
  assert.equal(deps.calls.poke, 1, "진척 시 다음 틱 poke");
});

test("reconcileTick — ready 없으면 아무것도 안 함(no exec/edit/poke)", async () => {
  const nodes = [{ id: "n1", badge: "o", blockedBy: [], parentId: null, status: "done" }];
  const deps = fakeDeps(nodes, { oxf: "o", result: {} });
  const r = await reconcileTick(deps);
  assert.equal(r.processed, 0);
  assert.equal(deps.calls.exec.length, 0);
  assert.equal(deps.calls.edit.length, 0);
  assert.equal(deps.calls.poke, 0);
});

test("reconcileTick — 무판정(oxf null)이면 result 만 기록·poke 안 함(tight loop 방지)", async () => {
  const nodes = [{ id: "n1", badge: "검수전", blockedBy: [], parentId: null, status: "todo", body: '{"prompt":"x"}' }];
  const deps = fakeDeps(nodes, { oxf: null, result: "무판정 출력" });
  const r = await reconcileTick(deps);
  assert.equal(r.processed, 1);
  assert.equal(r.badge, null);
  assert.equal(deps.calls.edit[0].fields.badge, undefined, "배지 미변경");
  assert.equal(deps.calls.poke, 0, "무판정은 self-poke 안 함");
});
