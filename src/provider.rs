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

/// runs_dir — run catalog 위치 해석(상시 경로 = identity 홈, 진단 override = 사이드카 소유 env).
/// ① SOKSAK_SIDECAR_WORKFLOW_RUNS(진단 — SIDECARS.md 의 SOKSAK_SIDECAR_{NAME}_* 채널)
/// ② $SOKSAK_HOME/runs/soksak-sidecar-workflow(앱 주입 컨텍스트 — A17)
/// ③ 없으면 None(기록 비활성 — 독립 CLI 는 하네스가 ① 로 지정한다).
fn runs_dir() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("SOKSAK_SIDECAR_WORKFLOW_RUNS") {
        if !p.is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    if let Ok(h) = std::env::var("SOKSAK_HOME") {
        if !h.is_empty() {
            return Some(std::path::PathBuf::from(h).join("runs").join("soksak-sidecar-workflow"));
        }
    }
    None
}

/// open_run_stream — run catalog 에 원시 stream 파일 생성 + `latest.jsonl` 심링크 갱신(mtime latest 헬퍼).
/// 파일명 = <UTC epoch ms>-<pid>.jsonl (충돌 0, 자동삭제 금지 — server2 catalog 규율). 실패는 무해(None).
fn open_run_stream() -> Option<std::fs::File> {
    let dir = runs_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    let name = format!("{ts}-{}.jsonl", std::process::id());
    let path = dir.join(&name);
    let f = std::fs::File::create(&path).ok()?;
    let latest = dir.join("latest.jsonl");
    let _ = std::fs::remove_file(&latest);
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(&name, &latest);
    eprintln!("[soksak] run stream → {}", path.display());
    Some(f)
}

/// event_signals_529 — stream 이벤트에서 일시 과부하 신호 감지(순수). 텍스트는 톱레벨
/// {type:"text"} 가 아니라 **assistant 이벤트의 message.content[] text 블록**으로 온다(실측:
/// "API Error: 529 …" 가 assistant 블록 — 톱레벨만 보던 감지는 죽은 조건이라 재시도가 0이었다).
fn event_signals_529(ev: &serde_json::Value) -> bool {
    let ty = ev.get("type").and_then(|x| x.as_str()).unwrap_or("");
    // 구조 신호 최우선 — result 이벤트가 api_error_status 를 명시(run catalog 실측: 529).
    if ty == "result" {
        return ev.get("api_error_status").and_then(|x| x.as_u64()).is_some_and(|c| (500..600).contains(&c));
    }
    if ty == "text" {
        return ev.get("text").and_then(|x| x.as_str()).is_some_and(is_529);
    }
    if ty == "assistant" || ty == "user" {
        if let Some(blocks) = ev.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
            return blocks.iter().any(|b| {
                b.get("type").and_then(|t| t.as_str()) == Some("text")
                    && b.get("text").and_then(|t| t.as_str()).is_some_and(is_529)
            });
        }
    }
    false
}

/// is_529 — 제공자 일시 과부하 에러 판정. "wait longer"는 과부하 안내 문구(앱 실측 2026-07-03).
fn is_529(err: &str) -> bool {
    // transient 사전(§15): API 혼잡 + 연결단절 부류 — 재시도 대상. 결정적 실패는 여기 넣지 않는다.
    let e = err.to_ascii_lowercase();
    ["529", "overloaded", "temporarily", "wait longer", "econnreset", "econnrefused", "unable to connect", "socket hang up", "connection closed", "429", "rate limit", "usage limit"]
        .iter().any(|p| e.contains(p))
}

/// run_agent_text_once — claude -p 단일 실행(재시도 없음). 529 감지(stream text) 시 Err 를 529 로.
/// timeout 하드캡(req.timeout_secs)은 **네이티브**(wait-timeout crate) — 외부 GNU `timeout` 바이너리에
/// 의존하지 않는다(macOS 기본 미탑재; 부재 시 모든 호출이 "spawn claude" 오진 라벨로 죽던 결함 해소).
/// provider_kind — 실행 LLM CLI 선택. env SOKSAK_WORKFLOW_PROVIDER=codex 면 codex exec 어댑터,
/// 그 외(기본) claude -p. doc·보드·badge 파이프는 실행자 중립 — 여기 한 곳만 갈린다.
fn provider_kind() -> &'static str {
    match std::env::var("SOKSAK_WORKFLOW_PROVIDER").ok().as_deref() {
        Some("codex") => "codex",
        _ => "claude",
    }
}

