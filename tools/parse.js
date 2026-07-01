// parse — 워크플로 스크립트(.js) → 추출기 워크플로 골격. acorn AST 정적 분석, 실행 0.
//   meta 블록 평가 + 본문의 phase/agent/parallel/pipeline/log/workflow 호출을 소스 순서로 추출.
//   프롬프트는 정적 fold(리터럴·const 접합은 문자열, 런타임 보간은 ${expr} 스켈레톤 + static=false).

import * as acorn from "./vendor/acorn.mjs";

const ORCH = new Set(["phase", "agent", "parallel", "pipeline", "log", "workflow"]);

// ── AST helpers ──
const isNode = (v) => v && typeof v === "object" && typeof v.type === "string";

// 한 노드의 자식 노드들(소스 순서). 배열·중첩 평탄화 후 start 로 정렬.
function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const v = node[key];
    if (isNode(v)) out.push(v);
    else if (Array.isArray(v)) for (const e of v) if (isNode(e)) out.push(e);
  }
  return out.sort((a, b) => a.start - b.start);
}

// 호출 callee 이름(단순 식별자 호출만). `agent(...)` → "agent".
function calleeName(node) {
  if (node.type !== "CallExpression") return null;
  const c = node.callee;
  return c && c.type === "Identifier" ? c.name : null;
}

// 임의 서브트리에서 특정 호출을 모두 수집(소스 순서).
function findCalls(root, name) {
  const out = [];
  (function rec(n) {
    if (calleeName(n) === name) out.push(n);
    for (const ch of childNodes(n)) rec(ch);
  })(root);
  return out.sort((a, b) => a.start - b.start);
}

// ── 정적 평가: 리터럴 표현 → JS 값(meta 용). 비리터럴이면 NOT_LITERAL. ──
const NOT_LITERAL = Symbol("not-literal");
function evalLiteral(node) {
  if (!node) return NOT_LITERAL;
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis.map((q) => q.value.cooked).join("") : NOT_LITERAL;
    case "UnaryExpression": {
      const v = evalLiteral(node.argument);
      if (v === NOT_LITERAL) return NOT_LITERAL;
      if (node.operator === "-") return -v;
      if (node.operator === "+") return +v;
      if (node.operator === "!") return !v;
      return NOT_LITERAL;
    }
    case "ArrayExpression": {
      const arr = [];
      for (const el of node.elements) {
        const v = evalLiteral(el);
        if (v === NOT_LITERAL) return NOT_LITERAL;
        arr.push(v);
      }
      return arr;
    }
    case "ObjectExpression": {
      const obj = {};
      for (const p of node.properties) {
        if (p.type !== "Property" || p.computed) return NOT_LITERAL;
        const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : null;
        if (key == null) return NOT_LITERAL;
        const v = evalLiteral(p.value);
        if (v === NOT_LITERAL) return NOT_LITERAL;
        obj[key] = v;
      }
      return obj;
    }
    default:
      return NOT_LITERAL;
  }
}

// ── 프롬프트 fold: 표현 → {text, static, placeholders}. 리터럴·const 접합은 문자열, 그 외는 ${slice}. ──
function foldString(node, source, constStrings, promptFns = new Map()) {
  const placeholders = [];
  const slice = (n) => source.slice(n.start, n.end);
  function go(n) {
    if (!n) return { text: "", static: true };
    switch (n.type) {
      case "Literal":
        return { text: typeof n.value === "string" ? n.value : String(n.value), static: true };
      case "TemplateLiteral": {
        let text = "";
        let stat = true;
        for (let i = 0; i < n.quasis.length; i++) {
          text += n.quasis[i].value.cooked;
          if (i < n.expressions.length) {
            const e = n.expressions[i];
            const inner = go(e);
            if (inner.static) text += inner.text;
            else {
              text += "${" + slice(e) + "}";
              placeholders.push(slice(e));
              stat = false;
            }
          }
        }
        return { text, static: stat };
      }
      case "BinaryExpression": {
        if (n.operator !== "+") {
          placeholders.push(slice(n));
          return { text: "${" + slice(n) + "}", static: false };
        }
        const l = go(n.left);
        const r = go(n.right);
        return { text: l.text + r.text, static: l.static && r.static };
      }
      case "Identifier": {
        const c = constStrings.get(n.name);
        if (c) return { text: c.text, static: c.static };
        placeholders.push(n.name);
        return { text: "${" + n.name + "}", static: false };
      }
      case "CallExpression": {
        // 화살표 프롬프트 함수 호출(SEARCH_PROMPT(angle)) → 함수 본문을 fold.
        //   인자(angle)는 constStrings 에 없으므로 본문 안 ${angle.x} 스켈레톤으로 남는다.
        const callee = n.callee;
        const body = callee && callee.type === "Identifier" ? promptFns.get(callee.name) : null;
        if (body) return go(body);
        placeholders.push(slice(n));
        return { text: "${" + slice(n) + "}", static: false };
      }
      default: {
        placeholders.push(slice(n));
        return { text: "${" + slice(n) + "}", static: false };
      }
    }
  }
  const r = go(node);
  return { text: r.text, static: r.static, placeholders };
}

