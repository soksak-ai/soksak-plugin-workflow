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

/// run_skeleton — steps 순차 실행. runner(inv, schema_body) → agent 출력.
pub fn run_skeleton<F>(skel: &Skeleton, args: &Map<String, Value>, mut runner: F) -> Result<Vec<AgentResult>, String>
where
    F: FnMut(&AgentInvocation, Option<&Value>) -> Result<Value, String>,
{
    // ctx = args + 앞선 agent 출력(label 키). threading 의 단일 진실.
    let mut ctx: Map<String, Value> = args.clone();
    let mut results: Vec<AgentResult> = vec![];
    for step in &skel.steps {
        match step.kind.as_str() {
            "agent" => {
                let r = run_one(skel, step.label.clone(), step.directive_ref, &step.schema, &step.model, step.phase.clone(), &ctx, &mut runner)?;
                ctx.insert(r.label.clone(), r.output.clone());
                results.push(r);
            }
            "parallel" | "pipeline" => {
                if let Some(agents) = &step.agents {
                    for a in agents {
                        let r = run_one(skel, a.label.clone(), a.directive_ref, &a.schema, &a.model, a.phase.clone().or_else(|| step.phase.clone()), &ctx, &mut runner)?;
                        ctx.insert(r.label.clone(), r.output.clone());
                        results.push(r);
                    }
                }
            }
            _ => {} // phase / log / workflow — 오케스트레이션 마커(no-op)
        }
    }
    Ok(results)
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
    runner: &mut F,
) -> Result<AgentResult, String>
where
    F: FnMut(&AgentInvocation, Option<&Value>) -> Result<Value, String>,
{
    let dir = skel.directive_text(directive_ref).unwrap_or("");
    let mut prompt = bind_context(dir, ctx);
    let schema_body = skel.schema_body(schema);
    if let Some(body) = schema_body {
        prompt.push_str(SCHEMA_INSTRUCTION);
        prompt.push_str(&serde_json::to_string_pretty(body).unwrap_or_default());
    }
    let label = label.unwrap_or_else(|| "agent".to_string());
    let model = model.clone().unwrap_or_else(|| "sonnet".to_string());
    let inv = AgentInvocation { label: label.clone(), schema: schema.clone(), model, prompt };
    let output = runner(&inv, schema_body).map_err(|e| format!("agent {label:?}: {e}"))?;
    Ok(AgentResult { label, phase, schema: schema.clone(), output })
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
        let mut prompts: Vec<String> = vec![];
        run_skeleton(&skel, &args, |inv, _s| {
            prompts.push(inv.prompt.clone());
            // scope 는 angles 출력, plan 은 아무거나.
            if inv.label == "scope" {
                Ok(json!({ "angles": ["x", "y"] }))
            } else {
                Ok(json!({ "ok": true }))
            }
        })
        .unwrap();
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
        let mut seen_prompts: Vec<String> = vec![];
        let results = run_skeleton(&skel, &args, |inv, schema_body| {
            seen_prompts.push(inv.prompt.clone());
            // schema 본문이 전달됨.
            assert!(schema_body.is_some(), "agent 에 schema 본문 전달");
            // label 별 가짜 출력.
            Ok(json!({ "from": inv.label }))
        })
        .unwrap();
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
    fn runner_error_propagates() {
        let skel = demo_skeleton();
        let r = run_skeleton(&skel, &Map::new(), |_inv, _s| Err("boom".to_string()));
        assert!(r.is_err());
    }
}
