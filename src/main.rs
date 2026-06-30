//! soksak-workflow — 워크플로 실행 CLI. 추출기 가 떠낸 완전 skeleton 의 program(중립 AST)을
//! 인터프리터로 **해석**해 실행한다. agent 는 host(claude -p 인증 프로필). 런타임은 워크플로 로직을
//! 모름 — program 을 해석할 뿐. agent 수는 워크플로가 정함(내가 아님).
//!
//!   soksak-workflow <skeleton.json|-> --arg K=V ... [--dry-run] [--lang ko|en|…] [--allow-tools "T1 T2"]
//!       # program 해석 실행(agent→claude -p)
//!   soksak-workflow <skeleton.json|-> --emit [--lang ko]   # 발행만(노드 DAG 를 stdout JSON line 으로). LLM 미호출.
//!   soksak-workflow exec-one [--lang ko] [--model m] [--allow-tools "..."]
//!       # stdin {prompt, schema?, model?} 한 노드 실행 → {oxf, result} stdout. (스케줄러가 ready 노드 실행에 사용)
//!   soksak-workflow synth --idea "..."        # ③파생 도메인 지시어만
//! 인증 env(ANTHROPIC_*)는 호출자가 export.

use serde_json::{json, Map, Value};
use soksak_plugin::derive_directive::synth_directives;
use soksak_plugin::domain_lib::builtin_library;
use soksak_plugin::exec_one;
use soksak_plugin::host::{build_prompt_with_schema, ClaudeHost, StubHost};
use soksak_plugin::interp::{val_to_json, Interp};
use soksak_plugin::lang::Language;
use soksak_plugin::provider::{run_agent, run_agent_text, AgentRequest};
use soksak_plugin::workflow_host::{NodeEvent, WorkflowHost};
use std::collections::HashSet;

const DEFAULT_MODEL: &str = "opus"; // 실제 모델은 인증 프로필이 매핑

fn main() {
    if let Err(e) = real_main() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// auth_env — claude -p 호출용 프로필 인증 env 수집 + 토큰 확인. 인증 프로필(ANTHROPIC_*) | oauth 프로필/oauth 프로필(OAUTH).
fn auth_env() -> Result<(Vec<(String, String)>, &'static str), String> {
    let env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| k.starts_with("ANTHROPIC_") || k == "CLAUDE_ACCOUNT_NAME" || k == "CLAUDE_CODE_OAUTH_TOKEN")
        .collect();
    if !env.iter().any(|(k, _)| k == "ANTHROPIC_AUTH_TOKEN" || k == "CLAUDE_CODE_OAUTH_TOKEN") {
        return Err("프로필 인증 토큰 미설정 — 인증 프로필(ANTHROPIC_AUTH_TOKEN) 또는 oauth 프로필(CLAUDE_CODE_OAUTH_TOKEN) export 후 실행하라".to_string());
    }
    let profile = if env.iter().any(|(k, _)| k == "CLAUDE_CODE_OAUTH_TOKEN") { "oauth 프로필/oauth 프로필" } else { "인증 프로필" };
    Ok((env, profile))
}

