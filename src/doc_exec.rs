//! doc_exec — workflow-doc@0.0.1(언어중립 JSON 워크플로 문서) 실행기.
//!
//! 저작 LLM 이 JS 코드(gen.js) 대신 **선언형 문서**를 내고, 이 실행기가 stage 를 돈다.
//! interp(ESTree AST) 경로의 문서 대체 — 경계는 전부 재사용: publish → NodeEvent(EmitHost 와 동일 wire),
//! agent → 러너 클로저(ClaudeHost 동형), generate 산출 → draft_doc build/validate, relay(main.js) 무변경.
//! JS 표면의 취약성(문법 실패·펜스·클론 VM 제약)이 스키마 검증(validate, fail-loud)으로 대체된다.
//!
//! 문서 형태:
//!   { "spec": "workflow-doc@0.0.1", "meta": {name, description},
//!     "args":    { name: {"from": ["directive","DIRECTIVE",…], "default": any} },   // 실행 인자 해석(우선순위)
//!     "values":  { name: any },            // 상수(프롬프트 조각·스키마·템플릿) — **렌더하지 않음**(verbatim)
//!     "prompts": { name: "…{{ref}}…" },    // agent 실행 시 렌더. ref = values.* | args.* | ledger(빌트인)
//!     "stages":  { ""|"generate"|…: [op…] } }  // "" = skeleton(--emit, agent 금지)
//! op 5종:
//!   {"op":"agent","prompt":p,"schema"?:valueName,"label"?:s,"bind":var}
//!   {"op":"forEach","in":path,"when"?:path,"collect"?:var,"do":[op…]}   // item/index 바인딩
//!   {"op":"publish","node":{…}}   // 필드 값 = 리터럴 | {"$":path,"or"?:default} | id 는 {"auto":prefix} 가능
//!   {"op":"return","value":{k: expr}}
//! path = "root.seg.seg" — root 는 locals(bind/item/index/collect) → "args" → "values".

use crate::emit_host::NodeEvent;
use serde_json::{Map, Value as Json};

pub const SPEC: &str = "workflow-doc@0.0.1";

/// is_doc — 입력 JSON 이 workflow-doc@0.0.1 문서인가(스켈레톤/AST 경로와 분기 판별).
pub fn is_doc(v: &Json) -> bool {
    v.get("spec").and_then(|s| s.as_str()) == Some(SPEC)
}

/// agent 러너 — (렌더된 prompt, schema, label) → 결과 JSON. 실행 컨텍스트가 주입(claude/stub).
pub type AgentFn<'a> = dyn FnMut(&str, Option<&Json>, &str) -> Result<Json, String> + 'a;

// ── values 조성 ──────────────────────────────────────────────