// 최상위 const 중 문자열로 fold 되는 것들(프롬프트 식별자 해소용).
function collectConstStrings(ast, source) {
  const map = new Map();
  for (const stmt of ast.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!decl || decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      const t = d.init.type;
      if (t === "Literal" && typeof d.init.value === "string") map.set(d.id.name, { text: d.init.value, static: true });
      else if (t === "TemplateLiteral" || t === "BinaryExpression") {
        const f = foldString(d.init, source, map);
        if (f.static) map.set(d.id.name, { text: f.text, static: true });
      }
    }
  }
  return map;
}

// 최상위 const 화살표 프롬프트 함수(NAME = (args) => <문자열식>). 본문 fold 용 — Map<name, bodyNode>.
function collectPromptFns(ast) {
  const map = new Map();
  for (const stmt of ast.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!decl || decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      if (d.init.type === "ArrowFunctionExpression" && d.init.body.type !== "BlockStatement") {
        map.set(d.id.name, d.init.body); // (args) => <expr>
      }
    }
  }
  return map;
}

// 완전 skeleton — acorn AST 에서 위치정보(start/end/loc/range) 제거한 중립 구조.
//   런타임이 해석할 단일 진실. 요약(steps/directives)은 lossy(팩토리·제어흐름 소실)이므로
//   완전 구조를 program 으로 보존 — 무손실. 실행 0(데이터일 뿐).
function stripPositions(node) {
  if (Array.isArray(node)) return node.map(stripPositions);
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node)) {
      if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
      out[k] = stripPositions(node[k]);
    }
    return out;
  }
  return node;
}

// 최상위 const 객체/배열 리터럴(JSON Schema 본문 등) → name→값. evalLiteral 정적 평가.
//   agent({ schema: NAME }) 의 NAME 식별자를 본문으로 해소하는 데 쓴다. 비-리터럴(spread·
//   계산식) 은 수집 안 함 — 런타임이 본문 없는 참조를 loud error 로 처리(silent 금지).
function collectConstObjects(ast) {
  const map = new Map();
  for (const stmt of ast.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (!decl || decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      if (d.init.type === "ObjectExpression" || d.init.type === "ArrayExpression") {
        const v = evalLiteral(d.init);
        if (v !== NOT_LITERAL) map.set(d.id.name, v);
      }
    }
  }
  return map;
}

// arrow/function 의 첫 파라미터 식별자명(fan-out item 변수). 비식별자/없음 = null.
function firstParamName(fnNode) {
  if (!fnNode) return null;
  if ((fnNode.type === "ArrowFunctionExpression" || fnNode.type === "FunctionExpression") && fnNode.params.length > 0) {
    const p = fnNode.params[0];
    return p.type === "Identifier" ? p.name : null;
  }
  return null;
}

// fan-out axis + item 파라미터 추출(런타임이 axis 배열을 item 별로 map).
//   pipeline(AXIS, stage1, …)         → axis=AXIS source, itemParam=stage1 첫 파라미터.
//   parallel(ARR.map(item => …))      → axis=ARR source, itemParam=map 콜백 첫 파라미터.
//   parallel([thunks]) / 기타          → axis=arg0 source, itemParam=null.
function fanoutAxis(call, kind, source) {
  const slice = (n) => source.slice(n.start, n.end);
  const a0 = call.arguments[0];
  if (!a0) return { axis: null, itemParam: null };
  if (kind === "pipeline") {
    return { axis: slice(a0), itemParam: firstParamName(call.arguments[1]) };
  }
  if (
    a0.type === "CallExpression" &&
    a0.callee.type === "MemberExpression" &&
    a0.callee.property.type === "Identifier" &&
    a0.callee.property.name === "map"
  ) {
    return { axis: slice(a0.callee.object), itemParam: firstParamName(a0.arguments[0]) };
  }
  return { axis: slice(a0), itemParam: null };
}

// export const meta 추출.
function extractMeta(ast) {
  for (const stmt of ast.body) {
    if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) continue;
    const decl = stmt.declaration;
    if (decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier" && d.id.name === "meta") {
        const v = evalLiteral(d.init);
        if (v === NOT_LITERAL) throw new Error("meta 가 순수 리터럴이 아님(규약 위반)");
        return v;
      }
    }
  }
  throw new Error("export const meta 없음");
}

