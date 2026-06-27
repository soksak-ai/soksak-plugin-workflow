//! exec — 골격 실행기. steps 를 순서대로 walk, agent 를 runner 로 실행한다.
//! runner 주입식 — e2e 는 claude -p(provider), 단위테스트는 fake. directive 프롬프트의
//! ${placeholder} 를 args 로 바인딩 + schema 본문을 출력 형식 지시로 append.
//! 현재: 순차(parallel/pipeline 내부 agent 도 순서 실행). 동시성은 다음 단계.

use crate::skeleton::Skeleton;
use serde_json::{Map, Value};

const SCHEMA_INSTRUCTION: &str =
    "\n\n## Output format\nReturn ONLY a JSON object — no markdown fence, no prose, no explanation — conforming to this JSON Schema:\n";

/// AgentInvocation — runner 에 넘기는 한 agent 의 실행 사양.
pub struct AgentInvocation {
    pub label: String,
    pub schema: Option<String>,
    pub model: String,
    pub prompt: String,
}

/// AgentResult — 한 agent 의 실행 결과.
#[derive(Debug, Clone)]
pub struct AgentResult {
    pub label: String,
    pub phase: Option<String>,
    pub schema: Option<String>,
    pub output: Value,
}

/// bind_context — directive 텍스트의 `${expr}` 를 context(args + 앞선 agent 출력)에서 해소.
/// expr 이 단순 dot-path(`scope.angles`)면 해당 값으로 치환(객체/배열은 JSON). 메서드콜·연산
/// (`Q.slice(0,80)`) 등 비-path 는 미바인딩으로 보존(${expr} 그대로). UTF-8 안전.
pub fn bind_context(text: &str, ctx: &Map<String, Value>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("${") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 2..];
        match find_close_brace(after) {
            Some(close) => {
                let expr = &after[..close];
                match resolve_path(ctx, expr) {
                    Some(v) => out.push_str(&value_to_str(&v)),
                    None => {
                        out.push_str("${");
                        out.push_str(expr);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// find_close_brace — `${` 직후 문자열에서 균형 잡힌 닫는 `}` 의 byte 인덱스.
fn find_close_brace(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 1i32;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// resolve_path — 단순 dot-path 만 context 에서 해소. 그 외(공백·괄호·연산자)는 None.
fn resolve_path(ctx: &Map<String, Value>, expr: &str) -> Option<Value> {
    let expr = expr.trim();
    if expr.is_empty() || !expr.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') {
        return None;
    }
    let mut parts = expr.split('.');
    let first = parts.next()?;
    let mut cur = ctx.get(first)?.clone();
    for p in parts {
        cur = cur.get(p)?.clone();
    }
    Some(cur)
}

fn value_to_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// 동시 실행 상한(glm-5.2 의 8-concurrent 에 맞춤).
const FANOUT_CONCURRENCY: usize = 8;

/// run_skeleton — steps 실행. 순차 agent 는 inline, fan-out 은 청크(≤8) 동시 실행.
/// runner 는 Fn+Sync — claude -p provider 는 stateless·thread-safe(프로세스 spawn).
pub fn run_skeleton<F>(skel: &Skeleton, args: &Map<String, Value>, runner: F) -> Result<Vec<AgentResult>, String>
where
    F: Fn(&AgentInvocation, Option<&Value>) -> Result<Value, String> + Sync,
{
    // ctx = args + 앞선 agent 출력(label 키). threading 의 단일 진실.
    let mut ctx: Map<String, Value> = args.clone();
    let mut results: Vec<AgentResult> = vec![];
    for step in &skel.steps {
        match step.kind.as_str() {
            "agent" => {
                let r = run_one(skel, step.label.clone(), step.directive_ref, &step.schema, &step.model, step.phase.clone(), &ctx, &runner)?;
                ctx.insert(r.label.clone(), r.output.clone());
                results.push(r);
            }
            "parallel" | "pipeline" => {
                let agents = step.agents.clone().unwrap_or_default();
                // fan-out: axis 가 context 에서 배열로 해소되면 element 별 실행(itemParam 바인딩).
                let fanned = step
                    .axis
                    .as_ref()
                    .and_then(|ax| resolve_path(&ctx, ax))
                    .and_then(|v| v.as_array().cloned());
                match (fanned, &step.item_param) {
                    (Some(items), Some(item_param)) if !items.is_empty() => {
                        // item 별 step.agents 실행 — 청크(≤FANOUT_CONCURRENCY) 동시. 순서 보존.
                        let mut per_item: Vec<Vec<AgentResult>> = Vec::with_capacity(items.len());
                        for chunk in items.chunks(FANOUT_CONCURRENCY) {
                            let chunk_out: Vec<Result<Vec<AgentResult>, String>> = std::thread::scope(|s| {
                                let handles: Vec<_> = chunk
                                    .iter()
                                    .map(|item| s.spawn(|| run_item(skel, &agents, item_param, item, step.phase.as_ref(), &ctx, &runner)))
                                    .collect();
                                handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("fan-out thread panic".to_string()))).collect()
                            });
                            for r in chunk_out {
                                per_item.push(r?);
                            }
                        }
                        // 결과를 label→배열 로 context 누적(downstream threading). 순서 = item 순.
                        let mut collected: std::collections::BTreeMap<String, Vec<Value>> = std::collections::BTreeMap::new();
                        for item_res in per_item {
                            for r in item_res {
                                collected.entry(r.label.clone()).or_default().push(r.output.clone());
                                results.push(r);
                            }
                        }
                        for (label, outs) in collected {
                            ctx.insert(label, Value::Array(outs));
                        }
                    }
                    _ => {
                        // axis 없음/미해소 → 선언된 agent 1회씩.
                        for a in &agents {
                            let r = run_one(skel, a.label.clone(), a.directive_ref, &a.schema, &a.model, a.phase.clone().or_else(|| step.phase.clone()), &ctx, &runner)?;
                            ctx.insert(r.label.clone(), r.output.clone());
                            results.push(r);
                        }
                    }
                }
            }
            _ => {} // phase / log / workflow — 오케스트레이션 마커(no-op)
        }
    }
    Ok(results)
}

/// run_item — fan-out 한 element 에 대해 step 의 agents 전부 실행(item_param 바인딩).
fn run_item<F>(
    skel: &Skeleton,
    agents: &[crate::skeleton::Agent],
    item_param: &str,
    item: &Value,
    step_phase: Option<&String>,
    ctx: &Map<String, Value>,
    runner: &F,
) -> Result<Vec<AgentResult>, String>
where
    F: Fn(&AgentInvocation, Option<&Value>) -> Result<Value, String> + Sync,
{
    let mut item_ctx = ctx.clone();
    item_ctx.insert(item_param.to_string(), item.clone());
    let mut out = vec![];
    for a in agents {
        let r = run_one(skel, a.label.clone(), a.directive_ref, &a.schema, &a.model, a.phase.clone().or_else(|| step_phase.cloned()), &item_ctx, runner)?;
        out.push(r);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn run_one<F>(
    skel: &Skeleton,
    label: Option<String>,
    directive_ref: Option<usize>,
    schema: &Option<String>,
    model: &Option<String>,
    phase: Option<String>,
    ctx: &Map<String, Value>,
    runner: &F,
) -> Result<AgentResult, String>
where
    F: Fn(&AgentInvocation, Option<&Value>) -> Result<Value, String>,
{
    let prompt = build_prompt(skel, directive_ref, schema, ctx);
    let schema_body = skel.schema_body(schema);
    let label = label.unwrap_or_else(|| "agent".to_string());
    let model = effective_model(model);
    let inv = AgentInvocation { label: label.clone(), schema: schema.clone(), model, prompt };
    let output = runner(&inv, schema_body).map_err(|e| format!("agent {label:?}: {e}"))?;
    Ok(AgentResult { label, phase, schema: schema.clone(), output })
}

/// build_prompt — directive(${placeholder} 바인딩) + schema 본문 출력 지시.
fn build_prompt(skel: &Skeleton, directive_ref: Option<usize>, schema: &Option<String>, ctx: &Map<String, Value>) -> String {
    let dir = skel.directive_text(directive_ref).unwrap_or("");
    let mut prompt = bind_context(dir, ctx);
    if let Some(body) = skel.schema_body(schema) {
        prompt.push_str(SCHEMA_INSTRUCTION);
        prompt.push_str(&serde_json::to_string_pretty(body).unwrap_or_default());
    }
    prompt
}

/// effective_model — 골격 model 또는 기본 opus(인증 프로필 에서 glm-5.2 로 매핑).
fn effective_model(model: &Option<String>) -> String {
    model.clone().unwrap_or_else(|| "opus".to_string())
}

/// AgentPlan — dry-run 실행 계획의 한 agent(실행 없이 미리보기).
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentPlan {
    pub step_index: usize,
    pub label: String,
    pub phase: Option<String>,
    pub model: String,
    pub schema: Option<String>,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fanout_axis: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fanout_item: Option<String>,
}

/// plan_skeleton — 실행 없이 실행 계획 산출(dry-run). 각 agent 의 resolved 프롬프트(args·
/// ③파생 바인딩, fan-out item/이전 출력 placeholder 는 ${...} 보존)·model·schema·fan-out 표시.
pub fn plan_skeleton(skel: &Skeleton, args: &Map<String, Value>) -> Vec<AgentPlan> {
    let ctx = args.clone();
    let mut plan: Vec<AgentPlan> = vec![];
    for step in &skel.steps {
        match step.kind.as_str() {
            "agent" => plan.push(AgentPlan {
                step_index: step.index,
                label: step.label.clone().unwrap_or_else(|| "agent".into()),
                phase: step.phase.clone(),
                model: effective_model(&step.model),
                schema: step.schema.clone(),
                prompt: build_prompt(skel, step.directive_ref, &step.schema, &ctx),
                fanout_axis: None,
                fanout_item: None,
            }),
            "parallel" | "pipeline" => {
                if let Some(agents) = &step.agents {
                    for a in agents {
                        plan.push(AgentPlan {
                            step_index: step.index,
                            label: a.label.clone().unwrap_or_else(|| "agent".into()),
                            phase: a.phase.clone().or_else(|| step.phase.clone()),
                            model: effective_model(&a.model),
                            schema: a.schema.clone(),
                            prompt: build_prompt(skel, a.directive_ref, &a.schema, &ctx),
                            fanout_axis: step.axis.clone(),
                            fanout_item: step.item_param.clone(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn demo_skeleton() -> Skeleton {
        let raw = serde_json::to_vec(&json!({
            "ir": "workflow-skeleton@1",
            "meta": { "name": "demo" },
            "steps": [
                { "index": 0, "kind": "phase", "phase": "A", "title": "A" },
                { "index": 1, "kind": "agent", "label": "scope", "schema": "SCOPE_SCHEMA", "directiveRef": 0, "phase": "A" },
                { "index": 2, "kind": "pipeline", "phase": "A", "stages": 1, "agents": [
                    { "label": "synth", "schema": "REPORT_SCHEMA", "directiveRef": 1, "phase": "A" }
                ]}
            ],
            "directives": [
                { "index": 0, "text": "Decompose ${QUESTION}", "placeholders": ["QUESTION"] },
                { "index": 1, "text": "Synthesize report", "placeholders": [] }
            ],
            "schemas": {
                "SCOPE_SCHEMA": { "type": "object", "properties": { "angles": { "type": "array" } } },
                "REPORT_SCHEMA": { "type": "object", "properties": { "report": { "type": "string" } } }
            }
        }))
        .unwrap();
        Skeleton::from_json(&raw).unwrap()
    }

    #[test]
    fn binds_context_path_and_preserves_unbound() {
        let mut ctx = Map::new();
        ctx.insert("QUESTION".into(), json!("How does X work?"));
        ctx.insert("scope".into(), json!({ "angles": ["a", "b"] }));
        // 단순 키.
        assert_eq!(bind_context("Decompose ${QUESTION}", &ctx), "Decompose How does X work?");
        // dot-path → 앞선 agent 출력(객체는 JSON).
        assert_eq!(bind_context("Use ${scope.angles}", &ctx), r#"Use ["a","b"]"#);
        // 미해소(컨텍스트에 없음) 보존.
        assert_eq!(bind_context("${angle.label}", &ctx), "${angle.label}");
        // 비-path(메서드콜)는 보존.
        assert_eq!(bind_context("${QUESTION.slice(0, 80)}", &ctx), "${QUESTION.slice(0, 80)}");
    }

    #[test]
    fn threads_prior_agent_output_to_next_prompt() {
        // scope 출력을 plan 프롬프트가 ${scope.angles} 로 받는다.
        let raw = serde_json::to_vec(&json!({
            "ir": "workflow-skeleton@1",
            "meta": { "name": "thread" },
            "steps": [
                { "index": 0, "kind": "agent", "label": "scope", "schema": "S", "directiveRef": 0 },
                { "index": 1, "kind": "agent", "label": "plan", "schema": "S", "directiveRef": 1 }
            ],
            "directives": [
                { "index": 0, "text": "Decompose ${IDEA}" },
                { "index": 1, "text": "Plan using angles: ${scope.angles}" }
            ],
            "schemas": { "S": { "type": "object" } }
        }))
        .unwrap();
        let skel = Skeleton::from_json(&raw).unwrap();
        let mut args = Map::new();
        args.insert("IDEA".into(), json!("a tracker"));
        let prompts: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(vec![]);
        run_skeleton(&skel, &args, |inv, _s| {
            prompts.lock().unwrap().push(inv.prompt.clone());
            // scope 는 angles 출력, plan 은 아무거나.
            if inv.label == "scope" {
                Ok(json!({ "angles": ["x", "y"] }))
            } else {
                Ok(json!({ "ok": true }))
            }
        })
        .unwrap();
        let prompts = prompts.into_inner().unwrap();
        // scope 프롬프트: IDEA 바인딩.
        assert!(prompts[0].contains("Decompose a tracker"));
        // plan 프롬프트: scope 출력이 threading 됨.
        assert!(prompts[1].contains(r#"angles: ["x","y"]"#), "plan 프롬프트에 scope 출력 threading: {}", prompts[1]);
    }

    #[test]
    fn runs_agents_in_order_with_fake_runner() {
        let skel = demo_skeleton();
        let mut args = Map::new();
        args.insert("QUESTION".into(), json!("Q"));
        let seen_prompts: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(vec![]);
        let results = run_skeleton(&skel, &args, |inv, schema_body| {
            seen_prompts.lock().unwrap().push(inv.prompt.clone());
            // schema 본문이 전달됨.
            assert!(schema_body.is_some(), "agent 에 schema 본문 전달");
            // label 별 가짜 출력.
            Ok(json!({ "from": inv.label }))
        })
        .unwrap();
        let seen_prompts = seen_prompts.into_inner().unwrap();
        // agent(scope) + pipeline 내부 agent(synth) = 2 결과.
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].label, "scope");
        assert_eq!(results[1].label, "synth");
        // scope 프롬프트: placeholder 바인딩 + schema 지시 포함.
        assert!(seen_prompts[0].contains("Decompose Q"));
        assert!(seen_prompts[0].contains("Output format"));
        assert!(seen_prompts[0].contains("angles"));
    }

    #[test]
    fn fans_out_over_axis_array() {
        let raw = serde_json::to_vec(&json!({
            "ir": "workflow-skeleton@1",
            "meta": { "name": "fanout" },
            "steps": [
                { "index": 0, "kind": "agent", "label": "scope", "schema": "S", "directiveRef": 0 },
                { "index": 1, "kind": "parallel", "axis": "scope.angles", "itemParam": "angle",
                  "agents": [ { "label": "search", "schema": "S", "directiveRef": 1 } ] },
                { "index": 2, "kind": "agent", "label": "synth", "schema": "S", "directiveRef": 2 }
            ],
            "directives": [
                { "index": 0, "text": "scope ${IDEA}" },
                { "index": 1, "text": "search angle ${angle.label}" },
                { "index": 2, "text": "synth from ${search}" }
            ],
            "schemas": { "S": { "type": "object" } }
        }))
        .unwrap();
        let skel = Skeleton::from_json(&raw).unwrap();
        let mut args = Map::new();
        args.insert("IDEA".into(), json!("x"));
        let search_prompts: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(vec![]);
        let synth_prompt: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
        let results = run_skeleton(&skel, &args, |inv, _s| match inv.label.as_str() {
            "scope" => Ok(json!({ "angles": [{ "label": "a1" }, { "label": "a2" }, { "label": "a3" }] })),
            "search" => {
                search_prompts.lock().unwrap().push(inv.prompt.clone());
                Ok(json!({ "found": inv.label }))
            }
            "synth" => {
                *synth_prompt.lock().unwrap() = inv.prompt.clone();
                Ok(json!({ "ok": true }))
            }
            _ => Ok(json!({})),
        })
        .unwrap();
        let search_prompts = search_prompts.into_inner().unwrap();
        let synth_prompt = synth_prompt.into_inner().unwrap();
        // search 가 angle 3개에 대해 3회 실행(fan-out). 동시 실행이라 순서 비결정 → 집합 검증.
        assert_eq!(search_prompts.len(), 3);
        let joined = search_prompts.join("|");
        assert!(joined.contains("search angle a1"));
        assert!(joined.contains("search angle a2"));
        assert!(joined.contains("search angle a3"));
        // synth: search fan-out 출력이 배열로 threading(item 순서 보존 — 결정적).
        assert!(synth_prompt.contains("synth from ["), "synth threading: {synth_prompt}");
        // scope(1) + search(3) + synth(1) = 5.
        assert_eq!(results.len(), 5);
    }

    #[test]
    fn runner_error_propagates() {
        let skel = demo_skeleton();
        let r = run_skeleton(&skel, &Map::new(), |_inv, _s| Err("boom".to_string()));
        assert!(r.is_err());
    }
}
