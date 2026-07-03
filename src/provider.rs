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
    /// claude 호출 하드캡(초). hung 호출이 영원히 안 막게 — 단 검색 fan-out 단일 턴이 30분 넘을 수 있어
    /// 넉넉히 3600s(1시간). exec-one 은 코어와 천장 일치: provider 캡=register timeout_ms=ipc 클램프=3600s.
    /// 셋 일치라야 발화 timeout 으로 lease 중복 실행이 안 난다.
    pub timeout_secs: u64,
    /// system prompt(claude `--append-system-prompt`). user prompt(`-p`)와 분리 —
    /// SKILL.md(AST 사용법) + cc 추출 AST(구조 예시) 등이 system 층에, derive 지시어+아이디어가 user 층.
    /// None 이면 종래 동작(system 주입 없음).
    pub system_prompt: Option<String>,
    /// JSON Schema(claude `--json-schema`) — StructuredOutput 강제. agent 가 schema 준수 객체 반환(필수 필드 보장).
    /// api-reference 계약(schema → forced StructuredOutput → validated object). None 이면 raw 텍스트.
    pub schema: Option<Value>,
    /// claude `--effort`. 추론 깊이. agent opts.effort 로 override, 기본 xhigh(최고 — 도출·검증·판정 품질 우선).
    pub effort: String,
    /// true 면 **순수 텍스트 반환 계약** — 파일/실행/검색 도구를 전면 차단(--disallowedTools 로).
    /// generate-skeleton(gen.js 저작)에만 씀: 도구가 열려 있으면 모델이 gen.js 를 파일로 쓰려다 실패(빈 --allowedTools
    /// 를 claude CLI 가 무시함). false = 종래(Task 만 금지, allowed_tools 정책 따름).
    pub text_only: bool,
}

/// claude_args — AgentRequest → claude CLI 인자 벡터(순수, 테스트 가능).
/// run_agent_text 가 timeout 래퍼로 이 args 를 `claude` 에 적용한다. system_prompt 가 Some 이면
/// `--append-system-prompt <내용>` 추가(user prompt 와 분리 — claude CLI 공식 플래그).
fn claude_args(req: &AgentRequest) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        req.prompt.clone(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--strict-mcp-config".into(),
        "--allowedTools".into(),
        req.allowed_tools.join(" "),
        "--disallowedTools".into(),
        // Task 는 항상 금지(sub-agent → async hang 방지). text_only(저작)는 모든 파일/실행/검색 도구도 차단해
        // 모델이 순수 JS 텍스트만 반환하게(빈 --allowedTools 는 CLI 가 무시하므로 disallow 로 강제).
        if req.text_only {
            "Task Bash Read Write Edit MultiEdit Glob Grep NotebookEdit WebFetch WebSearch TodoWrite".into()
        } else {
            "Task".into()
        },
        "--model".into(),
        req.model.into(),
    ];
    if let Some(sp) = &req.system_prompt {
        args.push("--append-system-prompt".into());
        args.push(sp.clone());
    }
    if let Some(sc) = &req.schema {
        args.push("--json-schema".into());
        args.push(sc.to_string());
    }
    args.push("--effort".into());
    args.push(req.effort.clone());
    args
}

