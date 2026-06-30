//! provider — agent 러너. `claude -p`(headless Claude Code)로 위임한다.
//! 인증·모델은 주입된 env 프로필이 정한다. 검증된 호출:
//!   claude -p <prompt> --output-format json --allowedTools "<...>" --strict-mcp-config --model <m>
//! → 이벤트 배열의 result.result(텍스트)를 코드펜스 제거 후 JSON 파싱.
//! 코어(vsterm)가 실제로는 env/spawn 을 위임하지만, 런타임 e2e 는 직접 spawn 해 검증한다.

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

/// thinking 진행 heartbeat 카운터(프로세스별). 긴 thinking 동안 '멈춘 것처럼' 안 보이게 한다.
static THINK_BEAT: AtomicUsize = AtomicUsize::new(0);

/// AgentRequest — 한 agent 실행 입력.
pub struct AgentRequest<'a> {
    /// 완성된 프롬프트(directive + ${placeholder} 바인딩 + schema 지시).
    pub prompt: String,
    /// 모델 별칭(haiku/sonnet/opus) — 실제 모델은 인증 프로필이 매핑.
    pub model: &'a str,
    /// 허용 tool(기본 빈 = 순수 생성). 일부 agent(WebSearch 등)는 명시.
    pub allowed_tools: Vec<String>,
    /// claude 호출 하드캡(초). hung 호출이 영원히 안 막게. exec-one 은 코어 스케줄러 timeout(600s) 클램프
    /// 아래(590s)로 — 발화 timeout 전에 자체 종료해 lease 중복 실행 0. 일반 interp 실행은 900s.
    pub timeout_secs: u64,
}

/// run_agent_text — claude -p 로 agent 실행, result 텍스트(raw)를 반환.
/// author(마크다운 스펙처럼 JSON 이 아닌 산출)용. env=인증 프로필. run_agent 의 raw-text 형제.
pub fn run_agent_text(req: &AgentRequest, env: &[(String, String)]) -> Result<String, String> {
    // timeout 하드캡(req.timeout_secs) — hung claude 호출(WebSearch 폭주 등)이 루프를 영원히 막지 못하게.
    // timeout 만료 → 비-success status → Err(라운드 실패, 무한 hang 아님).
    let mut cmd = Command::new("timeout");
    cmd.arg(req.timeout_secs.to_string())
        .arg("claude")
        .arg("-p")
        .arg(&req.prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--strict-mcp-config")
        .arg("--allowedTools")
        .arg(req.allowed_tools.join(" "))
        .arg("--disallowedTools")
        .arg("Task") // sub-agent 금지 — real Claude 가 async agent 띄우고 무한대기하는 hang 방지.
        .arg("--model")
        .arg(req.model)
        .stdout(Stdio::piped()); // stderr 는 상속(claude 경고 그대로 보임, 파이프 deadlock 방지)
    // 부모 env 격리 후 인증 env 만 주입(누수 방지). PATH·HOME 유지.
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
    let stdout = child.stdout.take().ok_or("claude stdout 없음")?;
    // stream-json: 한 줄 = 한 이벤트. 모두 stderr 로 흘려 관측(system·think·tool·subagent·task·…),
    // 최종 type=result 의 result 텍스트만 반환값으로 모은다.
    let mut result_text = String::new();
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(t) {
            Ok(ev) => {
                print_event(&ev);
                if ev.get("type").and_then(|x| x.as_str()) == Some("result") {
                    if let Some(s) = ev.get("result").and_then(|r| r.as_str()) {
                        result_text = s.to_string();
                    }
                }
            }
            Err(_) => eprintln!("  [stream:raw] {}", t.chars().take(200).collect::<String>()),
        }
    }
    let status = child.wait().map_err(|e| format!("wait claude: {e}"))?;
    if !status.success() {
        return Err(format!("claude 비정상 종료: {status} (timeout 만료=124/137)"));
    }
    if result_text.is_empty() {
        return Err("claude 스트림에 type=result 텍스트 없음".into());
    }
    Ok(result_text)
}

/// print_event — stream-json 이벤트 1개를 사람이 읽을 한 줄로 stderr 출력.
/// 모든 stream 타입을 표면화: system·text·think·tool_use(→WebSearch)·tool_result·그 외(subagent/task/agentteam 등).
fn print_event(ev: &Value) {
    let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or("?");
    match ty {
        "system" => {
            // 제공자에 따라 thinking 토큰마다 system 이벤트가 온다. 도배(매 토큰)는 막되,
            // 전혀 안 찍으면 긴 thinking 동안 멈춘 듯 보이므로 주기적 heartbeat 로 살아있음을 표시.
            let sub = ev.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            if sub == "init" {
                THINK_BEAT.store(0, Ordering::Relaxed);
                eprintln!("  [system] init");
            } else {
                let n = THINK_BEAT.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 20 == 0 {
                    eprintln!("  [thinking… {n}]");
                }
            }
        }
        // result 시작 시 다음 호출 heartbeat 초기화.
        "result" => {
            THINK_BEAT.store(0, Ordering::Relaxed);
        }
        "assistant" | "user" => {
            if let Some(blocks) = ev.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                for b in blocks {
                    match b.get("type").and_then(|t| t.as_str()).unwrap_or("?") {
                        "text" => eprintln!("  [text] {}", snip(b.get("text").and_then(|x| x.as_str()).unwrap_or(""))),
                        "thinking" => eprintln!("  [think] {}", snip(b.get("thinking").and_then(|x| x.as_str()).unwrap_or(""))),
                        "tool_use" => eprintln!(
                            "  [tool→] {} {}",
                            b.get("name").and_then(|n| n.as_str()).unwrap_or("?"),
                            snip(&b.get("input").map(|i| i.to_string()).unwrap_or_default())
                        ),
                        "tool_result" => eprintln!("  [tool←] {}", snip(&block_text(b))),
                        o => eprintln!("  [{o}]"),
                    }
                }
            }
        }
        o => eprintln!("  [{o}] {}", snip(&ev.to_string())),
    }
}
fn snip(s: &str) -> String {
    s.replace('\n', " ").chars().take(180).collect()
}
fn block_text(b: &Value) -> String {
    match b.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// run_agent — claude -p 로 agent 실행, result 의 JSON 을 파싱해 반환.
/// env = (key, value) 쌍(인증 프로필). 코어가 주입하는 형태를 그대로 받는다.
pub fn run_agent(req: &AgentRequest, env: &[(String, String)]) -> Result<Value, String> {
    let text = run_agent_text(req, env)?;
    parse_json_lenient(&text)
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
