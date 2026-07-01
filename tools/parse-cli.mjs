#!/usr/bin/env node
// soksak-plugin-workflow 워크플로 파서 CLI — gen.js(LLM 저작 워크플로 JS) → skeleton JSON(stdout).
//
// **self-contained**: parse.js(vendored acorn) 만 의존, 추출기 불요. generate-skeleton(main.rs)이
//   `node <plugin>/tools/parse-cli.mjs <gen.js>` 로 호출한다. 옛 경로(추출기/src/cli.js parse)를 대체.
// 로직은 추출기 cli.js 의 cmdParse 와 동일(파싱 실패 시 {ok:false,error,file} 를 stderr+exit1).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { parseWorkflow } from "./parse.js";

const file = process.argv[2];
if (!file) {
  console.error("사용: node parse-cli.mjs <gen.js>");
  process.exit(1);
}
const nameFromFile = (f) => basename(f).replace(/\.(workflow|source-template)?\.?js$/, "");
const source = readFileSync(file, "utf8");
let sk;
try {
  sk = parseWorkflow(source, { name: nameFromFile(file), file: basename(file) });
} catch (e) {
  const loc = e && e.loc ? ` @${e.loc.line}:${e.loc.column}` : "";
  console.error(JSON.stringify({ ok: false, error: String(e.message || e) + loc, file: basename(file) }));
  process.exit(1);
}
sk.source.sha256 = createHash("sha256").update(source).digest("hex");
process.stdout.write(JSON.stringify(sk, null, 2) + "\n");