/// resolved_values — values 로드-시 조성: `{"concat":[문자열|{"$":"values.X"}…]}` 를 문자열로 접는다.
/// 참조 대상은 **plain 문자열 값**만(1단 — concat-of-concat 금지, fail-loud).
/// 용도: VERIFY_TMPL 이 COMMON 을 단일 원천으로 포함(문서 내 중복 0)하면서도 등록(registerPrompts) 시점엔
/// 완성 텍스트로 나간다 — {{COMMON}} 렌더 마커를 값에 남기면 소비 시점(kanban resolve 는 vars/refs 만 앎)에
/// 치환되지 않은 채 프롬프트에 새는 사고가 나므로, 조성은 실행기 로드 시점에 끝낸다.
pub fn resolved_values(doc: &Json) -> Result<Map<String, Json>, String> {
    let Some(m) = doc.get("values").and_then(|v| v.as_object()) else {
        return Ok(Map::new());
    };
    let mut out = Map::new();
    for (k, v) in m {
        if !(v.is_object() && v.get("concat").is_some()) {
            out.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in m {
        if let Some(parts) = v.get("concat").and_then(|c| c.as_array()) {
            let mut s = String::new();
            for p in parts {
                match p {
                    Json::String(lit) => s.push_str(lit),
                    Json::Object(o) => {
                        let path = o
                            .get("$")
                            .and_then(|x| x.as_str())
                            .ok_or_else(|| format!("values.{k} concat 원소 — 문자열 또는 {{\"$\":\"values.X\"}}"))?;
                        let name = path
                            .strip_prefix("values.")
                            .ok_or_else(|| format!("values.{k} concat 은 values.* 만 참조({path:?})"))?;
                        match out.get(name) {
                            Some(Json::String(t)) => s.push_str(t),
                            _ => return Err(format!("values.{k} concat 참조 {name:?} — plain 문자열 값 아님")),
                        }
                    }
                    _ => return Err(format!("values.{k} concat 원소는 문자열|{{\"$\"}} 만")),
                }
            }
            out.insert(k.clone(), Json::String(s));
        }
    }
    Ok(out)
}

// ── 검증(fail-loud) ──────────────────────────────────────────

/// validate — 문서 정합 인증. 위반 목록 반환(빈 목록 = 통과). 저작 게이트(generate-skeleton)와
/// 실행 진입(--emit/exec-stage) 양단에서 강제 — "JS parse 성공 ≠ 의미 보장" 을 스키마 검증으로 대체.
pub fn validate(doc: &Json) -> Result<(), Vec<String>> {
    let mut v: Vec<String> = vec![];
    if !is_doc(doc) {
        return Err(vec![format!("[spec] spec ≠ {SPEC:?}")]);
    }
    let name = doc.pointer("/meta/name").and_then(|n| n.as_str()).unwrap_or("");
    if name.trim().is_empty() {
        v.push("[meta] meta.name 비어있음".to_string());
    }
    // values 는 조성(concat) 해석 후 기준으로 검사 — 조성 실패 자체도 위반.
    let resolved: Map<String, Json>;
    let values = match resolved_values(doc) {
        Ok(m) => {
            resolved = m;
            Some(&resolved)
        }
        Err(e) => {
            v.push(format!("[values] {e}"));
            None
        }
    };
    let args_decl = doc.get("args").and_then(|x| x.as_object());
    let prompts = doc.get("prompts").and_then(|x| x.as_object());
    let stages = match doc.get("stages").and_then(|x| x.as_object()) {
        Some(s) if !s.is_empty() => s,
        _ => {
            v.push("[stages] stages 비어있음".to_string());
            return Err(v);
        }
    };

    // prompts 플레이스홀더 해석 가능성 — {{name}} ∈ values ∪ 선언 args ∪ {ledger}.
    if let Some(ps) = prompts {
        for (pname, tmpl) in ps {
            let Some(t) = tmpl.as_str() else {
                v.push(format!("[prompts] {pname:?} 문자열 아님"));
                continue;
            };
            for ph in placeholders(t) {
                let known = values.is_some_and(|m| m.contains_key(&ph))
                    || args_decl.is_some_and(|m| m.contains_key(&ph))
                    || ph == "ledger"
                    || ph == "facts";
                if !known {
                    v.push(format!("[prompts] {pname:?} 플레이스홀더 {{{{{ph}}}}} 미해석(values/args/ledger 아님)"));
                }
            }
        }
    }

    // stage op 재귀 검증.
    for (sname, ops) in stages {
        let Some(list) = ops.as_array() else {
            v.push(format!("[stages] {sname:?} 가 op 배열 아님"));
            continue;
        };
        let mut literal_ids: std::collections::BTreeSet<String> = Default::default();
        validate_ops(sname, list, prompts, values, &mut literal_ids, &mut v);
        // skeleton stage("") 는 agent 금지 — --emit 은 LLM 미호출 계약.
        if sname.is_empty() && ops_contain_agent(list) {
            v.push("[stages] skeleton stage(\"\") 에 agent op — 발행(--emit)은 LLM 미호출 계약".to_string());
        }
    }

    if v.is_empty() { Ok(()) } else { Err(v) }
}

fn validate_ops(
    stage: &str,
    ops: &[Json],
    prompts: Option<&Map<String, Json>>,
    values: Option<&Map<String, Json>>,
    literal_ids: &mut std::collections::BTreeSet<String>,
    v: &mut Vec<String>,
) {
    for op in ops {
        match op.get("op").and_then(|o| o.as_str()) {
            Some("agent") => {
                let p = op.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
                if !prompts.is_some_and(|m| m.contains_key(p)) {
                    v.push(format!("[{stage}] agent.prompt {p:?} ∉ prompts"));
                }
                if let Some(s) = op.get("schema").and_then(|x| x.as_str()) {
                    let ok = values.and_then(|m| m.get(s)).is_some_and(|x| x.is_object());
                    if !ok {
                        v.push(format!("[{stage}] agent.schema {s:?} ∉ values(객체)"));
                    }
                }
                if op.get("bind").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
                    v.push(format!("[{stage}] agent.bind 누락"));
                }
            }
            Some("forEach") => {
                if op.get("in").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
                    v.push(format!("[{stage}] forEach.in 누락"));
                }
                match op.get("do").and_then(|x| x.as_array()) {
                    Some(inner) if !inner.is_empty() => validate_ops(stage, inner, prompts, values, literal_ids, v),
                    _ => v.push(format!("[{stage}] forEach.do 비어있음")),
                }
            }
            Some("publish") => {
                let Some(node) = op.get("node").and_then(|x| x.as_object()) else {
                    v.push(format!("[{stage}] publish.node 누락"));
                    continue;
                };
                if node.get("kind").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
                    v.push(format!("[{stage}] publish.node.kind 누락"));
                }
                match node.get("id") {
                    Some(Json::String(id)) => {
                        if !literal_ids.insert(id.clone()) {
                            v.push(format!("[{stage}] publish id {id:?} 중복"));
                        }
                    }
                    Some(Json::Object(m)) if m.get("auto").is_some_and(|a| a.as_str().is_some_and(|s| !s.is_empty())) => {}
                    _ => v.push(format!("[{stage}] publish.node.id — 리터럴 문자열 또는 {{\"auto\":prefix}} 필요")),
                }
                // schema 필드가 문자열이면 values 참조여야 한다(오타 fail-loud).
                if let Some(Json::String(s)) = node.get("schema") {
                    if !values.and_then(|m| m.get(s)).is_some_and(|x| x.is_object()) {
                        v.push(format!("[{stage}] publish.node.schema {s:?} ∉ values(객체)"));
                    }
                }
            }
            Some("return") => {
                if !op.get("value").is_some_and(|x| x.is_object()) {
                    v.push(format!("[{stage}] return.value 객체 필요"));
                }
            }
            other => v.push(format!("[{stage}] 미지 op {other:?}")),
        }
    }
}

fn ops_contain_agent(ops: &[Json]) -> bool {
    ops.iter().any(|op| {
        op.get("op").and_then(|o| o.as_str()) == Some("agent")
            || op.get("do").and_then(|d| d.as_array()).is_some_and(|inner| ops_contain_agent(inner))
    })
}

/// placeholders — "{{name}}" 마커 이름 수집.
fn placeholders(t: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = t;
    while let Some(open) = rest.find("{{") {
        let after = &rest[open + 2..];
        if let Some(close) = after.find("}}") {
            out.push(after[..close].trim().to_string());
            rest = &after[close + 2..];
        } else {
            break;
        }
    }
    out
}

// ── 실행 ─────────────────────────────────────────────────────

struct Scope<'a> {
    args: Json,
    values: &'a Json,
    locals: Vec<(String, Json)>,
}

