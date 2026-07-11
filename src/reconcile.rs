//! 워크플로 오케스트레이션 — main.js 에서 이식한 틱 로직·순수 헬퍼·Deps 경계.
//!
//! 무대 이전(PS17/PS18): main.js 가 들던 상태(reconcileState·runtime)와 커맨드 핸들러 로직을
//! 상주 서비스가 소유한다. Deps 는 kanban/scheduler IPC(production=중개 cmd, PS13)와 exec(in-process
//! provider/doc_exec) 를 추상화하는 seam — 테스트는 recording FakeDeps 로 주입한다(reconcile.test.mjs
//! 111케이스 이식). serve 하니스의 Emit.call 이 동기 블로킹이라 Deps 도 동기다.
//!
//! 봉투 규율(main.js envData): 크로스-플러그인 읽기는 {ok,data} 를 언랩하고 ok:false 는 None(무음 no-op).
//! 이 의미론을 Rust 반환 타입으로 보존한다(list→빈 vec, get→None, ...).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// 무판정(oxf 없음) 연속 상한 — 도달 시 badge=f 확정(fail-loud). main.js NO_VERDICT_MAX.
pub const NO_VERDICT_MAX: u32 = 3;
/// next lease 수명(ms) — CLI 실행자가 노드를 잡는 기간. main.js NEXT_LEASE_MS(30분).
pub const NEXT_LEASE_MS: u64 = 30 * 60 * 1000;

/// 칸반 노드 — kanban IPC 가 돌려주는 JSON 을 역직렬화. JS 는 camelCase(blockedBy/parentId).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Node {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(default, rename = "blockedBy", alias = "blocked_by")]
    pub blocked_by: Vec<String>,
    #[serde(default, rename = "parentId", alias = "parent_id", skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Node {
    fn badge_str(&self) -> &str {
        self.badge.as_deref().unwrap_or("")
    }
    fn body_str(&self) -> &str {
        self.body.as_deref().unwrap_or("")
    }
}

/// exec-stage 출력 3형(main.js :1148-1167). --assemble 은 별도 반환이라 여기 없음.
#[derive(Debug, Clone)]
pub enum StageOut {
    /// generate/draft-chunk → DraftDoc 객체.
    DraftDoc(Value),
    /// 일반 stage → 자식 add 이벤트 스트림 + result.
    Children { children: Vec<Value>, result: Value },
}

/// editNode 결과 — consumeStageOutput 이 ok:false 를 검사하므로 봉투를 보존.
#[derive(Debug, Clone)]
pub struct EditResult {
    pub ok: bool,
    pub message: Option<String>,
}
impl EditResult {
    pub fn ok() -> Self {
        Self { ok: true, message: None }
    }
    pub fn err(message: impl Into<String>) -> Self {
        Self { ok: false, message: Some(message.into()) }
    }
}

/// 오케스트레이션 의존 경계(main.js deps). production 은 중개 cmd(PS13)+in-process exec, 테스트는 FakeDeps.
/// presence 를 JS 가 검사하던 seam(assemble_stage 등)은 Option 반환으로 "미배선"을 표현(기본 None).
pub trait Deps {
    fn list_nodes(&self) -> Vec<Node>;
    fn get_node(&self, id: &str) -> Option<Node>;
    fn edit_node(&self, id: &str, fields: Value) -> EditResult;
    fn add_node(&self, params: Value) -> Option<String>;
    fn poke(&self);

    // exec seam — production=in-process provider/doc_exec. Err=throw(멱등: 노드 미변경).
    fn exec_one(&self, body: &str) -> Result<Value, String>;
    fn exec_stage(&self, body: &str) -> Result<StageOut, String>;

    // ledger/facts — kanban node.list 필터. Err=materialize 실패(throw).
    fn materialize_ledger(&self, chunk_id: &str) -> Result<Vec<Value>, String>;
    fn materialize_facts(&self, chunk_id: &str) -> Result<Vec<Value>, String>;

    // prompt 저장/해소 — kanban prompt.*.
    fn put_prompt(&self, value: Value) -> Option<String>;
    fn resolve_prompt(&self, _hash: &str, _vars: Value, _refs: Value) -> Option<Value> {
        None
    }
    fn get_prompt(&self, _hash: &str) -> Option<Value> {
        None
    }

    // pull(next/submit) seam — 미배선이면 None(검증 노드 경로).
    fn assemble_stage(&self, _body: &str) -> Option<Result<Value, String>> {
        None
    }
    fn exec_stage_with_output(&self, _body: &str, _out: Value) -> Option<Result<StageOut, String>> {
        None
    }