// agent 호출 → {label, schema, model, effort, isolation, directiveRef, promptStatic}.
function readAgentOpts(call, source, constStrings, addDirective) {
  const [promptArg, optsArg] = call.arguments;
  const directiveRef = promptArg ? addDirective(promptArg) : null;
  const out = { label: null, schema: null, model: null, effort: null, isolation: null, phase: null, directiveRef, promptStatic: null };
  if (directiveRef != null) out.promptStatic = addDirective.static(directiveRef);
  if (optsArg && optsArg.type === "ObjectExpression") {
    for (const p of optsArg.properties) {
      if (p.type !== "Property" || p.key.type !== "Identifier") continue;
      const k = p.key.name;
      if (k === "schema") out.schema = p.value.type === "Identifier" ? p.value.name : null;
      else if (["label", "model", "effort", "isolation", "phase"].includes(k)) {
        const v = evalLiteral(p.value);
        if (v !== NOT_LITERAL) out[k] = v;
      }
    }
  }
  return out;
}

export function parseWorkflow(source, { name = null, file = null } = {}) {
  // cc 엔진은 본문을 async 함수로 감싸 실행 → top-level return/await 합법. export const meta 는 module 문법.
  //   둘을 동시 허용(원본 오프셋 유지 — foldString 의 source slice 정확성).
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    locations: false,
  });
  const meta = extractMeta(ast);
  const constStrings = collectConstStrings(ast, source);
  const promptFns = collectPromptFns(ast);
  const constObjects = collectConstObjects(ast);

  // directives — 텍스트 dedup.
  const directives = [];
  const byText = new Map();
  function addDirective(promptNode) {
    const f = foldString(promptNode, source, constStrings, promptFns);
    if (byText.has(f.text)) return byText.get(f.text);
    const index = directives.length;
    directives.push({ index, text: f.text, static: f.static, placeholders: f.placeholders });
    byText.set(f.text, index);
    return index;
  }
  addDirective.static = (i) => directives[i].static;

  const agentInfo = (call) => readAgentOpts(call, source, constStrings, addDirective);
  const collectAgents = (call) => findCalls(call, "agent").map(agentInfo);

  // 최상위 오케스트레이션 walk — parallel/pipeline 은 leaf(내부 agent 는 agents[] 로 접음).
  const steps = [];
  let curPhase = null;
  (function walk(node) {
    for (const ch of childNodes(node)) {
      const cn = calleeName(ch);
      if (cn && ORCH.has(cn)) {
        const index = steps.length;
        if (cn === "phase") {
          const t = evalLiteral(ch.arguments[0]);
          curPhase = t === NOT_LITERAL ? null : t;
          steps.push({ index, kind: "phase", phase: curPhase, title: curPhase });
        } else if (cn === "log") {
          steps.push({ index, kind: "log", phase: curPhase, message: ch.arguments[0] ? foldString(ch.arguments[0], source, constStrings).text : null });
        } else if (cn === "agent") {
          const ai = agentInfo(ch);
          steps.push({ index, kind: "agent", ...ai, phase: ai.phase ?? curPhase });
        } else if (cn === "parallel") {
          const fo = fanoutAxis(ch, "parallel", source);
          steps.push({ index, kind: "parallel", phase: curPhase, axis: fo.axis, itemParam: fo.itemParam, agents: collectAgents(ch) });
        } else if (cn === "pipeline") {
          const fo = fanoutAxis(ch, "pipeline", source);
          steps.push({ index, kind: "pipeline", phase: curPhase, stages: Math.max(0, ch.arguments.length - 1), axis: fo.axis, itemParam: fo.itemParam, agents: collectAgents(ch) });
        } else if (cn === "workflow") {
          const t = evalLiteral(ch.arguments[0]);
          steps.push({ index, kind: "workflow", phase: curPhase, name: typeof t === "string" ? t : null });
        }
        continue; // leaf — 내부는 위에서 접거나 의도적으로 안 들어감
      }
      walk(ch);
    }
  })(ast);

  // schemas — 참조된 agent schema 식별자(top-level + parallel/pipeline 내부) → 정적 본문.
  //   이름 정렬로 결정적 키 순서. 본문 미해소(계산식) 참조는 맵에서 누락 → 런타임/닥터가 잡는다.
  const refSchemas = new Set();
  for (const s of steps) {
    if (s.kind === "agent" && s.schema) refSchemas.add(s.schema);
    if ((s.kind === "parallel" || s.kind === "pipeline") && Array.isArray(s.agents)) {
      for (const a of s.agents) if (a.schema) refSchemas.add(a.schema);
    }
  }
  const schemas = {};
  for (const nm of [...refSchemas].sort()) {
    if (constObjects.has(nm)) schemas[nm] = constObjects.get(nm);
  }

  // program = 완전 중립 AST(무손실). 런타임이 해석. steps/directives/schemas 는 요약(diff/표시용).
  const program = stripPositions(ast);

  return { skeleton: "workflow-skeleton@1", source: { name, file }, meta, steps, directives, schemas, program };
}
