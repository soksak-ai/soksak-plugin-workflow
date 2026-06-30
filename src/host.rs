//! host — 인터프리터의 agent 호출을 실제로 처리하는 host 구현.
//!   ClaudeHost: agent → claude -p(인증 프로필 GLM). 워크플로를 진짜로 실행.
//!   StubHost:   agent → 호출 기록 + 스키마 모양 통과 placeholder(LLM 미호출). dry-run 미리보기.
//! 런타임은 program 을 해석하고, LLM 효과만 이 host 로 위임한다.

use crate::interp::{json_to_val, val_to_json, Host, Val};
use crate::lang::Language;
use crate::provider::{run_agent, run_agent_text, AgentRequest};
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

/// agent 프롬프트 = 본문 + (schema 있으면) 출력 형식 지시 + (lang 있으면) 출력 언어 계약.
/// 언어 계약을 schema 뒤에 둔다 — 계약이 "the schema" 를 가리키고, 모델이 마지막에 읽는다.
fn build_prompt(prompt: &str, opts: &BTreeMap<String, Val>, lang: Option<&Language>) -> String {
    let mut full = prompt.to_string();
    if let Some(schema) = opts.get("schema") {
        let sj = val_to_json(schema);
        if sj.is_object() {
            full.push_str(SCHEMA_INSTRUCTION);
            full.push_str(&serde_json::to_string_pretty(&sj).unwrap_or_default());
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
        let full = build_prompt(prompt, opts, self.lang.as_ref());
        eprintln!("[soksak] agent {label:?} (model={model}) → claude -p");
        let req = AgentRequest { prompt: full, model: &model, allowed_tools: self.allow_tools.clone() };
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

/// StubHost — agent 미호출, 호출 trace 기록 + 스키마 stub. dry-run.
pub struct StubHost {
    pub trace: Vec<Json>,
    pub default_model: String,
    /// 출력 언어 계약. dry-run 은 LLM 미호출이라 산출물 내용엔 영향 없지만, trace 에 기록해
    /// 미리보기가 "산출물이 이 언어로 나옴" 을 충실히 보여준다(실행과 동일 계약).
    pub lang: Option<Language>,
    seq: usize,
}
impl StubHost {
    pub fn new(default_model: String) -> Self {
        StubHost { trace: vec![], default_model, lang: None, seq: 0 }
    }
    /// with_lang — 출력 언어 계약 지정(빌더).
    pub fn with_lang(mut self, lang: Option<Language>) -> Self {
        self.lang = lang;
        self
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
            "lang": self.lang.as_ref().map(|l| l.code.clone()),
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
    fn stub_host_dry_run_deep_research_full_structure() {
        // deep-research 는 데이터의존 fan-out(pipeline/Map/Set/Array.from/UpdateExpr/try-catch/
        // Promise then-catch-finally) 워크플로. dry-run 이 갭(미지원) 없이 전 단계를 관통해야 한다:
        // scope → search → fetch → 3-vote verify → synthesize. 하나라도 조용히 삼키면 단계 누락.
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/deep-research.skeleton.json")).unwrap();
        let program = skeleton.get("program").unwrap();
        let mut h = StubHost::new("opus".into());
        // args 는 cc 계약대로 verbatim — 질문 문자열.
        Interp::new(&mut h)
            .run(program, Json::String("How does Rust async work?".into()))
            .expect("갭 없이 해석 — 미지원 구문/메서드면 Err 로 터진다");
        let labels: Vec<String> = h
            .trace
            .iter()
            .filter_map(|t| t.get("label").and_then(|l| l.as_str()).map(String::from))
            .filter(|l| !l.is_empty())
            .collect();
        // 전 단계 agent 타입이 trace 에(데이터 샘플 1개씩 → 최소 fan-out 구조).
        assert!(labels.iter().any(|l| l == "scope"), "scope 누락: {labels:?}");
        assert!(labels.iter().any(|l| l.starts_with("search:")), "search 누락: {labels:?}");
        assert!(labels.iter().any(|l| l.starts_with("fetch:")), "fetch 누락(pipeline stage2): {labels:?}");
        assert_eq!(labels.iter().filter(|l| l.starts_with("v")).count(), 3, "3-vote verify 누락: {labels:?}");
        assert!(labels.iter().any(|l| l == "synthesize"), "synthesize 누락(verify 게이트 통과 실패): {labels:?}");
        let phases: Vec<String> = h.trace.iter().filter_map(|t| t.get("phase").and_then(|p| p.as_str()).map(String::from)).collect();
        for ph in ["Scope", "Verify", "Synthesize"] {
            assert!(phases.iter().any(|p| p == ph), "phase {ph} 미도달: {phases:?}");
        }
    }

    #[test]
    fn build_prompt_appends_language_contract() {
        // [기준] lang 지정 시 agent 프롬프트 끝에 출력 언어 계약이 붙는다(execute 가 실제로 보냄).
        let opts: BTreeMap<String, Val> = BTreeMap::new();
        let no_lang = build_prompt("본문", &opts, None);
        assert_eq!(no_lang, "본문", "lang 없으면 본문 그대로");
        let en = build_prompt("body", &opts, Some(&Language::parse("en")));
        assert!(en.starts_with("body"));
        assert!(en.contains("Output language"));
        assert!(en.contains("Do NOT"));
        // schema 와 함께면: 본문 → schema → 언어 계약 순.
        let mut o2: BTreeMap<String, Val> = BTreeMap::new();
        o2.insert("schema".into(), json_to_val(&json!({ "type": "object", "required": ["x"] })));
        let ko = build_prompt("body", &o2, Some(&Language::parse("ko")));
        let i_schema = ko.find("Output format").unwrap();
        let i_lang = ko.find("출력 언어").unwrap();
        assert!(i_schema < i_lang, "schema 지시 뒤에 언어 계약");
    }

    #[test]
    fn stub_host_records_lang_in_trace() {
        // dry-run 미리보기가 출력 언어를 충실히 보여준다 — 각 agent trace 에 lang 코드.
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/cockpit.skeleton.json")).unwrap();
        let program = skeleton.get("program").unwrap();
        let mut h = StubHost::new("opus".into()).with_lang(Some(Language::parse("en")));
        Interp::new(&mut h).run(program, Json::Null).unwrap();
        let langs: Vec<String> = h
            .trace
            .iter()
            .filter(|t| t.get("label").and_then(|l| l.as_str()).map_or(false, |s| !s.is_empty()))
            .filter_map(|t| t.get("lang").and_then(|l| l.as_str()).map(String::from))
            .collect();
        assert_eq!(langs.len(), 9, "전 agent trace 에 lang");
        assert!(langs.iter().all(|l| l == "en"), "전부 en: {langs:?}");
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
