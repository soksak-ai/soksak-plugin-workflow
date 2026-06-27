//! provider — agent 실행기. `claude -p`(headless Claude Code)로 위임한다.
//! 인증·모델은 주입된 env 프로필이 정한다. 검증된 호출:
//!   claude -p <prompt> --output-format json --allowedTools "<...>" --strict-mcp-config --model <m>
//! → 이벤트 배열의 result.result(텍스트)를 코드펜스 제거 후 JSON 파싱.
//! 코어(vsterm)가 실제로는 env/spawn 을 위임하지만, 런타임 e2e 는 직접 spawn 해 검증한다.

use serde_json::Value;
use std::process::Command;

/// AgentRequest — 한 agent 실행 입력.
pub struct AgentRequest<'a> {
    /// 완성된 프롬프트(directive + ${placeholder} 바인딩 + schema 지시).
    pub prompt: String,
    /// 모델 별칭(haiku/sonnet/opus) — 실제 모델은 인증 프로필이 매핑.
    pub model: &'a str,
    /// 허용 tool(기본 빈 = 순수 생성). 일부 agent(WebSearch 등)는 명시.
    pub allowed_tools: Vec<String>,
}

/// run_agent — claude -p 로 agent 실행, result 의 JSON 을 파싱해 반환.
/// env = (key, value) 쌍(인증 프로필). 코어가 주입하는 형태를 그대로 받는다.
pub fn run_agent(req: &AgentRequest, env: &[(String, String)]) -> Result<Value, String> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg(&req.prompt)
        .arg("--output-format")
        .arg("json")
        .arg("--strict-mcp-config")
        .arg("--allowedTools")
        .arg(req.allowed_tools.join(" "))
        .arg("--model")
        .arg(req.model);
    // 부모 env 격리 후 인증 프로필 env 만 주입(누수 방지). PATH 는 유지.
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }

    let out = cmd.output().map_err(|e| format!("spawn claude: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude exit {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).chars().take(400).collect::<String>()
        ));
    }
    let events: Value = serde_json::from_slice(&out.stdout).map_err(|e| {
        format!("parse claude --output-format json: {e}; head={}", String::from_utf8_lossy(&out.stdout).chars().take(200).collect::<String>())
    })?;
    let result_text = extract_result_text(&events)?;
    parse_json_lenient(&result_text)
}

/// extract_result_text — `--output-format json` 이벤트(배열 또는 단일)에서 result.result 텍스트.
fn extract_result_text(events: &Value) -> Result<String, String> {
    let arr = match events {
        Value::Array(a) => a.clone(),
        single => vec![single.clone()],
    };
    for ev in &arr {
        if ev.get("type").and_then(|t| t.as_str()) == Some("result") {
            // result 필드(문자열) 또는 result.result.
            if let Some(s) = ev.get("result").and_then(|r| r.as_str()) {
                return Ok(s.to_string());
            }
        }
    }
    Err("claude 출력에 type=result 이벤트 없음".to_string())
}

/// parse_json_lenient — 코드펜스(```json) 제거 후 JSON 파싱. 앞뒤 prose 가 있으면
/// 첫 `{`~마지막 `}` 구간 추출 시도(모델이 펜스/설명을 붙이는 경우 대비).
pub fn parse_json_lenient(text: &str) -> Result<Value, String> {
    let t = text.trim();
    let stripped = strip_code_fence(t);
    if let Ok(v) = serde_json::from_str::<Value>(stripped.trim()) {
        return Ok(v);
    }
    // 첫 { ~ 매칭 } 추출(브레이스 균형).
    if let Some(slice) = extract_balanced_object(stripped) {
        if let Ok(v) = serde_json::from_str::<Value>(&slice) {
            return Ok(v);
        }
    }
    Err(format!("agent 출력 JSON 파싱 실패. head={}", stripped.chars().take(200).collect::<String>()))
}

fn strip_code_fence(t: &str) -> &str {
    let t = t.trim();
    if let Some(rest) = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")) {
        let rest = rest.trim_start_matches('\n');
        if let Some(end) = rest.rfind("```") {
            return &rest[..end];
        }
        return rest;
    }
    t
}

fn extract_balanced_object(t: &str) -> Option<String> {
    let bytes = t.as_bytes();
    let start = t.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for i in start..bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(t[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_plain_json() {
        assert_eq!(parse_json_lenient(r#"{"a":1}"#).unwrap(), json!({"a":1}));
    }

    #[test]
    fn parse_code_fenced() {
        assert_eq!(parse_json_lenient("```json\n{\"a\":1}\n```").unwrap(), json!({"a":1}));
        assert_eq!(parse_json_lenient("```\n{\"a\":1}\n```").unwrap(), json!({"a":1}));
    }

    #[test]
    fn parse_with_surrounding_prose() {
        let v = parse_json_lenient("Here is the result:\n{\"angles\":[\"x\",\"y\"]}\nDone.").unwrap();
        assert_eq!(v["angles"], json!(["x", "y"]));
    }

    #[test]
    fn extract_result_from_events() {
        let events = json!([
            {"type":"system","subtype":"init"},
            {"type":"assistant"},
            {"type":"result","result":"{\"ok\":true}"}
        ]);
        assert_eq!(extract_result_text(&events).unwrap(), "{\"ok\":true}");
    }

    #[test]
    fn missing_result_errors() {
        let events = json!([{"type":"system"}]);
        assert!(extract_result_text(&events).is_err());
    }
}
