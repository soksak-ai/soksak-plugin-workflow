// The rail bridge in isolation: a rail container registering under a bound view id must become
// visible to the content view subscribed under the same id, and releasing must restore the
// absent state — that turn is what moves the run list out and back. Elements are opaque to the
// bridge, so sentinels stand in for DOM nodes.
import test from "node:test";
import assert from "node:assert/strict";
import { registerRailContainer, railContainer, subscribeRail } from "../js/railBridge.js";

test("a registered container is visible under its view id, and gone after release", () => {
  const el = {};
  const off = registerRailContainer("v1", "runs", el);
  assert.equal(railContainer("v1", "runs"), el);
  assert.equal(railContainer("v1", "other"), null, "an unregistered slot stays absent");
  assert.equal(railContainer("v2", "runs"), null, "another view id never sees it");
  off();
  assert.equal(railContainer("v1", "runs"), null);
});

test("the subscriber hears the register and the release", () => {
  let fired = 0;
  const un = subscribeRail("v3", () => fired++);
  const off = registerRailContainer("v3", "runs", {});
  assert.equal(fired, 1);
  off();
  assert.equal(fired, 2);
  un();
  registerRailContainer("v3", "runs", {})();
  assert.equal(fired, 2, "an unsubscribed view must hear nothing more");
});

test("a null view id never subscribes — the inline fallback path stays inert", () => {
  const un = subscribeRail(null, () => assert.fail("must never fire"));
  registerRailContainer("v4", "runs", {})();
  un();
  assert.equal(railContainer(null, "runs"), null);
});

test("a stale release must not evict the container that replaced it", () => {
  const first = {};
  const second = {};
  const offFirst = registerRailContainer("v5", "runs", first);
  const offSecond = registerRailContainer("v5", "runs", second);
  offFirst(); // the older mount unmounts after the newer one took the slot
  assert.equal(railContainer("v5", "runs"), second);
  offSecond();
  assert.equal(railContainer("v5", "runs"), null);
});
