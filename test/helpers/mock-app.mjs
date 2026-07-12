// Test host — runs activate() without the app. app.data is an in-memory store that enforces the
// core's index rule; app.process is injectable so git can be scripted.
export function mockApp(opts = {}) {
  const registered = new Map();
  const views = new Map();
  const store = new Map();
  const indexes = new Map();
  const key = (coll, scope, id) => `${coll}\0${scope ?? "default"}\0${id}`;

  const app = {
    appVersion: "test",
    pluginId: "soksak-plugin-workflow",
    locale: () => opts.locale ?? "en",
    windowLabel: () => "w-test",
    project: { current: () => opts.project ?? null },
    commands: {
      register(name, spec) {
        registered.set(name, spec);
        return { dispose() {} };
      },
      async execute(name, params) {
        return opts.executeCommand ? opts.executeCommand(name, params) : { ok: true, code: "OK", message: "", data: {} };
      },
    },
    events: { on: () => ({ dispose() {} }), progress: () => {} },
    activity: { publish: () => {} },
    process: opts.process,
    data: {
      async define(coll, o) {
        indexes.set(coll, new Set([...(o?.indexes ?? []), "created", "updated"]));
      },
      async put(coll, doc, o) {
        const id = o?.id ?? doc.id ?? String(store.size + 1);
        store.set(key(coll, o?.scope, id), { ...doc, id });
        return id;
      },
      async get(coll, id, o) {
        return store.get(key(coll, o?.scope, id)) ?? null;
      },
      async delete(coll, id, o) {
        return store.delete(key(coll, o?.scope, id));
      },
      async query(coll, o) {
        const idx = indexes.get(coll) ?? new Set(["created", "updated"]);
        if (o?.order && !idx.has(o.order)) throw new Error(`정렬 필드가 인덱스로 선언되지 않음: ${o.order}`);
        const prefix = `${coll}\0${o?.scope ?? "default"}\0`;
        const rows = [];
        for (const [k, v] of store) if (k.startsWith(prefix)) rows.push(v);
        rows.sort((a, b) => (a[o?.order ?? "created"] ?? 0) - (b[o?.order ?? "created"] ?? 0));
        return rows;
      },
      watch: () => ({ dispose() {} }),
    },
    ui: {
      registerView(id, provider) {
        views.set(id, provider);
        return { dispose() {} };
      },
    },
  };

  const ctx = { app, manifest: opts.manifest ?? {}, subscriptions: [] };
  return { app, ctx, registered, views, store };
}

// A scripted git: handler(args) → { stdout, code }. onExit fires after onData.
export function mockProcess(handler) {
  const calls = [];
  const procs = new Map();
  let seq = 0;
  return {
    calls,
    api: {
      async spawn(cmd, args, o) {
        const id = ++seq;
        calls.push({ cmd, args, opts: o ?? {} });
        procs.set(id, handler(args) ?? { stdout: "", code: 0 });
        return id;
      },
      onData(id, cb) {
        const r = procs.get(id);
        if (r?.stdout) queueMicrotask(() => cb(new TextEncoder().encode(r.stdout)));
        return { dispose() {} };
      },
      onStderr(id, cb) {
        const r = procs.get(id);
        if (r?.stderr) queueMicrotask(() => cb(new TextEncoder().encode(r.stderr)));
        return { dispose() {} };
      },
      onExit(id, cb) {
        const r = procs.get(id);
        queueMicrotask(() => queueMicrotask(() => cb(r?.code ?? 0)));
        return { dispose() {} };
      },
      async kill(id) {
        procs.delete(id);
      },
    },
  };
}
