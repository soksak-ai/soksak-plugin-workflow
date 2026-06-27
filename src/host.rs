//! host — 인터프리터의 agent 호출을 실제로 처리하는 host 구현.
//!   ClaudeHost: agent → claude -p(인증 프로필 GLM). 워크플로를 진짜로 실행.
//!   StubHost:   agent → 호출 기록 + 스키마 모양 통과 placeholder(LLM 미호출). dry-run 미리보기.
//! 런타임은 program 을 해석하고, LLM 효과만 이 host 로 위임한다.

use crate::interp::{json_to_val, val_to_json, Host, Val};
use crate::provider::{run_agent, AgentRequest};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

const SCHEMA_INSTRUCTION: &str =
    "\n\n## Output format\nReturn ONLY a JSON object — no markdown fence, no prose, no explanation — conforming to this JSON Schema:\n";

fn opt_str(opts: &BTreeMap<String, Val>, key: &str) -> Option<String> {
    match opts.get(key) {
        Some(Val::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// agent 프롬프트 = 본문 + (schema 있으면) 출력 형식 지시.
fn build_prompt(prompt: &str, opts: &BTreeMap<String, Val>) -> String {
    let mut full = prompt.to_string();
    if let Some(schema) = opts.get("schema") {
        let sj = val_to_json(schema);
        if sj.is_object() {
            full.push_str(SCHEMA_INSTRUCTION);
            full.push_str(&serde_json::to_string_pretty(&sj).unwrap_or_default());
        }
    }
    full
}

/// 스키마 required 를 통과값으로 채운 stub(dry-run). status 는 done/validated/partial.
fn stub_from_schema(schema: Option<&Val>) -> Val {
    let sj = schema.map(val_to_json).unwrap_or(Json::Null);
    Val::Obj(std::rc::Rc::new(std::cell::RefCell::new(stub_obj(&sj))))
}
fn stub_obj(schema: &Json) -> BTreeMap<String, Val> {
    let mut o = BTreeMap::new();
    let req = schema.get("required").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let props = schema.get("properties").and_then(|p| p.as_object());
    for k in req {
        let key = k.as_str().unwrap_or("").to_string();
        let p = props.and_then(|m| m.get(&key));
        let ty = p.and_then(|x| x.get("type")).and_then(|t| t.as_str()).unwrap_or("string");
        let v = if key == "status" {
            let en = p.and_then(|x| x.get("enum")).and_then(|e| e.as_array());
            let pick = ["done", "validated", "partial"]
                .iter()
                .find(|s| en.map_or(true, |a| a.iter().any(|x| x.as_str() == Some(**s))))
                .copied()
                .unwrap_or("done");
            Val::Str(pick.to_string())
        } else {
            match ty {
                "array" => Val::Arr(std::rc::Rc::new(std::cell::RefCell::new(vec![]))),
                "object" => Val::Obj(std::rc::Rc::new(std::cell::RefCell::new(p.map(stub_obj).unwrap_or_default()))),
                "number" | "integer" => Val::Num(0.0),
                "boolean" => Val::Bool(true),
                _ => Val::Str(format!("<{key}>")),
            }
        };
        o.insert(key, v);
    }
    o
}

/// ClaudeHost — agent 를 claude -p(인증 프로필)로 실행.
pub struct ClaudeHost {
    pub env: Vec<(String, String)>,
    pub allow_tools: Vec<String>,
    pub default_model: String,
}
impl Host for ClaudeHost {
    fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String> {
        let model = opt_str(opts, "model").unwrap_or_else(|| self.default_model.clone());
        let label = opt_str(opts, "label").unwrap_or_default();
        let full = build_prompt(prompt, opts);
        eprintln!("[soksak] agent {label:?} (model={model}) → claude -p");
        match run_agent(&AgentRequest { prompt: full, model: &model, allowed_tools: self.allow_tools.clone() }, &self.env) {
            Ok(out) => Ok(json_to_val(&out)),
            // agent 실패 → null(engine 계약: agent 는 실패 시 null).
            Err(e) => {
                eprintln!("[soksak] agent {label:?} 실패 → null: {e}");
                Ok(Val::Null)
            }
        }
    }
    fn phase(&mut self, title: &str) {
        eprintln!("[soksak] ── phase: {title} ──");
    }
    fn log(&mut self, msg: &str) {
        eprintln!("[soksak] {msg}");
    }
}

/// StubHost — agent 미호출, 호출 trace 기록 + 스키마 stub. dry-run.
pub struct StubHost {
    pub trace: Vec<Json>,
    pub default_model: String,
    seq: usize,
}
impl StubHost {
    pub fn new(default_model: String) -> Self {
        StubHost { trace: vec![], default_model, seq: 0 }
    }
}
impl Host for StubHost {
    fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String> {
        self.seq += 1;
        let label = opt_str(opts, "label").unwrap_or_default();
        let model = opt_str(opts, "model").unwrap_or_else(|| self.default_model.clone());
        let schema_required = opts
            .get("schema")
            .map(val_to_json)
            .and_then(|s| s.get("required").cloned());
        self.trace.push(json!({
            "seq": self.seq,
            "label": label,
            "model": model,
            "schemaRequired": schema_required,
            "promptHead": prompt.chars().take(160).collect::<String>(),
            "promptLen": prompt.chars().count(),
        }));
        Ok(stub_from_schema(opts.get("schema")))
    }
    fn phase(&mut self, title: &str) {
        self.trace.push(json!({ "phase": title }));
    }
    fn log(&mut self, msg: &str) {
        self.trace.push(json!({ "log": msg }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interp::Interp;

    #[test]
    fn stub_host_dry_run_captures_full_cockpit() {
        // StubHost 로 cockpit 해석 → agent trace 에 전 agent(9). agent 수는 워크플로가 정함.
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/cockpit.skeleton.json")).unwrap();
        let program = skeleton.get("program").unwrap();
        let mut h = StubHost::new("opus".into());
        Interp::new(&mut h).run(program, Json::Null).unwrap();
        let agents: Vec<String> = h
            .trace
            .iter()
            .filter_map(|t| t.get("label").and_then(|l| l.as_str()).map(String::from))
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(agents.len(), 9, "dry-run 도 실행이라 전 agent: {agents:?}");
        for id in ["S0", "C1", "C2", "C3", "SPK-b", "SPK-c", "SPK-d", "T1", "T3"] {
            assert!(agents.iter().any(|a| a == id), "{id} 누락");
        }
    }

    #[test]
    fn stub_schema_status_passes_gates() {
        let mut sc = BTreeMap::new();
        sc.insert(
            "schema".to_string(),
            json_to_val(&json!({ "type": "object", "required": ["id", "status"], "properties": { "status": { "enum": ["done", "blocked"] } } })),
        );
        let stub = stub_from_schema(sc.get("schema"));
        if let Val::Obj(o) = stub {
            assert_eq!(crate::interp::to_string(o.borrow().get("status").unwrap()), "done");
        } else {
            panic!("obj");
        }
    }
}