impl Scope<'_> {
    /// path("tree.title") 해석 — 첫 세그먼트: locals → "args" → "values" 루트. 미해석 = None.
    fn lookup(&self, path: &str) -> Option<Json> {
        let mut segs = path.split('.');
        let root = segs.next()?;
        let mut cur: Json = if root == "args" {
            self.args.clone()
        } else if root == "values" {
            self.values.clone()
        } else if let Some((_, v)) = self.locals.iter().rev().find(|(k, _)| k == root) {
            v.clone()
        } else {
            return None;
        };
        for s in segs {
            cur = cur.get(s)?.clone();
        }
        Some(cur)
    }

    /// 필드 표현식 평가 — 리터럴 그대로 | {"$":path,"or"?:default} 참조(미해석/null → or, 없으면 Null).
    fn eval(&self, v: &Json) -> Json {
        if let Some(m) = v.as_object() {
            if let Some(Json::String(path)) = m.get("$") {
                return match self.lookup(path) {
                    Some(x) if !x.is_null() => x,
                    _ => m.get("or").cloned().unwrap_or(Json::Null),
                };
            }
        }
        v.clone()
    }

    fn eval_str(&self, v: &Json) -> Option<String> {
        match self.eval(v) {
            Json::String(s) => Some(s),
            Json::Null => None,
            other => Some(other.to_string()),
        }
    }

    /// 프롬프트 템플릿 렌더 — {{name}} → values/args/locals + {{ledger}} 빌트인(원장 렌더).
    /// 미해석 플레이스홀더는 Err(fail-loud — 조용한 빈 프롬프트 금지).
    fn render(&self, tmpl: &str) -> Result<String, String> {
        let mut out = tmpl.to_string();
        for ph in placeholders(tmpl) {
            let rendered = if ph == "ledger" {
                Some(ledger_view(&self.args, "ledger"))
            } else if ph == "facts" {
                Some(ledger_view(&self.args, "facts"))
            } else {
                self.lookup(&ph)
                    .or_else(|| self.lookup(&format!("args.{ph}")))
                    .or_else(|| self.lookup(&format!("values.{ph}")))
                    .map(|x| match x {
                        Json::String(s) => s,
                        other => other.to_string(),
                    })
            };
            match rendered {
                Some(r) => out = out.replace(&format!("{{{{{ph}}}}}"), &r),
                None => return Err(format!("프롬프트 플레이스홀더 {{{{{ph}}}}} 미해석")),
            }
        }
        Ok(out)
    }
}

