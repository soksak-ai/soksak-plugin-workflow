//! host — 인터프리터의 agent 호출을 실제로 처리하는 host 구현.
//!   ClaudeHost: agent → claude -p(인증 프로필 GLM). exec-stage/exec-one 의 claude 러너(단위 agent 실행).
//! stub_from_schema 는 발행 호스트(--emit)가 LLM 없이 interp 데이터 흐름을 잇는 데 공유한다.
//! 런타임은 program 을 해석하고, LLM 효과만 이 host 로 위임한다.

use crate::interp::{json_to_val, val_to_json, Host, Val};
use crate::lang::Language;
use crate::provider::{run_agent, run_agent_text, AgentRequest};
use serde_json::Value as Json;
use std::collections::BTreeMap;

const SCHEMA_INSTRUCTION: &str =
    "\n\n## Output format\nReturn ONLY a JSON object — no markdown fence, no prose, no explanation — conforming to this JSON Schema:\n";

fn opt_str(opts: &BTreeMap<String, Val>, key: &str) -> Option<String> {
    match opts.get(key) {
        Some(Val::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// build_prompt_with_schema — Json schema 로 프롬프트 조립(exec-one/exec-stage 러너 공유).
/// 언어 계약을 schema 뒤에 둔다 — 계약이 "the schema" 를 가리키고, 모델이 마지막에 읽는다.
/// 본문 → schema 지시 → 언어 계약 순(build_prompt 와 동일 계약).
pub fn build_prompt_with_schema(prompt: &str, schema: Option<&Json>, lang: Option<&Language>) -> String {
    let mut full = prompt.to_string();
    if let Some(sj) = schema {
        if sj.is_object() {
            full.push_str(SCHEMA_INSTRUCTION);
            full.push_str(&serde_json::to_string_pretty(sj).unwrap_or_default());
        }
    }
    if let Some(l) = lang {
        full.push_str(&l.contract());
    }
    full
}

/// 스키마 required 를 통과값으로 채운 stub(dry-run). status 는 done/validated/partial.
/// 배열은 데이터 의존 fan-out 이 dry-run 에서도 한 번 타도록 샘플 1개를 채운다(실 카운트는
/// 실행 시 agent 출력이 정함 — dry-run 은 구조 미리보기).
/// 발행 전용 EmitHost(--emit)도 이 stub 으로 interp 데이터 흐름을 잇는다(LLM 미호출).
pub fn stub_from_schema(schema: Option<&Val>) -> Val {
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
        let ptype = p.and_then(|x| x.get("type")).and_then(|t| t.as_str());
        let v = if key == "status" {
            let en = p.and_then(|x| x.get("enum")).and_then(|e| e.as_array());
            let pick = ["done", "validated", "partial"]
                .iter()
                .find(|s| en.map_or(true, |a| a.iter().any(|x| x.as_str() == Some(**s))))
                .copied()
                .unwrap_or("done");
            Val::Str(pick.to_string())
        } else if ptype == Some("boolean") {
            // status enum 을 pass 값으로 고르듯, boolean 도 필드명 의미로 success 경로를 탄다
            // (dry-run 은 전체 구조 미리보기 — 게이트가 부정 플래그로 조기차단되면 하류 미관측).
            Val::Bool(stub_bool(&key))
        } else {
            stub_value(p.unwrap_or(&Json::Null))
        };
        o.insert(key, v);
    }
    o
}
/// boolean stub — 부정 의미 필드명(refuted/failed/blocked…)은 false, 그 외 true.
/// dry-run 이 success 경로를 타 전체 fan-out 구조를 관측하게 한다(status enum pass-pick 과 동형).
fn stub_bool(key: &str) -> bool {
    const NEGATIVE: [&str; 16] = [
        "refuted", "failed", "fail", "error", "blocked", "skip", "skipped", "dead", "invalid",
        "missing", "broken", "stale", "dropped", "killed", "rejected", "duplicate",
    ];
    let lk = key.to_lowercase();
    !NEGATIVE.iter().any(|n| lk.contains(n))
}
fn stub_value(schema: &Json) -> Val {
    use std::cell::RefCell;
    use std::rc::Rc;
    match schema.get("type").and_then(|t| t.as_str()).unwrap_or("string") {
        "object" => Val::Obj(Rc::new(RefCell::new(stub_obj(schema)))),
        "array" => {
            // 샘플 1개 — fan-out/.map 등이 dry-run 에서도 한 번 실행되도록.
            let one = schema.get("items").map(stub_value).unwrap_or(Val::Str("<item>".into()));
            Val::Arr(Rc::new(RefCell::new(vec![one])))
        }
        "number" | "integer" => Val::Num(0.0),
        "boolean" => Val::Bool(true),
        _ => {
            if let Some(en) = schema.get("enum").and_then(|e| e.as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()) {
                Val::Str(en.to_string())
            } else {
                Val::Str("<v>".to_string())
            }
        }
    }
}

/// ClaudeHost — agent 를 claude -p(인증 프로필)로 실행.
pub struct ClaudeHost {
    pub env: Vec<(String, String)>,
    pub allow_tools: Vec<String>,
    pub default_model: String,
    /// 출력 언어 계약(있으면 모든 agent 프롬프트에 주입). None = 워크플로/모델 기본.
    pub lang: Option<Language>,
}
impl Host for ClaudeHost {
    fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String> {
        let model = opt_str(opts, "model").unwrap_or_else(|| self.default_model.clone());
        let label = opt_str(opts, "label").unwrap_or_default();
        // schema 는 --json-schema 강제(provider.rs)로 넘기고 prompt 에는 붙이지 않는다(이중 지시 회피).
        let schema = opts.get("schema").map(val_to_json).filter(|s| s.is_object());
        let effort = opt_str(opts, "effort").unwrap_or_else(|| "xhigh".to_string());
        let full = build_prompt_with_schema(prompt, None, self.lang.as_ref());
        eprintln!("[soksak] agent {label:?} (model={model}, effort={effort}) → claude -p");
        let req = AgentRequest { prompt: full, model: &model, allowed_tools: self.allow_tools.clone(), timeout_secs: 3600, system_prompt: None, schema, effort };
        // schema 있으면 JSON 파싱(구조화 산출), 없으면 raw 텍스트 그대로 — plain agent 에 JSON 파싱 강요 금지.
        let res = if opts.get("schema").is_some() {
            run_agent(&req, &self.env).map(|out| json_to_val(&out))
        } else {
            run_agent_text(&req, &self.env).map(Val::Str)
        };
        match res {
            Ok(v) => Ok(v),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_prompt_appends_language_contract() {
        // [기준] lang 지정 시 agent 프롬프트 끝에 출력 언어 계약이 붙는다(exec-one/exec-stage 러너가 실제로 보냄).
        let no_lang = build_prompt_with_schema("본문", None, None);
        assert_eq!(no_lang, "본문", "lang 없으면 본문 그대로");
        let en = build_prompt_with_schema("body", None, Some(&Language::parse("en")));
        assert!(en.starts_with("body"));
        assert!(en.contains("Output language"));
        assert!(en.contains("Do NOT"));
        // schema 와 함께면: 본문 → schema → 언어 계약 순.
        let schema = json!({ "type": "object", "required": ["x"] });
        let ko = build_prompt_with_schema("body", Some(&schema), Some(&Language::parse("ko")));
        let i_schema = ko.find("Output format").unwrap();
        let i_lang = ko.find("출력 언어").unwrap();
        assert!(i_schema < i_lang, "schema 지시 뒤에 언어 계약");
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