    // export — 파일 쓰기.
    fn write_file(&self, _rel: &str, _content: &str) {}
}

/// 지속 상태(main.js makeReconcileState) — 활성 수명, 재시작 리셋 허용.
#[derive(Default)]
pub struct ReconcileState {
    /// 항목별 연속 무판정 카운터(캡 NO_VERDICT_MAX).
    pub no_verdict: HashMap<String, u32>,
    /// 노드별 연속 실패 카운터(head-of-line 기아 방지).
    pub fails: HashMap<String, u32>,
    /// 노드별 lease 만료 epoch(ms) — CLI 실행자 점유.
    pub leases: HashMap<String, u64>,
    /// stage 조립 문맥(next 가 잡고 submit 이 재생).
    pub stage_ctx: HashMap<String, StageCtx>,
}

#[derive(Clone, Debug)]
pub struct StageCtx {
    pub stage_body: String,
    pub stage_name: String,
    pub ledger: Option<Vec<Value>>,
    pub body: String,
}

/// lease 활성 판정(만료 lazy 삭제) — main.js leaseActive.
pub fn lease_active(state: &mut ReconcileState, node_id: &str, now_ms: u64) -> bool {
    match state.leases.get(node_id).copied() {
        None => false,
        Some(exp) if exp <= now_ms => {
            state.leases.remove(node_id);
            false
        }
        Some(_) => true,
    }
}

// ── 순수 헬퍼 ────────────────────────────────────────────────────────────────

/// done 판정 — badge o/x/f 면 done, 아니면 status==="done". main.js isDone.
pub fn is_done(node: Option<&Node>) -> bool {
    let Some(n) = node else { return false };
    let b = n.badge_str();
    if !b.is_empty() {
        return b == "o" || b == "x" || b == "f";
    }
    n.status.as_deref() == Some("done")
}

// 부모 사슬로 chunk_id 자손인가(guard 100). main.js descends climb 공통.
fn descends(by_id: &HashMap<String, &Node>, node: &Node, chunk_id: &str) -> bool {
    let mut p = node.parent_id.clone();
    let mut guard = 0;
    while let Some(pid) = p {
        if guard >= 100 {
            break;
        }
        guard += 1;
        if pid == chunk_id {
            return true;
        }
        p = by_id.get(&pid).and_then(|n| n.parent_id.clone());
    }
    false
}

/// ready 노드 선택(main.js pickReady) — blockedBy 전부 done 인 미완 실행 대상.
/// 항목(badge=검수전 ∧ leaf) 또는 stage 작업(kind=task ∧ status≠done, #6 audit 게이트).
pub fn pick_ready(nodes: &[Node]) -> Vec<Node> {
    let by_id: HashMap<String, &Node> = nodes.iter().map(|n| (n.id.clone(), n)).collect();
    let mut has_child: HashSet<String> = HashSet::new();
    for n in nodes {
        if let Some(p) = &n.parent_id {
            has_child.insert(p.clone());
        }
    }
    let deps_done = |n: &Node| n.blocked_by.iter().all(|b| is_done(by_id.get(b).copied()));
    let chunk_has_pending = |chunk_id: &str| {
        nodes.iter().any(|n| {
            n.kind.as_deref() == Some("item") && n.badge_str() == "검수전" && descends(&by_id, n, chunk_id)
        })
    };
    let depends_on_task = |n: &Node| {
        n.blocked_by.iter().any(|b| by_id.get(b).map(|m| m.kind.as_deref() == Some("task")).unwrap_or(false))
    };
    nodes
        .iter()
        .filter(|n| {
            if !deps_done(n) {
                return false;
            }
            if n.badge_str() == "검수전" && !has_child.contains(&n.id) {
                return true; // 항목 검증
            }
            if n.kind.as_deref() == Some("task") && n.status.as_deref() != Some("done") {
                // #6 audit 게이트 — 덩어리에 검수전 항목 남아 있으면 not-ready.
                if let Some(pid) = &n.parent_id {
                    if depends_on_task(n) && chunk_has_pending(pid) {
                        return false;
                    }
                }
                return true; // stage 작업 실행
            }
            false
        })
        .cloned()
        .collect()
}