fn real_main() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || argv[0] == "-h" || argv[0] == "--help" {
        eprintln!("usage:");
        eprintln!("  soksak-workflow <skeleton.json|-> --arg K=V ... [--dry-run] [--lang ko|en|…] [--allow-tools \"T1 T2\"]  # program 해석 실행");
        eprintln!("  soksak-workflow <skeleton.json|-> --emit [--lang ko]                                                  # 발행만(노드 DAG stdout, LLM 미호출)");
        eprintln!("  soksak-workflow exec-one [--lang ko] [--model m] [--allow-tools \"...\"]                                # stdin {{prompt,schema?}} 한 노드 실행 → {{oxf,result}}");
        eprintln!("  soksak-workflow synth --idea \"...\"                                                                    # ③파생 도메인 지시어");
        eprintln!("  --lang: 출력 언어 계약. 모든 agent 프롬프트에 주입 → 산출물이 그 언어로. args.lang 도 주입.");
        return Ok(());
    }
    // synth — ③파생만(LLM 미호출).
    if argv[0] == "synth" {
        let mut idea = String::new();
        let mut i = 1;
        while i < argv.len() {
            if argv[i] == "--idea" {
                i += 1;
                idea = argv.get(i).cloned().ok_or("--idea 값 누락")?;
            }
            i += 1;
        }
        if idea.is_empty() {
            return Err("synth: --idea 필수".to_string());
        }
        let directives = synth_directives(&idea, &builtin_library());
        println!("{}", serde_json::to_string_pretty(&directives).map_err(|e| e.to_string())?);
        return Ok(());
    }

    // exec-one — 단일 노드 실행(규칙 C). stdin {prompt, schema?, model?} → claude → {oxf, result}.
    // 발행(interp)과 분리된 stateless 실행기. 코어 스케줄러가 칸반 ready 노드 하나를 이 경로로 실행한다.
    if argv[0] == "exec-one" {
        return run_exec_one(&argv);
    }

    let path = &argv[0];
    let mut args: Map<String, Value> = Map::new();
    let mut args_override: Option<Value> = None; // --args-json: cc 계약대로 args 를 verbatim(임의 JSON)
    let mut allow_tools: Vec<String> = vec![];
    let mut dry_run = false;
    let mut lang: Option<Language> = None; // --lang: 출력 언어 계약
    let mut emit = false; // --emit: 노드 발행만(WorkflowHost) + stdout JSON line. LLM 미호출.
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--arg" => {
                i += 1;
                let kv = argv.get(i).ok_or("--arg 값 누락")?;
                let (k, v) = kv.split_once('=').ok_or("--arg 는 KEY=VALUE 형식")?;
                args.insert(k.to_string(), Value::String(v.to_string()));
            }
            "--args-json" => {
                i += 1;
                let j = argv.get(i).ok_or("--args-json 값 누락")?;
                args_override = Some(serde_json::from_str(j).map_err(|e| format!("--args-json 파싱: {e}"))?);
            }
            "--allow-tools" => {
                i += 1;
                let t = argv.get(i).ok_or("--allow-tools 값 누락")?;
                allow_tools = t.split_whitespace().map(|s| s.to_string()).collect();
            }
            "--lang" => {
                i += 1;
                let v = argv.get(i).ok_or("--lang 값 누락")?;
                lang = Some(Language::parse(v));
            }
            "--dry-run" => dry_run = true,
            "--emit" => emit = true,
            other => return Err(format!("미지 인자 {other:?}")),
        }
        i += 1;
    }

    // skeleton 입력: "-" 면 stdin(플러그인이 추출기 출력을 파이프), 그 외 파일.
    let raw = if path == "-" {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin(), &mut buf).map_err(|e| format!("read stdin: {e}"))?;
        buf
    } else {
        std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?
    };
    let skeleton: Value = serde_json::from_slice(&raw).map_err(|e| format!("parse skeleton: {e}"))?;
    let program = skeleton
        .get("program")
        .cloned()
        .ok_or("skeleton 에 program(완전 AST) 없음 — 추출기 로 재추출 필요")?;
    let name = skeleton.get("meta").and_then(|m| m.get("name")).and_then(|n| n.as_str()).unwrap_or("workflow").to_string();

    // ③파생: IDEA 에서 도메인 지시어 합성 → args.directives 주입(워크플로가 args.directives 로 사용).
    if let Some(Value::String(idea)) = args.get("IDEA").cloned() {
        let directives = synth_directives(&idea, &builtin_library());
        let matched: Vec<&str> = directives.iter().map(|d| d.domain.as_str()).collect::<HashSet<_>>().into_iter().collect();
        eprintln!("[soksak] ③파생: 도메인 {:?} → 지시어 {}개 → args.directives", matched, directives.len());
        args.insert("directives".to_string(), serde_json::to_value(&directives).unwrap_or_else(|_| json!([])));
    }
    // args = --args-json(verbatim, cc 계약) 우선, 없으면 --arg 로 만든 객체.
    let mut args_json = args_override.unwrap_or(Value::Object(args));
    // args.lang 주입 — 워크플로가 args.lang 으로 읽을 수 있게(출력 언어 계약과 별개 채널).
    if let (Some(l), Value::Object(m)) = (&lang, &mut args_json) {
        m.insert("lang".to_string(), Value::String(l.code.clone()));
    }
    if let Some(l) = &lang {
        eprintln!("[soksak] 출력 언어: {} ({})", l.name, l.code);
    }

    // --emit: 발행만. WorkflowHost 가 program 을 해석하며 노드 DAG 를 stdout JSON line 으로 emit.
    // 규칙 C — agent 는 트리거를 일으키지 않는다. LLM 미호출(토큰 불필요). 실행은 스케줄러+exec-one.
    if emit {
        eprintln!("[soksak] {name} — 발행 모드(노드 DAG stdout, LLM 미호출)");
        let mut wh = WorkflowHost::new().with_emit(Box::new(|ev: &NodeEvent| {
            if let Ok(s) = serde_json::to_string(ev) {
                println!("{s}");
            }
        }));
        Interp::new(&mut wh).run(&program, args_json).map_err(|e| format!("interpret: {e}"))?;
        return Ok(());
    }

    // dry-run: StubHost 로 program 해석(LLM 미호출). 실행이므로 전 agent 가 trace 에.
    if dry_run {
        let mut h = StubHost::new(DEFAULT_MODEL.into()).with_lang(lang.clone());
        Interp::new(&mut h).run(&program, args_json).map_err(|e| format!("interpret: {e}"))?;
        let n = h.trace.iter().filter(|t| t.get("label").and_then(|l| l.as_str()).map_or(false, |s| !s.is_empty())).count();
        eprintln!("[soksak] dry-run — agent {n}회 실행 예정(LLM 미호출)");
        println!("{}", serde_json::to_string_pretty(&h.trace).map_err(|e| e.to_string())?);
        return Ok(());
    }

    // 실행: ClaudeHost. agent → claude -p. 프로필 인증 변수만 통과.
    let (env, profile) = auth_env()?;
    eprintln!("[soksak] {name} — program 해석 실행(agent→claude -p, 프로필={profile})");
    let mut h = ClaudeHost { env, allow_tools, default_model: DEFAULT_MODEL.into(), lang };
    let result = Interp::new(&mut h).run(&program, args_json).map_err(|e| format!("interpret: {e}"))?;
    println!("{}", serde_json::to_string_pretty(&val_to_json(&result)).map_err(|e| e.to_string())?);
    Ok(())
}

