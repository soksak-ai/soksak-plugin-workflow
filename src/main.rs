//! soksak-run — 워크플로 실행 CLI. 추출기 가 떠낸 완전 skeleton 의 program(중립 AST)을
//! 인터프리터로 **해석**해 실행한다. agent 는 host(claude -p 인증 프로필). 런타임은 워크플로 로직을
//! 모름 — program 을 해석할 뿐. agent 수는 워크플로가 정함(내가 아님).
//!   soksak-run <skeleton.json|-> --arg K=V ... [--dry-run] [--allow-tools "T1 T2"]
//!   soksak-run synth --idea "..."        # ③파생 도메인 지시어만
//! 인증 env(ANTHROPIC_*)는 호출자가 export.

use serde_json::{json, Map, Value};
use soksak_plugin::derive_directive::synth_directives;
use soksak_plugin::domain_lib::builtin_library;
use soksak_plugin::host::{ClaudeHost, StubHost};
use soksak_plugin::interp::{val_to_json, Interp};
use std::collections::HashSet;

const DEFAULT_MODEL: &str = "opus"; // 실제 모델은 인증 프로필이 매핑

fn main() {
    if let Err(e) = real_main() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn real_main() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || argv[0] == "-h" || argv[0] == "--help" {
        eprintln!("usage:");
        eprintln!("  soksak-run <skeleton.json|-> --arg K=V ... [--dry-run] [--allow-tools \"T1 T2\"]  # program 해석 실행");
        eprintln!("  soksak-run synth --idea \"...\"                                                    # ③파생 도메인 지시어");
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

    let path = &argv[0];
    let mut args: Map<String, Value> = Map::new();
    let mut args_override: Option<Value> = None; // --args-json: cc 계약대로 args 를 verbatim(임의 JSON)
    let mut allow_tools: Vec<String> = vec![];
    let mut dry_run = false;
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
            "--dry-run" => dry_run = true,
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
    let args_json = args_override.unwrap_or(Value::Object(args));

    // dry-run: StubHost 로 program 해석(LLM 미호출). 실행이므로 전 agent 가 trace 에.
    if dry_run {
        let mut h = StubHost::new(DEFAULT_MODEL.into());
        Interp::new(&mut h).run(&program, args_json).map_err(|e| format!("interpret: {e}"))?;
        let n = h.trace.iter().filter(|t| t.get("label").and_then(|l| l.as_str()).map_or(false, |s| !s.is_empty())).count();
        eprintln!("[soksak] dry-run — agent {n}회 실행 예정(LLM 미호출)");
        println!("{}", serde_json::to_string_pretty(&h.trace).map_err(|e| e.to_string())?);
        return Ok(());
    }

    // 실행: ClaudeHost(인증 프로필). agent → claude -p.
    let env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| k.starts_with("ANTHROPIC_")).collect();
    if env.is_empty() {
        return Err("ANTHROPIC_* env 미설정 — 인증 프로필 환경을 export 하고 실행하라".to_string());
    }
    eprintln!("[soksak] {name} — program 해석 실행(agent→claude -p 인증 프로필)");
    let mut h = ClaudeHost { env, allow_tools, default_model: DEFAULT_MODEL.into() };
    let result = Interp::new(&mut h).run(&program, args_json).map_err(|e| format!("interpret: {e}"))?;
    println!("{}", serde_json::to_string_pretty(&val_to_json(&result)).map_err(|e| e.to_string())?);
    Ok(())
}
