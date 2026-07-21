// The rail bridge — connects this plugin's rail views (containers only) to the content view
// instance they serve. The content view keeps every bit of state and DOM: when a rail container
// registers under its view id it moves the matching element there, and moves it back inline when
// the container goes away. Keyed by the bound content view's id (rail ctx.boundViewId ↔ content
// ctx.viewId — per-view instances, so the pairing is 1:1). A host without rails never registers,
// and the content view keeps its existing inline layout.

const containers = new Map(); // viewId → { [slot]: element }
const subs = new Map(); // viewId → Set<fn>

function notify(viewId) {
  for (const fn of subs.get(viewId) ?? []) fn();
}

// A rail view mount registers its container. Returns the release for its unmount. A newer
// registration for the same slot wins; the stale release must not evict the newcomer.
export function registerRailContainer(viewId, slot, el) {
  const entry = containers.get(viewId) ?? {};
  entry[slot] = el;
  containers.set(viewId, entry);
  notify(viewId);
  return () => {
    const cur = containers.get(viewId);
    if (!cur || cur[slot] !== el) return;
    delete cur[slot];
    if (Object.keys(cur).length === 0) containers.delete(viewId);
    notify(viewId);
  };
}

export function railContainer(viewId, slot) {
  if (!viewId) return null;
  return containers.get(viewId)?.[slot] ?? null;
}

// The content view subscribes for register/release turns. A null view id (sidebar placement,
// a core without the projection model) never subscribes and never fires.
export function subscribeRail(viewId, fn) {
  if (!viewId) return () => {};
  let set = subs.get(viewId);
  if (!set) {
    set = new Set();
    subs.set(viewId, set);
  }
  set.add(fn);
  return () => {
    const s = subs.get(viewId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subs.delete(viewId);
  };
}