/// run_exec_one — exec-one 서브커맨드. stdin {prompt, schema?, model?} 한 노드 → claude → {oxf, result}.
fn run_exec_one(argv: &[String]) -> Result<(), String> {
    let mut lang: Option<Language> = None;
    let mut allow_tools: Vec<String> = vec![];
    let mut model_override: Option<String> = None;
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--lang" => {
                i += 1;
                lang = Some(Language::parse(argv.get(i).ok_or("--lang 값 누락")?));
            }
            "--allow-tools" => {
                i += 1;
                let t = argv.get(i).ok_or("--allow-tools 값 누락")?;
                allow_tools = t.split_whitespace().map(|s| s.to_string()).collect();
            }
            "--model" => {
                i += 1;
                model_override = Some(argv.get(i).ok_or("--model 값 누락")?.clone());
            }
            other => return Err(format!("exec-one: 미지 인자 {other:?}")),
        }
        i += 1;
    }
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw).map_err(|e| format!("read stdin: {e}"))?;
    let input = exec_one::parse_input(&raw)?;
    let model = model_override.or(input.model).unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let (env, profile) = auth_env()?;
    eprintln!("[soksak] exec-one (model={model}, 프로필={profile}) → claude -p");
    let full = build_prompt_with_schema(&input.prompt, input.schema.as_ref(), lang.as_ref());
    // 10800s(3h): lease=프로세스-생존 — 도는 중 안 잘림. 코어 zombie_backstop(3h)·register timeout_ms 와 천장 일치
    // (claude 가 backstop 전에 자체 종료 안 하게 ≥backstop). hang 방지 하드캡은 유지하되 넉넉히.
    let req = AgentRequest { prompt: full, model: &model, allowed_tools: allow_tools, timeout_secs: 10800 };
    // schema 있으면 JSON 파싱(구조화 산출), 없으면 raw 텍스트.
    let result = if input.schema.is_some() {
        run_agent(&req, &env)?
    } else {
        Value::String(run_agent_text(&req, &env)?)
    };
    println!("{}", serde_json::to_string_pretty(&exec_one::build_output(result)).map_err(|e| e.to_string())?);
    Ok(())
}