/// run_agent_text — claude -p 로 agent 실행, result 텍스트(raw) 반환. **529 과부하 재시도** 포함.
/// 제공자 529 과부하는 흔하고 일시적 → **고정 30초 간격 재실행**(사용자 확정 정책 — 지수 backoff 아님).
/// max 10회(과부하 ~5분 창 커버). 최종 실패는 loud.
pub fn run_agent_text(req: &AgentRequest, env: &[(String, String)]) -> Result<String, String> {
    const MAX: u32 = 10;
    const INTERVAL_SECS: u64 = 30;
    for attempt in 0..MAX {
        match run_agent_text_once(req, env) {
            Ok(s) => return Ok(s),
            Err(e) if is_529(&e) && attempt + 1 < MAX => {
                eprintln!("[soksak] 529 과부하 — {INTERVAL_SECS}s 후 재실행 ({}/{MAX})", attempt + 1);
                std::thread::sleep(std::time::Duration::from_secs(INTERVAL_SECS));
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// is_529 — 제공자 일시 과부하 에러 판정. "wait longer"는 과부하 안내 문구(앱 실측 2026-07-03).
fn is_529(err: &str) -> bool {
    err.contains("529") || err.contains("overloaded") || err.contains("temporarily") || err.contains("wait longer")
}

/// run_agent_text_once — claude -p 단일 실행(재시도 없음). 529 감지(stream text) 시 Err 를 529 로.
/// timeout 하드캡(req.timeout_secs)은 **네이티브**(wait-timeout crate) — 외부 GNU `timeout` 바이너리에
/// 의존하지 않는다(macOS 기본 미탑재; 부재 시 모든 호출이 "spawn claude" 오진 라벨로 죽던 결함 해소).
fn run_agent_text_once(req: &AgentRequest, env: &[(String, String)]) -> Result<String, String> {
    let mut cmd = Command::new("claude");
    for a in claude_args(req) {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()); // stderr 는 상속(claude 경고 그대로 보임, 파이프 deadlock 방지)
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
    // stream-json 소비는 리더 스레드에서 — 메인 스레드는 wait_timeout 으로 하드캡을 건다.
    // (종전 GNU timeout 이 하던 hung 방지: 캡 도달 시 kill → stdout EOF → 리더 종료.)
    let reader = std::thread::spawn(move || {
        let mut transient_529 = false; // stream 중 [text] API Error 529/overloaded 감지.
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
                    let ty = ev.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    if ty == "text" {
                        let t = ev.get("text").and_then(|x| x.as_str()).unwrap_or("");
                        if t.contains("529") || t.contains("overloaded") {
                            transient_529 = true;
                        }
                    } else if ty == "result" {
                        if let Some(s) = ev.get("result").and_then(|r| r.as_str()) {
                            result_text = s.to_string();
                        }
                    }
                }
                Err(_) => eprintln!("  [stream:raw] {}", t.chars().take(200).collect::<String>()),
            }
        }
        (result_text, transient_529)
    });
    use wait_timeout::ChildExt;
    let status = match child
        .wait_timeout(std::time::Duration::from_secs(req.timeout_secs))
        .map_err(|e| format!("wait claude: {e}"))?
    {
        Some(st) => st,
        None => {
            // 하드캡 도달 — kill 후 reap. 리더는 stdout EOF 로 자연 종료.
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(format!("claude 타임아웃({}s) — 강제 종료(hung 방지 하드캡)", req.timeout_secs));
        }
    };
    let (result_text, transient_529) = reader.join().map_err(|_| "claude stream 리더 스레드 panic".to_string())?;
    if !status.success() {
        if transient_529 {
            return Err("529 과부하 — claude 비정상 종료(일시적, backoff 대상)".into());
        }
        return Err(format!("claude 비정상 종료: {status}"));
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

    /// system_prompt 가 Some 면 --append-system-prompt <내용> 이 args 에 추가된다(user prompt 와 분리).
    #[test]
    fn system_prompt_appends_flag_when_some() {
        let req = AgentRequest {
            prompt: "USER_PROMPT".into(),
            model: "haiku", text_only: false,
            allowed_tools: vec![],
            timeout_secs: 10,
            system_prompt: Some("SKILL_AST_SYSTEM".into()),
            schema: None,
            effort: "xhigh".into(),
        };
        let args = claude_args(&req);
        assert!(args.contains(&"-p".into()) && args.contains(&"USER_PROMPT".into()), "user prompt(-p) 유지");
        let i = args.iter().position(|a| a == "--append-system-prompt").expect("system flag 누락");
        assert_eq!(args[i + 1], "SKILL_AST_SYSTEM", "system_prompt 내용이 flag 바로 뒤");
    }

    /// system_prompt None 이면 --append-system-prompt 가 아예 안 붙는다(종래 동작).
    #[test]
    fn system_prompt_omitted_when_none() {
        let req = AgentRequest {
            prompt: "p".into(),
            model: "haiku", text_only: false,
            allowed_tools: vec![],
            timeout_secs: 10,
            system_prompt: None,
            schema: None,
            effort: "xhigh".into(),
        };
        let args = claude_args(&req);
        assert!(!args.iter().any(|a| a == "--append-system-prompt"), "None 이면 system flag 미부착");
    }
}