/// buildLedger — 덩어리 자손 중 지정 kind 를 ledger 엔트리로(exec-stage args 주입). main.js buildLedger.
pub fn build_ledger(nodes: &[Node], chunk_id: &str, kind: &str) -> Vec<Value> {
    let by_id: HashMap<String, &Node> = nodes.iter().map(|n| (n.id.clone(), n)).collect();
    nodes
        .iter()
        .filter(|n| n.kind.as_deref() == Some(kind) && descends(&by_id, n, chunk_id))
        .map(|n| {
            json!({
                "id": n.id,
                "title": n.title,
                "description": n.description,
                "badge": n.badge,
                "category": n.category,
            })
        })
        .collect()
}

/// exec-one {oxf,result} → node.edit 필드. oxf 유효면 badge 갱신, result 는 항상 기록. main.js execResultToEdit.
pub fn exec_result_to_edit(exec_out: &Value) -> Value {
    let oxf = exec_out.get("oxf").and_then(|v| v.as_str());
    let raw = exec_out.get("result");
    let result = match raw {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => "null".to_string(),
    };
    match oxf {
        Some(o) if o == "o" || o == "x" || o == "f" => json!({ "badge": o, "result": result }),
        _ => json!({ "result": result }),
    }
}

/// stage 발행 멱등 마커(main.js stagePublishedMarker) — 이미 발행됐으면 재실행 금지.
pub fn stage_published_marker(target: &Node, body: &str, stage_name: &str, nodes: &[Node]) -> bool {
    let Some(parent_id) = &target.parent_id else { return false };
    let hunt_blocked: HashSet<&String> = target.blocked_by.iter().collect();
    let child_of = |n: &Node| n.parent_id.as_ref() == Some(parent_id);
    match stage_name {
        "generate" => nodes
            .iter()
            .any(|n| child_of(n) && n.kind.as_deref() == Some("task") && n.id != target.id),
        "hunt" => nodes
            .iter()
            .any(|n| child_of(n) && n.kind.as_deref() == Some("item") && !hunt_blocked.contains(&n.id)),
        "research" => nodes.iter().any(|n| child_of(n) && n.kind.as_deref() == Some("fact")),
        "plan" => nodes.iter().any(|n| child_of(n) && n.kind.as_deref() == Some("plan-unit")),
        "body" => {
            let fp = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|v| v.get("args").and_then(|a| a.get("file_path")).and_then(|f| f.as_str()).map(String::from));
            match fp {
                Some(fp) => nodes.iter().any(|n| {
                    child_of(n)
                        && n.kind.as_deref() == Some("code")
                        && n.category.as_deref() == Some(fp.as_str())
                        && n.badge_str() != "f"
                        && n.badge_str() != "x"
                }),
                None => false,
            }
        }
        _ => false,
    }
}

/// directive 단일진실 — explicit > workflow-doc@0.0.1 refined > raw. main.js resolveDirective.
pub fn resolve_directive(explicit: Option<&str>, doc: Option<&Value>, raw: Option<&str>) -> Option<String> {
    if let Some(e) = explicit {
        if !e.trim().is_empty() {
            return Some(e.to_string());
        }
    }
    if let Some(d) = doc {
        if d.get("spec").and_then(|s| s.as_str()) == Some("workflow-doc@0.0.1") {
            if let Some(r) = d.pointer("/args/directive/default").and_then(|v| v.as_str()) {
                if !r.trim().is_empty() {
                    return Some(r.to_string());
                }
            }
        }
    }
    raw.map(String::from)
}

/// generate-skeleton CLI 인자 조립(main.js genSkeletonArgs). idea 필수. Err="idea 필수".
pub fn gen_skeleton_args(
    idea: Option<&str>,
    model: Option<&str>,
    refs: Option<&str>,
    gen_out: Option<&str>,
    lang: Option<&str>,
) -> Result<Vec<String>, String> {
    let idea = match idea {
        Some(i) if !i.is_empty() => i,
        _ => return Err("genSkeletonArgs: idea 필수".to_string()),
    };
    let mut args = vec![
        "generate-skeleton".to_string(),
        "--idea".to_string(),
        idea.to_string(),
        "--lang".to_string(),
        lang.unwrap_or("ko").to_string(),
    ];
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.into());
    }
    if let Some(r) = refs {
        args.push("--refs".into());
        args.push(r.into());
    }
    if let Some(g) = gen_out {
        args.push("--gen-out".into());
        args.push(g.into());
    }
    Ok(args)
}

/// secrets.keys() → spawn secretEnv 매핑(envVar→secretKey). "env:" prefix 만. main.js buildSecretEnvMap.
pub fn build_secret_env_map(keys: &[String]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for k in keys {
        if let Some(env_var) = k.strip_prefix("env:") {
            if !env_var.is_empty() {
                m.insert(env_var.to_string(), k.clone());
            }
        }
    }
    m
}