/// normalize_schema_for_openai — OpenAI strict structured-output 방언으로 결정적 정규화(의미 보존):
/// 모든 object 에 additionalProperties=false, properties 전 키를 required 로(원래 선택이던 키는
/// type 에 "null" 을 더해 nullable 로 — 선택성의 등가 표현). Anthropic 스키마는 관대해 이 변환의
/// 역은 불필요. 재귀(중첩 object/array items).
fn normalize_schema_for_openai(v: &mut Value) {
    match v {
        Value::Object(m) => {
            let is_object_schema = m.get("type").and_then(|t| t.as_str()) == Some("object") || m.contains_key("properties");
            if is_object_schema {
                m.entry("additionalProperties").or_insert(Value::Bool(false));
                let prop_keys: Vec<String> = m
                    .get("properties")
                    .and_then(|p| p.as_object())
                    .map(|p| p.keys().cloned().collect())
                    .unwrap_or_default();
                let required: Vec<String> = m
                    .get("required")
                    .and_then(|r| r.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let optional: Vec<String> = prop_keys.iter().filter(|k| !required.contains(k)).cloned().collect();
                if let Some(props) = m.get_mut("properties").and_then(|p| p.as_object_mut()) {
                    for k in &optional {
                        if let Some(ps) = props.get_mut(k).and_then(|x| x.as_object_mut()) {
                            match ps.get_mut("type") {
                                Some(Value::String(t)) => {
                                    let t2 = t.clone();
                                    ps.insert("type".into(), serde_json::json!([t2, "null"]));
                                }
                                Some(Value::Array(a)) => {
                                    if !a.iter().any(|x| x.as_str() == Some("null")) {
                                        a.push(Value::String("null".into()));
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                if !prop_keys.is_empty() {
                    m.insert("required".into(), Value::Array(prop_keys.into_iter().map(Value::String).collect()));
                }
            }
            for (_, child) in m.iter_mut() {
                normalize_schema_for_openai(child);
            }
        }
        Value::Array(a) => {
            for child in a.iter_mut() {
                normalize_schema_for_openai(child);
            }
        }
        _ => {}
    }
}

/// run_codex_once — codex exec 어댑터(claude -p 등가): 프롬프트=stdin, 스키마=--output-schema(파일),
/// 스트림=--json(run catalog 보존), 결과=-o(최종 메시지 파일). 인증은 codex 자체 로그인(~/.codex) —
/// ANTHROPIC env 불요. 하드캡·transient 계약은 claude 경로와 동일.
/// codex_reasoning_effort — 추상 effort(우리 어휘, claude `--effort` 기준: low/medium/high/xhigh/max)를
/// codex `model_reasoning_effort` 값으로 매핑. 두 provider 최고 tier 가 다름(claude `max` ↔ codex `ultra`)이라
/// 최고만 정렬하고 나머지는 codex 도 수용하는 동명값(low/medium/high/xhigh)을 그대로 넘긴다. codex 는
/// minimal/none 도 있으나 우리 어휘엔 없어 매핑 대상 아님(미지정 시 codex config 기본).
fn codex_reasoning_effort(effort: &str) -> &str {
    match effort {
        "max" => "ultra", // 각 provider 최고를 정렬
        other => other,   // low/medium/high/xhigh — codex 동명 수용
    }
}

fn run_codex_once(req: &AgentRequest) -> Result<String, String> {
    let tmp = std::env::temp_dir().join(format!("soksak-codex-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("codex tmp: {e}"))?;
    let out_file = tmp.join(format!("last-{}.txt", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-lc", r#"exec codex "$@""#, "codex"]);
    cmd.arg("exec").arg("--json").arg("--skip-git-repo-check").arg("--ephemeral");
    cmd.arg("-o").arg(&out_file);
    if !req.model.is_empty() && req.model != "default" {
        // "default" = codex 자체 기본 모델(config) 사용 — -m 생략.
        cmd.arg("-m").arg(req.model);
    }
    // reasoning effort 배선(파리티) — claude `--effort` 와 대칭으로 codex 도 명시 전달한다. codex 는
    // `-c model_reasoning_effort=<v>` config override(STEP 0 실측: CLI 미검증). effort 어휘가 provider
    // 마다 달라 최고를 정렬한다(claude `max` ↔ codex `ultra`). 미지정("")이면 codex config 기본에 맡김.
    if !req.effort.is_empty() {
        cmd.arg("-c").arg(format!("model_reasoning_effort={}", codex_reasoning_effort(&req.effort)));
    }
    let schema_file = if let Some(sc) = &req.schema {
        let f = tmp.join(format!("schema-{}.json", std::process::id()));
        let mut sc2 = sc.clone();
        normalize_schema_for_openai(&mut sc2);
        std::fs::write(&f, sc2.to_string()).map_err(|e| format!("codex schema 기록: {e}"))?;
        cmd.arg("--output-schema").arg(&f);
        Some(f)
    } else {
        None
    };
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn codex: {e}"))?;
    {
        use std::io::Write;
        let mut si = child.stdin.take().ok_or("codex stdin 없음")?;
        // 프롬프트는 stdin — 인자 길이 한계 회피(수십 KB 프롬프트).
        let mut full = String::new();
        if let Some(sp) = &req.system_prompt {
            full.push_str(sp);
            full.push_str("\n\n");
        }
        full.push_str(&req.prompt);
        si.write_all(full.as_bytes()).map_err(|e| format!("codex stdin 쓰기: {e}"))?;
    } // drop = EOF
    let stdout = child.stdout.take().ok_or("codex stdout 없음")?;
    let reader = std::thread::spawn(move || {
        let mut run_stream = open_run_stream();
        let mut tail: Vec<String> = Vec::new(); // 실패 진단용 꼬리(transient 사전 매칭 재료)
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            if let Some(f) = run_stream.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "{t}");
            }
            eprintln!("  [codex] {}", t.chars().take(160).collect::<String>());
            tail.push(t.chars().take(300).collect());
            if tail.len() > 8 {
                tail.remove(0);
            }
        }
        tail.join(" | ")
    });
    use wait_timeout::ChildExt;
    let status = match child
        .wait_timeout(std::time::Duration::from_secs(req.timeout_secs))
        .map_err(|e| format!("wait codex: {e}"))?
    {
        Some(st) => st,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(format!("codex 타임아웃({}s) — 강제 종료", req.timeout_secs));
        }
    };
    let tail = reader.join().map_err(|_| "codex stream 리더 panic".to_string())?;
    if let Some(f) = schema_file {
        let _ = std::fs::remove_file(f);
    }
    if !status.success() {
        return Err(format!("codex 비정상 종료: {status} — {tail}"));
    }
    let text = std::fs::read_to_string(&out_file).map_err(|e| format!("codex 결과 파일 없음({e}) — {tail}"))?;
    let _ = std::fs::remove_file(&out_file);
    if text.trim().is_empty() {
        return Err(format!("codex 결과 비어 있음 — {tail}"));
    }
    Ok(text.trim().to_string())
}

fn run_agent_text_once(req: &AgentRequest, env: &[(String, String)]) -> Result<String, String> {
    if provider_kind() == "codex" {
        return run_codex_once(req);
    }
    // claude 발견 = 로그인셸 해석(sh -lc) — GUI(Finder) 실행 앱의 자식은 셸 PATH 를 상속받지 못해
    // PATH 의존 spawn 이 os error 2 로 죽는다(GUI PATH 함정). 사이드카 자신의 자식 발견은 사이드카 책임.
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-lc", r#"exec claude "$@""#, "claude"]);
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
        let mut run_stream = open_run_stream(); // run catalog — 원시 stream 보존(띵킹 포함, tail -f 모니터링)
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
            if let Some(f) = run_stream.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "{t}");
            }
            match serde_json::from_str::<Value>(t) {
                Ok(ev) => {
                    print_event(&ev);
                    if event_signals_529(&ev) {
                        transient_529 = true;
                    }
                    if ev.get("type").and_then(|x| x.as_str()) == Some("result") {
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
mod tests_529 {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_529_in_assistant_content_block() {
        // 실측 형태: assistant 이벤트의 content[] text 블록으로 과부하 안내가 온다.
        let ev = json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "API Error: 529 [1305][The service may be temporarily overloaded, please try again later]" }
        ] } });
        assert!(event_signals_529(&ev));
        let ev2 = json!({ "type": "assistant", "message": { "content": [ { "type": "text", "text": "정상 응답" } ] } });
        assert!(!event_signals_529(&ev2));
    }

    #[test]
    fn detects_529_in_top_level_text_and_ignores_others() {
        assert!(event_signals_529(&json!({ "type": "text", "text": "overloaded" })));
        // result 는 산출 채널 — 본문에 "529" 가 있어도 과부하 신호가 아니다. 구조 필드만 신호.
        assert!(!event_signals_529(&json!({ "type": "result", "result": "요건 529 관련 서술" })));
        assert!(event_signals_529(&json!({ "type": "result", "is_error": true, "api_error_status": 529, "result": "API Error: 529" })));
        assert!(!event_signals_529(&json!({ "type": "result", "api_error_status": 200 })));
        assert!(!event_signals_529(&json!({ "type": "system", "subtype": "init" })));
    }
}

#[cfg(test)]
mod tests_codex_schema {
    use super::*;

    #[test]
    fn openai_normalize_makes_strict_and_nullable() {
        let mut v: Value = serde_json::json!({
            "type": "object", "required": ["a"],
            "properties": {
                "a": {"type": "string"},
                "b": {"type": "number"},
                "c": {"type": "object", "properties": {"d": {"type": "string"}}}
            }
        });
        normalize_schema_for_openai(&mut v);
        assert_eq!(v["additionalProperties"], serde_json::json!(false));
        let req: Vec<&str> = v["required"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert!(req.contains(&"a") && req.contains(&"b") && req.contains(&"c"), "전 키 required");
        assert_eq!(v["properties"]["b"]["type"], serde_json::json!(["number", "null"]), "선택 키는 nullable");
        assert_eq!(v["properties"]["a"]["type"], serde_json::json!("string"), "원래 필수는 그대로");
        assert_eq!(v["properties"]["c"]["additionalProperties"], serde_json::json!(false), "중첩 object 도");
    }
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