/// ledger_view — 원장 렌더 빌트인({{ledger}}=args.ledger 요건 원장, {{facts}}=args.facts 기초지식 원장).
/// draft 계약의 줄 형식 그대로: `- [id] [badge] (category?) title | 근거: verified_value?` — gen.js ledgerView 와 byte 동일 규칙.
fn ledger_view(args: &Json, key: &str) -> String {
    let Some(items) = args.get(key).and_then(|l| l.as_array()) else {
        return String::new();
    };
    items
        .iter()
        .map(|t| {
            let g = |k: &str| t.get(k).and_then(|x| x.as_str()).unwrap_or("");
            let badge = { let b = g("badge"); if b.is_empty() { "검수전" } else { b } };
            let cat = g("category");
            let vv = g("verified_value");
            format!(
                "- [{}] [{}]{} {}{}",
                g("id"),
                badge,
                if cat.is_empty() { String::new() } else { format!(" ({cat})") },
                g("title"),
                if vv.is_empty() { String::new() } else { format!(" | 근거: {vv}") }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// resolve_args — 문서 args 선언({"from":[…],"default"}) 을 런타임 입력으로 해석.
/// from 경로는 입력 args 객체 안 키(우선순위 순회). "$args" 는 입력 전체가 문자열일 때(호환 — 미지원, 객체만).
fn resolve_args(doc: &Json, input: &Json) -> Json {
    let mut out = Map::new();
    // 입력 객체의 키를 전부 통과(ledger/stage/chunkRef/lang 등 런타임 주입 유지).
    if let Some(m) = input.as_object() {
        for (k, v) in m {
            out.insert(k.clone(), v.clone());
        }
    }
    if let Some(decl) = doc.get("args").and_then(|a| a.as_object()) {
        for (name, spec) in decl {
            if out.contains_key(name) {
                continue;
            }
            let mut got: Option<Json> = None;
            if let Some(from) = spec.get("from").and_then(|f| f.as_array()) {
                for cand in from {
                    if let Some(key) = cand.as_str() {
                        if let Some(v) = input.get(key) {
                            if !v.is_null() {
                                got = Some(v.clone());
                                break;
                            }
                        }
                    }
                }
            }
            let v = got.or_else(|| spec.get("default").cloned()).unwrap_or(Json::Null);
            out.insert(name.clone(), v);
        }
    }
    Json::Object(out)
}

/// run — stage 실행. (발행 NodeEvent 목록, return 값) 반환. stage 미존재 = Err(fail-loud).
pub fn run(doc: &Json, stage: &str, input_args: &Json, agent_fn: &mut AgentFn) -> Result<(Vec<NodeEvent>, Json), String> {
    validate(doc).map_err(|v| format!("workflow-doc 검증 실패({}건): {}", v.len(), v.join(" / ")))?;
    let ops = doc
        .pointer(&format!("/stages/{}", stage.replace('/', "~1")))
        .and_then(|x| x.as_array())
        .ok_or_else(|| format!("stage {stage:?} 미정의(stages 키 확인)"))?
        .clone();
    let values = Json::Object(resolved_values(doc)?);
    let mut scope = Scope { args: resolve_args(doc, input_args), values: &values, locals: vec![] };
    let mut st = RunState { events: vec![], registered: false, result: Json::Null };
    exec_ops(doc, &ops, &mut scope, &mut st, agent_fn, None)?;
    Ok((st.events, st.result))
}

struct RunState {
    events: Vec<NodeEvent>,
    registered: bool, // registerPromptsOnce — 이 run 에서 1회만 부착(gen.js 의 '첫 항목에만' 계약)
    result: Json,
}

/// exec_ops — op 순차 실행. return 을 만나면 true(중단 신호).
fn exec_ops(
    doc: &Json,
    ops: &[Json],
    scope: &mut Scope,
    st: &mut RunState,
    agent_fn: &mut AgentFn,
    for_index: Option<usize>,
) -> Result<bool, String> {
    for op in ops {
        match op.get("op").and_then(|o| o.as_str()) {
            Some("agent") => {
                let pname = op.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
                let tmpl = doc
                    .pointer(&format!("/prompts/{pname}"))
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| format!("prompts.{pname} 미정의"))?;
                let prompt = scope.render(tmpl)?;
                let schema = op
                    .get("schema")
                    .and_then(|x| x.as_str())
                    .and_then(|s| scope.values.get(s))
                    .cloned();
                let label = op.get("label").and_then(|x| x.as_str()).unwrap_or(pname);
                let out = agent_fn(&prompt, schema.as_ref(), label)?;
                let bind = op.get("bind").and_then(|x| x.as_str()).unwrap_or("_").to_string();
                scope.locals.push((bind, out));
            }
            Some("forEach") => {
                let path = op.get("in").and_then(|x| x.as_str()).unwrap_or("");
                let items = match scope.lookup(path) {
                    Some(Json::Array(a)) => a,
                    Some(Json::Null) | None => vec![],
                    Some(other) => return Err(format!("forEach.in {path:?} 배열 아님: {other}")),
                };
                let inner = op.get("do").and_then(|x| x.as_array()).cloned().unwrap_or_default();
                let collect_name = op.get("collect").and_then(|x| x.as_str());
                let mut collected: Vec<Json> = vec![];
                for (idx, item) in items.into_iter().enumerate() {
                    // when 게이트(항목 필터 — gen.js 의 `if (it && it.title)`).
                    scope.locals.push(("item".to_string(), item));
                    scope.locals.push(("index".to_string(), Json::from(idx)));
                    let pass = match op.get("when").and_then(|x| x.as_str()) {
                        Some(w) => truthy(&scope.lookup(w).unwrap_or(Json::Null)),
                        None => true,
                    };
                    if pass {
                        let before = st.events.len();
                        let ret = exec_ops(doc, &inner, scope, st, agent_fn, Some(idx))?;
                        for ev in &st.events[before..] {
                            let NodeEvent::Add { id, .. } = ev;
                            collected.push(Json::String(id.clone()));
                        }
                        if ret {
                            scope.locals.pop();
                            scope.locals.pop();
                            return Ok(true);
                        }
                    }
                    scope.locals.pop();
                    scope.locals.pop();
                }
                if let Some(name) = collect_name {
                    scope.locals.push((name.to_string(), Json::Array(collected)));
                }
            }
            Some("publish") => {
                let node = op.get("node").and_then(|x| x.as_object()).ok_or("publish.node 누락")?;
                let ev = build_event(node, scope, st, for_index)?;
                st.events.push(ev);
            }
            Some("return") => {
                let spec = op.get("value").and_then(|x| x.as_object()).ok_or("return.value 누락")?;
                let mut out = Map::new();
                for (k, v) in spec {
                    out.insert(k.clone(), scope.eval(v));
                }
                st.result = Json::Object(out);
                return Ok(true);
            }
            other => return Err(format!("미지 op {other:?}")),
        }
    }
    Ok(false)
}

fn truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::String(s) => !s.is_empty(),
        Json::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => true,
    }
}

/// build_event — publish.node 스펙 → NodeEvent::Add. 필드 표현식 평가 + id auto(prefix+index) +
/// registerPromptsOnce(이 run 1회 — 첫 부착 시점) 처리. wire 는 interp 경로와 동일(NodeEvent serde).
fn build_event(node: &Map<String, Json>, scope: &Scope, st: &mut RunState, for_index: Option<usize>) -> Result<NodeEvent, String> {
    let id = match node.get("id") {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Object(m)) => {
            let prefix = m.get("auto").and_then(|a| a.as_str()).ok_or("id.auto prefix 필요")?;
            let idx = for_index.ok_or("id {\"auto\"} 는 forEach 안에서만")?;
            format!("{prefix}{idx}")
        }
        _ => return Err("publish.node.id 필요".to_string()),
    };
    let s = |k: &str| node.get(k).and_then(|v| scope.eval_str(v)).filter(|x| !x.is_empty());
    let kind = s("kind").ok_or("publish.node.kind 필요")?;
    // blockedBy — 원소: 리터럴 문자열 | {"$":path}(배열이면 spread).
    let mut blocked_by: Vec<String> = vec![];
    if let Some(Json::Array(arr)) = node.get("blockedBy") {
        for el in arr {
            match scope.eval(el) {
                Json::String(one) => blocked_by.push(one),
                Json::Array(many) => {
                    for m in many {
                        if let Json::String(x) = m {
                            blocked_by.push(x);
                        }
                    }
                }
                Json::Null => {}
                other => return Err(format!("blockedBy 원소 해석 불가: {other}")),
            }
        }
    }
    // vars — {k: expr} 평가(작은 값만 — 정규화 계약).
    let vars = node.get("vars").and_then(|v| v.as_object()).map(|m| {
        let mut out = Map::new();
        for (k, v) in m {
            out.insert(k.clone(), scope.eval(v));
        }
        Json::Object(out)
    });
    // registerPromptsOnce — 이 run 첫 부착에서만 register_prompts 로 emit(sha dedup 은 kanban 몫).
    let register_prompts = if !st.registered {
        node.get("registerPromptsOnce").and_then(|v| v.as_object()).map(|m| {
            st.registered = true;
            let mut out = Map::new();
            for (k, v) in m {
                out.insert(k.clone(), scope.eval(v));
            }
            Json::Object(out)
        })
    } else {
        None
    };
    // schema — 문자열이면 values 참조(검증 완료), 객체면 인라인.
    let schema = match node.get("schema") {
        Some(Json::String(key)) => scope.values.get(key).cloned(),
        Some(obj @ Json::Object(_)) => Some(obj.clone()),
        _ => None,
    };
    Ok(NodeEvent::Add {
        id,
        parent: s("parent"),
        kind,
        title: s("title").unwrap_or_default(),
        description: s("description").unwrap_or_default(),
        prompt: s("prompt").unwrap_or_default(),
        stage: s("stage"),
        schema,
        category: s("category"),
        origin: s("origin"),
        prompt_role: s("promptRole"),
        vars,
        register_prompts,
        var_refs: node.get("varRefs").cloned().filter(|v| v.is_object()),
        schema_ref: s("schemaRef"),
        blocked_by,
        badge: s("badge"),
        is_draft: node.get("isDraft").map(|v| scope.eval(v) == Json::Bool(true)).unwrap_or(false),
        parent_draft_id: s("parentDraftId"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 최소 draft 형태 doc — 실제 draft 계약의 축소판(스키마·프롬프트 축약).
    fn mini_doc() -> Json {
        json!({
            "spec": SPEC,
            "meta": { "name": "draft", "description": "테스트" },
            "args": {
                "directive": { "from": ["directive", "DIRECTIVE", "IDEA"], "default": "" },
                "parentDraftId": { "from": ["parentDraftId"], "default": null }
            },
            "values": {
                "PENDING": "검수전",
                "COMMON": "SHARED CONCEPTS",
                "VERIFY_TMPL": "{{COMMON}} verify {{title}} — {{directive}}",
                "GEN_SCHEMA": { "type": "object", "required": ["title", "requirements"] },
                "VERIFY_SCHEMA": { "type": "object", "required": ["oxf", "origin"] },
                "HUNT_SCHEMA": { "type": "object", "required": ["additions"] },
                "AUDIT_SCHEMA": { "type": "object", "required": ["complete", "verdict"] }
            },
            "prompts": {
                "gen": "{{COMMON}}\nGENERATOR\nDirective: \"{{directive}}\"",
                "hunt": "{{COMMON}}\nHUNT\n{{ledger}}\nDirective: \"{{directive}}\"",
                "audit": "{{COMMON}}\nAUDIT\n{{ledger}}"
            },
            "stages": {
                "": [
                    { "op": "publish", "node": { "id": "chunk", "kind": "chunk", "isDraft": true,
                        "title": { "$": "args.title", "or": "구체화 덩어리" }, "description": { "$": "args.directive" },
                        "parentDraftId": { "$": "args.parentDraftId", "or": "" } } },
                    { "op": "publish", "node": { "id": "gen", "kind": "task", "stage": "generate", "parent": "chunk", "title": "요건 도출" } }
                ],
                "generate": [
                    { "op": "agent", "prompt": "gen", "schema": "GEN_SCHEMA", "label": "요건 도출", "bind": "tree" },
                    { "op": "forEach", "in": "tree.requirements", "when": "item.title", "collect": "itemIds", "do": [
                        { "op": "publish", "node": { "id": { "auto": "i" }, "kind": "item", "parent": { "$": "args.chunkRef", "or": "chunk" },
                            "title": { "$": "item.title" }, "description": { "$": "item.description", "or": "" },
                            "origin": { "$": "item.origin" }, "badge": { "$": "values.PENDING" },
                            "schema": "VERIFY_SCHEMA", "promptRole": "verify",
                            "vars": { "title": { "$": "item.title" }, "description": { "$": "item.description", "or": "" } },
                            "varRefs": { "directive": "directive" },
                            "registerPromptsOnce": { "verify": { "$": "values.VERIFY_TMPL" }, "directive": { "$": "args.directive" } } } }
                    ] },
                    { "op": "publish", "node": { "id": "hunt", "kind": "task", "stage": "hunt", "parent": { "$": "args.chunkRef", "or": "chunk" },
                        "title": "누락 탐색", "blockedBy": [ { "$": "itemIds" } ] } },
                    { "op": "return", "value": { "chunkTitle": { "$": "tree.title", "or": "" }, "titleOrigin": { "$": "tree.titleOrigin", "or": "agent" } } }
                ],
                "audit": [
                    { "op": "agent", "prompt": "audit", "schema": "AUDIT_SCHEMA", "bind": "r" },
                    { "op": "return", "value": { "verdict": { "$": "r.verdict", "or": "(감사 결과 없음)" }, "complete": { "$": "r.complete", "or": false } } }
                ]
            }
        })
    }

    fn no_agent(_p: &str, _s: Option<&Json>, _l: &str) -> Result<Json, String> {
        Err("agent 호출 없어야 함".into())
    }

    #[test]
    fn is_doc_detects_spec() {
        assert!(is_doc(&mini_doc()));
        assert!(!is_doc(&json!({ "program": {} })), "skeleton(AST) 은 doc 아님");
    }

    #[test]
    fn validate_accepts_mini_doc() {
        assert_eq!(validate(&mini_doc()), Ok(()));
    }

    #[test]
    fn validate_rejects_unknown_prompt_and_schema_refs() {
        let mut d = mini_doc();
        d["stages"]["generate"][0]["prompt"] = json!("nope");
        d["stages"]["generate"][0]["schema"] = json!("NOPE_SCHEMA");
        let errs = validate(&d).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("agent.prompt") && e.contains("nope")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("agent.schema")), "{errs:?}");
    }

    #[test]
    fn validate_rejects_unresolvable_placeholder() {
        let mut d = mini_doc();
        d["prompts"]["gen"] = json!("{{MISSING_VALUE}}");
        let errs = validate(&d).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("MISSING_VALUE")), "{errs:?}");
    }

    #[test]
    fn validate_rejects_agent_in_skeleton_stage() {
        let mut d = mini_doc();
        d["stages"][""] = json!([{ "op": "agent", "prompt": "gen", "bind": "x" }]);
        let errs = validate(&d).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("skeleton") && e.contains("agent")), "{errs:?}");
    }

    #[test]
    fn validate_rejects_duplicate_literal_ids() {
        let mut d = mini_doc();
        d["stages"][""][1]["node"]["id"] = json!("chunk"); // gen id 를 chunk 로 중복
        let errs = validate(&d).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("중복")), "{errs:?}");
    }

    #[test]
    fn skeleton_stage_publishes_chunk_and_task_without_agent() {
        let (events, result) = run(&mini_doc(), "", &json!({ "directive": "약국 재고" }), &mut no_agent).unwrap();
        assert_eq!(events.len(), 2);
        let NodeEvent::Add { id, kind, is_draft, description, .. } = &events[0];
        assert_eq!((id.as_str(), kind.as_str(), *is_draft), ("chunk", "chunk", true));
        assert_eq!(description, "약국 재고", "args.directive → description");
        let NodeEvent::Add { id, kind, stage, parent, .. } = &events[1];
        assert_eq!((id.as_str(), kind.as_str()), ("gen", "task"));
        assert_eq!(stage.as_deref(), Some("generate"));
        assert_eq!(parent.as_deref(), Some("chunk"));
        assert_eq!(result, Json::Null, "skeleton 은 return 없음");
    }

    #[test]
    fn args_from_priority_and_default() {
        // DIRECTIVE(대문자)로 넣어도 args.directive 로 해석(from 우선순위), title 미지정 → or 기본.
        let (events, _) = run(&mini_doc(), "", &json!({ "DIRECTIVE": "대문자 지시" }), &mut no_agent).unwrap();
        let NodeEvent::Add { title, description, .. } = &events[0];
        assert_eq!(description, "대문자 지시");
        assert_eq!(title, "구체화 덩어리", "or 기본값");
    }

    #[test]
    fn generate_publishes_items_tasks_and_returns() {
        let mut agent = |prompt: &str, schema: Option<&Json>, _l: &str| -> Result<Json, String> {
            assert!(prompt.contains("SHARED CONCEPTS"), "{{{{COMMON}}}} 렌더");
            assert!(prompt.contains("Directive: \"약국\""), "{{{{directive}}}} 렌더");
            assert!(schema.is_some_and(|s| s["required"][0] == "title"), "GEN_SCHEMA 전달");
            Ok(json!({ "title": "약국 재고 SaaS", "titleOrigin": "agent", "requirements": [
                { "title": "재고 차감", "description": "판매 시", "origin": "user" },
                { "title": "", "description": "제목 없음 — when 필터", "origin": "agent" },
                { "title": "유통기한 경고", "origin": "agent" }
            ] }))
        };
        let (events, result) =
            run(&mini_doc(), "generate", &json!({ "directive": "약국", "chunkRef": "k-7" }), &mut agent).unwrap();
        // 항목 2(빈 title 필터) + hunt task 1.
        assert_eq!(events.len(), 3);
        let NodeEvent::Add { id, parent, badge, register_prompts, vars, schema, prompt_role, .. } = &events[0];
        assert_eq!(id, "i0", "auto id = prefix+index");
        assert_eq!(parent.as_deref(), Some("k-7"), "args.chunkRef");
        assert_eq!(badge.as_deref(), Some("검수전"), "values.PENDING");
        assert_eq!(prompt_role.as_deref(), Some("verify"));
        assert!(schema.is_some(), "VERIFY_SCHEMA 인라인");
        let reg = register_prompts.as_ref().expect("첫 항목에 registerPromptsOnce");
        assert_eq!(reg["directive"], "약국");
        assert!(reg["verify"].as_str().unwrap().contains("{{title}}"), "VERIFY_TMPL 은 렌더하지 않음(소비 시점 치환)");
        assert_eq!(vars.as_ref().unwrap()["title"], "재고 차감");
        let NodeEvent::Add { id, register_prompts, .. } = &events[1];
        assert_eq!(id, "i2", "필터된 index 도 auto 에 반영(원본 순번 유지)");
        assert!(register_prompts.is_none(), "registerPromptsOnce 는 1회만");
        let NodeEvent::Add { id, blocked_by, .. } = &events[2];
        assert_eq!(id, "hunt");
        assert_eq!(blocked_by, &vec!["i0".to_string(), "i2".to_string()], "collect(itemIds) spread");
        assert_eq!(result["chunkTitle"], "약국 재고 SaaS");
        assert_eq!(result["titleOrigin"], "agent");
    }

    #[test]
    fn audit_renders_ledger_builtin_and_returns() {
        let mut agent = |prompt: &str, _s: Option<&Json>, _l: &str| -> Result<Json, String> {
            assert!(prompt.contains("- [i0] [o] 재고 차감"), "ledger 렌더: {prompt}");
            assert!(prompt.contains("- [i1] [검수전] (재고) 창고 연결 | 근거: 근거텍스트"), "badge 폴백·category·근거: {prompt}");
            Ok(json!({ "complete": true, "verdict": "완결" }))
        };
        let args = json!({ "directive": "d", "ledger": [
            { "id": "i0", "title": "재고 차감", "badge": "o" },
            { "id": "i1", "title": "창고 연결", "category": "재고", "verified_value": "근거텍스트" }
        ] });
        let (events, result) = run(&mini_doc(), "audit", &args, &mut agent).unwrap();
        assert!(events.is_empty(), "audit 발행 0");
        assert_eq!(result["verdict"], "완결");
        assert_eq!(result["complete"], true);
    }

    #[test]
    fn agent_failure_propagates() {
        let mut agent = |_p: &str, _s: Option<&Json>, _l: &str| -> Result<Json, String> { Err("529 소진".into()) };
        let err = run(&mini_doc(), "generate", &json!({ "directive": "d" }), &mut agent).unwrap_err();
        assert!(err.contains("529"), "agent 실패 전파(빈-성공 침묵 금지): {err}");
    }

    #[test]
    fn unknown_stage_is_loud() {
        let err = run(&mini_doc(), "classify", &json!({}), &mut no_agent).unwrap_err();
        assert!(err.contains("stage") && err.contains("classify"), "{err}");
    }

    /// [계약 스냅샷] gen.pharmacy.doc.json — draft fixture 의 wire 계약 고정.
    /// (M5e 이전엔 interp(AST) 경로와의 등가 증명이 이 계약을 잠갔다 — 레거시 제거 후에는 doc 경로 산출
    /// 자체를 스냅샷으로 고정한다. 여기 단언이 깨지는 변경 = relay/kanban 과의 wire 계약 변경이다.)
    #[test]
    fn fixture_doc_wire_contract_snapshot() {
        let doc: Json = serde_json::from_str(include_str!("../fixtures/gen.pharmacy.doc.json")).unwrap();
        assert_eq!(validate(&doc), Ok(()), "fixture doc 은 스키마 검증 통과");
        let values = resolved_values(&doc).unwrap();

        // ── skeleton stage("") — chunk + generate task, 정확한 직렬화 라인(wire) 고정.
        let mut no_agent = |_p: &str, _s: Option<&Json>, _l: &str| -> Result<Json, String> { Err("no agent".into()) };
        let em_args = json!({ "directive": "테스트 지시" });
        let (skel, _) = run(&doc, "", &em_args, &mut no_agent).expect("doc skeleton");
        let lines: Vec<String> = skel.iter().map(|e| serde_json::to_string(e).unwrap()).collect();
        assert_eq!(
            lines[0],
            r#"{"ev":"add","id":"chunk","parent":null,"kind":"chunk","title":"구체화 덩어리","description":"테스트 지시","is_draft":true}"#,
            "chunk wire"
        );
        assert_eq!(
            lines[1],
            r#"{"ev":"add","id":"gen","parent":"chunk","kind":"task","title":"요건 도출","description":"","stage":"generate"}"#,
            "generate task wire"
        );

        // ── generate stage — stub 산출로 항목/task 발행 계약 고정.
        let stub_json = json!({ "title": "테스트 덩어리", "titleOrigin": "agent", "requirements": [
            { "title": "항목1", "description": "설명1", "origin": "user" },
            { "title": "항목2", "description": "설명2", "origin": "agent" }
        ] });
        let mut prompt_cap = String::new();
        let mut agent = |p: &str, _s: Option<&Json>, _l: &str| -> Result<Json, String> {
            prompt_cap = p.to_string();
            Ok(stub_json.clone())
        };
        let args = json!({ "stage": "generate", "directive": "테스트 지시", "chunkRef": "chunk" });
        let (events, result) = run(&doc, "generate", &args, &mut agent).expect("doc generate");
        // gen 프롬프트 = 렌더된 COMMON + 역할 본문 + directive(정확 조성 — 빈 마커 잔존 0).
        let common = values.get("COMMON").and_then(|v| v.as_str()).unwrap();
        assert!(prompt_cap.starts_with(common), "genPrompt 는 COMMON 으로 시작(렌더)");
        assert!(prompt_cap.contains("Directive: \"테스트 지시\""), "directive 렌더");
        assert!(!prompt_cap.contains("{{"), "미해석 마커 잔존 0");
        // 이벤트: 항목 2 + hunt/classify/audit task 3.
        assert_eq!(events.len(), 5);
        let NodeEvent::Add { id, kind, parent, badge, schema, prompt_role, vars, var_refs, register_prompts, .. } = &events[0];
        assert_eq!((id.as_str(), kind.as_str(), parent.as_deref()), ("i0", "item", Some("chunk")));
        assert_eq!(badge.as_deref(), Some("검수전"));
        assert_eq!(schema.as_ref(), values.get("VERIFY_SCHEMA"), "schema = 값 참조(전역 1행)");
        assert_eq!(prompt_role.as_deref(), Some("verify"));
        assert_eq!(vars.as_ref().unwrap(), &json!({ "description": "설명1", "title": "항목1" }), "vars 는 작은 값만");
        assert_eq!(var_refs.as_ref().unwrap(), &json!({ "directive": "directive" }));
        let reg = register_prompts.as_ref().expect("첫 항목에 registerPrompts");
        assert_eq!(reg.get("verify"), values.get("VERIFY_TMPL"), "등록 템플릿 = 조성된 VERIFY_TMPL(COMMON 단일 원천)");
        assert_eq!(reg.get("directive"), Some(&json!("테스트 지시")));
        let NodeEvent::Add { register_prompts, .. } = &events[1];
        assert!(register_prompts.is_none(), "registerPrompts 는 run 당 1회");
        let expected_tasks = [
            ("hunt", vec!["i0", "i1"]),
            ("classify", vec!["i0", "i1", "hunt"]),
            ("audit", vec!["i0", "i1", "hunt", "classify"]),
        ];
        for (idx, (tid, blocked)) in expected_tasks.iter().enumerate() {
            let NodeEvent::Add { id, kind, stage, blocked_by, .. } = &events[2 + idx];
            assert_eq!((id.as_str(), kind.as_str(), stage.as_deref()), (*tid, "task", Some(*tid)));
            assert_eq!(blocked_by, &blocked.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{tid} blockedBy 사슬");
        }
        assert_eq!(result, json!({ "chunkTitle": "테스트 덩어리", "titleOrigin": "agent" }), "return 계약");
    }

    /// [번들 정본] workflows/research.doc.json — research/plan stage 가 계약대로 실행되는지(stub agent).
    #[test]
    fn bundled_research_doc_validates_and_runs_research_and_plan() {
        let doc: Json = serde_json::from_str(include_str!("../workflows/research.doc.json")).unwrap();
        assert_eq!(validate(&doc), Ok(()), "번들 research doc 은 스키마 검증 통과");

        // research stage — fact 발행(정규화·registerPromptsOnce 1회·area→category) + plan task(blockedBy=factIds).
        let mut agent = |prompt: &str, schema: Option<&Json>, _l: &str| -> Result<Json, String> {
            assert!(prompt.contains("RESEARCHER"), "research 역할 프롬프트");
            assert!(prompt.contains("- [i0] [o] 요건A"), "{{{{ledger}}}} 렌더(인증 원장)");
            assert!(prompt.contains("Directive: \"정련 지시\""), "{{{{directive}}}} 렌더");
            assert!(schema.is_some_and(|s| s["required"][0] == "facts"), "RESEARCH_SCHEMA 전달");
            Ok(json!({ "facts": [
                { "title": "저장소: SQLite 채택", "description": "동시성 요건이 단일 노드 — [i0] 근거", "origin": "agent", "area": "framework" },
                { "title": "마약류 보고 기한 준수", "description": "재고 불일치 시 기한 내 보고", "origin": "search", "area": "directive" }
            ] }))
        };
        let args = json!({ "stage": "research", "directive": "정련 지시", "chunkRef": "K-7",
            "ledger": [{ "id": "i0", "title": "요건A", "badge": "o" }] });
        let (events, _r) = run(&doc, "research", &args, &mut agent).expect("research 실행");
        assert_eq!(events.len(), 3, "fact 2 + plan task 1");
        let NodeEvent::Add { id, kind, parent, badge, category, prompt_role, register_prompts, var_refs, .. } = &events[0];
        assert_eq!((id.as_str(), kind.as_str()), ("fact0", "fact"));
        assert_eq!(parent.as_deref(), Some("K-7"), "args.chunkRef(기존 칸반 id) 직속");
        assert_eq!(badge.as_deref(), Some("검수전"), "fact 는 draft 항목과 같은 검증 파이프");
        assert_eq!(category.as_deref(), Some("framework"), "area → category");
        assert_eq!(prompt_role.as_deref(), Some("fact-verify"));
        assert!(register_prompts.is_some(), "첫 fact 에 registerPromptsOnce(fact-verify+directive)");
        assert!(var_refs.is_some(), "directive 콘텐츠 주소 참조");
        let NodeEvent::Add { register_prompts, .. } = &events[1];
        assert!(register_prompts.is_none(), "registerPromptsOnce 는 1회만");
        let NodeEvent::Add { id, kind, stage, blocked_by, .. } = &events[2];
        assert_eq!((id.as_str(), kind.as_str()), ("plan", "task"));
        assert_eq!(stage.as_deref(), Some("plan"));
        assert_eq!(blocked_by, &vec!["fact0".to_string(), "fact1".to_string()], "plan 은 fact 전부 검증 후");

        // plan stage — 요건 원장+fact 원장 렌더 → plan-unit 발행.
        let mut plan_agent = |prompt: &str, schema: Option<&Json>, _l: &str| -> Result<Json, String> {
            assert!(prompt.contains("PLANNER"), "plan 역할 프롬프트");
            assert!(prompt.contains("- [i0] [o] 요건A"), "{{{{ledger}}}} 렌더");
            assert!(prompt.contains("- [fact0] [o] (framework) 저장소: SQLite 채택"), "{{{{facts}}}} 렌더: {prompt}");
            assert!(schema.is_some_and(|s| s["required"][0] == "units"), "PLAN_SCHEMA 전달");
            Ok(json!({ "units": [ { "title": "재고 차감 구현", "pseudocode": "impl deduct([i0], [fact0])\nacceptance: 차감 후 잔량 일치" } ] }))
        };
        let plan_args = json!({ "stage": "plan", "directive": "정련 지시", "chunkRef": "K-7",
            "ledger": [{ "id": "i0", "title": "요건A", "badge": "o" }],
            "facts": [{ "id": "fact0", "title": "저장소: SQLite 채택", "badge": "o", "category": "framework" }] });
        let (pev, _pr) = run(&doc, "plan", &plan_args, &mut plan_agent).expect("plan 실행");
        assert_eq!(pev.len(), 1);
        let NodeEvent::Add { id, kind, parent, title, description, badge, .. } = &pev[0];
        assert_eq!((id.as_str(), kind.as_str()), ("unit0", "plan-unit"));
        assert_eq!(parent.as_deref(), Some("K-7"));
        assert_eq!(title, "재고 차감 구현");
        assert!(description.contains("acceptance"), "슈도코드 전문(검증 방법 포함) = description");
        assert!(badge.is_none(), "plan-unit 은 검증 파이프 비대상(badge 없음)");
    }

    #[test]
    fn concat_value_composes_from_plain_values() {
        let d = json!({ "spec": SPEC, "meta": {"name":"x","description":""},
            "values": { "A": "머리", "T": { "concat": [ {"$":"values.A"}, "-꼬리 {{title}}" ] } },
            "stages": { "": [ {"op":"publish","node":{"id":"n","kind":"chunk","title":{"$":"values.T"}}} ] } });
        let mut no_agent = |_p: &str, _s: Option<&Json>, _l: &str| -> Result<Json, String> { Err("x".into()) };
        let (events, _) = run(&d, "", &json!({}), &mut no_agent).unwrap();
        let NodeEvent::Add { title, .. } = &events[0];
        assert_eq!(title, "머리-꼬리 {{title}}", "조성 + 소비 시점 마커 보존");
    }

    #[test]
    fn events_serialize_same_wire_as_interp_path() {
        // relay(main.js handleEv) 가 파싱하는 wire — {"ev":"add", snake_case 필드}. interp 경로와 동일 serde.
        let (events, _) = run(&mini_doc(), "", &json!({ "directive": "d" }), &mut no_agent).unwrap();
        let line = serde_json::to_string(&events[0]).unwrap();
        assert!(line.contains("\"ev\":\"add\""), "{line}");
        assert!(line.contains("\"is_draft\":true"), "{line}");
        assert!(!line.contains("\"prompt\""), "빈 prompt 직렬화 생략(군더더기 0): {line}");
    }
}