/// spawn 명령 조립(main.js buildSpawnCmd) — bin 명시면 직접, 기본 "sidecar:workflow" 이름 참조.
pub fn build_spawn_cmd(bin: Option<&str>, args: Vec<String>) -> (String, Vec<String>) {
    match bin {
        Some(b) if !b.is_empty() => (b.to_string(), args),
        _ => ("sidecar:workflow".to_string(), args),
    }
}

/// node.add 파라미터 조립(main.js buildAddParams) — ev(add 이벤트) → kanban node.add params.
/// task_ctx: workflowRef|skeleton+directive 를 task body 에 임베드. role_to_hash: prompt role→hash 매핑.
pub fn build_add_params(
    ev: &Value,
    parent_id: Option<&str>,
    blocked_by: &[String],
    task_ctx: Option<&Value>,
    role_to_hash: &HashMap<String, String>,
) -> Value {
    let s = |k: &str| ev.get(k).and_then(|v| v.as_str());
    let kind = s("kind");
    let body: String;
    if kind == Some("task") {
        let stage = s("stage").unwrap_or("generate");
        let directive = task_ctx.and_then(|c| c.get("directive")).cloned().unwrap_or(Value::Null);
        body = if let Some(wref) = task_ctx.and_then(|c| c.get("workflowRef")).and_then(|v| v.as_str()) {
            json!({ "workflow": wref, "stage": stage, "args": { "directive": directive, "chunkRef": parent_id } }).to_string()
        } else if let Some(sk) = task_ctx.and_then(|c| c.get("skeleton")) {
            json!({ "skeleton": sk, "stage": stage, "args": { "directive": directive, "chunkRef": parent_id } }).to_string()
        } else {
            json!({ "stage": stage }).to_string()
        };
    } else if let Some(role) = s("prompt_role").or_else(|| s("promptRole")) {
        let hash = role_to_hash.get(role).cloned();
        let vars = ev.get("vars").cloned().unwrap_or_else(|| json!({}));
        let var_refs = ev.get("var_refs").or_else(|| ev.get("varRefs"));
        let mut refs = serde_json::Map::new();
        if let Some(Value::Object(vr)) = var_refs {
            for (k, label) in vr {
                if let Some(label) = label.as_str() {
                    if let Some(h) = role_to_hash.get(label) {
                        refs.insert(k.clone(), json!(h));
                    }
                }
            }
        }
        let mut base = serde_json::Map::new();
        base.insert("promptHash".into(), json!(hash));
        base.insert("vars".into(), vars);
        if !refs.is_empty() {
            base.insert("refs".into(), Value::Object(refs));
        }
        let schema_ref = s("schema_ref").or_else(|| s("schemaRef"));
        let schema_hash = schema_ref.and_then(|l| role_to_hash.get(l).cloned());
        if let Some(sh) = schema_hash {
            base.insert("schemaHash".into(), json!(sh));
        } else if let Some(schema) = ev.get("schema") {
            base.insert("schema".into(), schema.clone());
        }
        body = Value::Object(base).to_string();
    } else if let Some(prompt) = s("prompt") {
        body = if let Some(schema) = ev.get("schema") {
            json!({ "prompt": prompt, "schema": schema }).to_string()
        } else {
            json!({ "prompt": prompt }).to_string()
        };
    } else {
        body = String::new();
    }

    let title = s("title").or(kind).unwrap_or("");
    let mut params = serde_json::Map::new();
    params.insert("title".into(), json!(title));
    params.insert("parentId".into(), json!(parent_id));
    params.insert("body".into(), json!(body));
    params.insert("blockedBy".into(), json!(blocked_by));
    params.insert("locked".into(), json!(true));
    params.insert("type".into(), json!("task"));
    if let Some(k) = kind {
        params.insert("kind".into(), json!(k));
    }
    if let Some(c) = s("category") {
        params.insert("category".into(), json!(c));
    }
    if let Some(d) = s("description") {
        params.insert("description".into(), json!(d));
    }
    if let Some(o) = s("origin") {
        params.insert("origin".into(), json!(o));
    }
    if let Some(b) = s("badge") {
        params.insert("badge".into(), json!(b));
    }
    if ev.get("is_draft").and_then(|v| v.as_bool()).unwrap_or(false) {
        params.insert("isDraft".into(), json!(true));
    }
    if let Some(pd) = s("parent_draft_id") {
        params.insert("parentDraftId".into(), json!(pd));
    }
    Value::Object(params)
}

#[cfg(test)]
#[path = "reconcile_tests.rs"]
mod tests;
