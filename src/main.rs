//! soksak-workflow — 워크플로 CLI. 추출기 가 떠낸 완전 skeleton 의 program(중립 AST)을 인터프리터로
//! **해석**해 (a) 노드 DAG 를 *발행*(--emit)하거나 (b) stage/노드를 *실행*(exec-stage/exec-one)한다. agent 는
//! host(claude -p 인증 프로필). 실행 오케스트레이션은 코어 스케줄러(kanban reconcile). 런타임은 워크플로 로직을
//! 모름 — program 을 해석할 뿐. agent 수는 워크플로가 정함(내가 아님). 직접-실행/dry-run 경로는 제거됨.
//!
//!   soksak-workflow <skeleton.json|-> --emit [--arg K=V ...] [--lang ko]    # program 해석 → 노드 DAG 발행(stdout JSON line, LLM 미호출)
//!   soksak-workflow exec-one  [--lang ko] [--model m] [--allow-tools "..."] # stdin {prompt, schema?} 한 노드 실행 → {oxf, result} (스케줄러가 ready 노드에)
//!   soksak-workflow exec-stage [--lang ko] [--model m]                      # stdin {skeleton, stage, args} stage 실행 → 자식 {ev:add} + {ev:result}
//!   soksak-workflow synth --idea "..."                                      # ③파생 도메인 지시어만
//! 인증 env(ANTHROPIC_*)는 호출자가 export.

use serde_json::{json, Map, Value};
use soksak_plugin::derive_directive::synth_directives;
use soksak_plugin::domain_lib::builtin_library;
use soksak_plugin::exec_one;
use soksak_plugin::generate_skeleton::{build_system_prompt, build_user_prompt, strip_js_fence};
use soksak_plugin::host::{build_prompt_with_schema, ClaudeHost};
use soksak_plugin::interp::{val_to_json, Host, Interp, Val};
use soksak_plugin::lang::Language;
use soksak_plugin::provider::{run_agent, run_agent_text, AgentRequest};
use soksak_plugin::emit_host::{ClaudeEmitHost, EmitHost, NodeEvent};
use std::collections::{BTreeMap, HashSet};

const DEFAULT_MODEL: &str = "opus"; // 실제 모델은 인증 프로필이 매핑

fn main() {
    if let Err(e) = real_main() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// auth_env — claude -p 호출용 인증 env 수집 + 토큰 확인. ANTHROPIC_AUTH_TOKEN 프로필을 OAuth 프로필보다 우선.
/// 환경에 두 토큰이 공존할 때(래퍼가 ANTHROPIC_* 를 주입해도 zshrc 의 OAUTH 가 잔류) 토큰 프로필이 쓰이도록 —
/// ANTHROPIC_AUTH_TOKEN 있으면 그 프로필 확정 + OAUTH 를 env 에서 제외(혼합 → claude 오판 회피). 없으면 OAuth.
fn auth_env() -> Result<(Vec<(String, String)>, &'static str), String> {
    let all: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| k.starts_with("ANTHROPIC_") || k == "CLAUDE_ACCOUNT_NAME" || k == "CLAUDE_CODE_OAUTH_TOKEN")
        .collect();
    let has_token = all.iter().any(|(k, _)| k == "ANTHROPIC_AUTH_TOKEN");
    let has_oauth = all.iter().any(|(k, _)| k == "CLAUDE_CODE_OAUTH_TOKEN");
    if !has_token && !has_oauth {
        return Err("프로필 인증 토큰 미설정 — ANTHROPIC_AUTH_TOKEN 또는 CLAUDE_CODE_OAUTH_TOKEN export 후 실행하라".to_string());
    }
    // 토큰 프로필 우선: ANTHROPIC_AUTH_TOKEN 있으면 그 env 만. OAUTH 가 잔류해도 제외(혼합 방지).
    let (env, profile) = if has_token {
        (all.into_iter().filter(|(k, _)| k.starts_with("ANTHROPIC_") || k == "CLAUDE_ACCOUNT_NAME").collect(), "token")
    } else {
        (all, "oauth")
    };
    Ok((env, profile))
}

fn real_main() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || argv[0] == "-h" || argv[0] == "--help" {
        eprintln!("usage:");
        eprintln!("  soksak-workflow <skeleton.json|-> --emit [--arg K=V ...] [--lang ko]                                  # program 해석 → 노드 DAG 발행(stdout JSON line, LLM 미호출)");
        eprintln!("  soksak-workflow generate-skeleton --idea \"...\" [--model m] [--lang ko] [--gen-out p] [--refs dir]    # 아이디어 → gen.js(LLM 저작) → skeleton stdout");
        eprintln!("  soksak-workflow exec-one [--lang ko] [--model m] [--allow-tools \"...\"]                                # stdin {{prompt,schema?}} 한 노드 실행 → {{oxf,result}}");
        eprintln!("  soksak-workflow exec-stage [--lang ko] [--model m]                                                    # stdin {{skeleton,stage,args}} stage 실행 → 자식 {{ev:add}} + {{ev:result}}");
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

    // exec-stage — stage 작업 실행(모델 B 동적 발행). stdin {skeleton:{program}, stage, args:{directive, chunkRef}}
    // → ClaudeEmitHost 로 해석(opts.publish 없으면 claude, 있으면 자식 노드 발행) → 자식 NodeEvent JSON line
    // stdout + 최종 {ev:result}. main.js reconcile 가 kind=task 노드를 이 경로로 실행해 그룹/항목 동적 발행.
    if argv[0] == "exec-stage" {
        return run_exec_stage(&argv);
    }

    // generate-skeleton — 아이디어 → gen.js(LLM 저작) → node 추출기 parse → skeleton stdout.
    // system=범용 Workflow 스킬 + soksak draft-skill.md, user=아이디어+③파생. 실행 워크플로 산출(draft.js 아님).
    if argv[0] == "generate-skeleton" {
        return run_generate_skeleton(&argv);
    }

    let path = &argv[0];
    let mut args: Map<String, Value> = Map::new();
    let mut args_override: Option<Value> = None; // --args-json: cc 계약대로 args 를 verbatim(임의 JSON)
    let mut lang: Option<Language> = None; // --lang: 출력 언어 계약
    let mut emit = false; // --emit: 노드 발행만(EmitHost) + stdout JSON line. LLM 미호출.
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
            "--lang" => {
                i += 1;
                let v = argv.get(i).ok_or("--lang 값 누락")?;
                lang = Some(Language::parse(v));
            }
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

    // --emit: 발행만. EmitHost 가 program 을 해석하며 노드 DAG 를 stdout JSON line 으로 emit.
    // 규칙 C — agent 는 트리거를 일으키지 않는다. LLM 미호출(토큰 불필요). 실행은 스케줄러+exec-one.
    if emit {
        eprintln!("[soksak] {name} — 발행 모드(노드 DAG stdout, LLM 미호출)");
        let mut wh = EmitHost::new().with_emit(Box::new(|ev: &NodeEvent| {
            if let Ok(s) = serde_json::to_string(ev) {
                println!("{s}");
            }
        }));
        Interp::new(&mut wh).run(&program, args_json).map_err(|e| format!("interpret: {e}"))?;
        return Ok(());
    }

    // 직접-실행/dry-run 경로는 제거됨 — 실행은 코어 스케줄러(reconcile → exec-one/exec-stage).
    // skeleton 경로는 발행(--emit) 전용. lang/args 는 발행 시 program 에 주입된다.
    Err(format!("{name}: skeleton 직접 실행 경로 제거됨(실행=스케줄러). 발행은 --emit, 단위 실행은 exec-one/exec-stage"))
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
    let full = build_prompt_with_schema(&input.prompt, None, lang.as_ref()); // schema 는 --json-schema 강제로(prompt X)
    // 7200s(2h): provider 캡 = claude 무한 방지용. lease=프로세스-생존이라 천장 통일 불필요 — 정상은 provider 가
    // claude 종료→onExit→reply(검색 fan-out 1h+ 수용). register timeout_ms(zombie_backstop 3h)는 그것도 실패한
    // 좀비 전용(provider 캡보다 길게). 중복은 lease(도는 중 재발화 X)로 0 — 천장 일치 안 해도 안전.
    let has_schema = input.schema.is_some();
    let req = AgentRequest { prompt: full, model: &model, allowed_tools: allow_tools, timeout_secs: 7200, system_prompt: None, schema: input.schema, effort: "xhigh".into() };
    // schema 있으면 JSON 파싱(구조화 산출), 없으면 raw 텍스트.
    let result = if has_schema {
        run_agent(&req, &env)?
    } else {
        Value::String(run_agent_text(&req, &env)?)
    };
    println!("{}", serde_json::to_string_pretty(&exec_one::build_output(result)).map_err(|e| e.to_string())?);
    Ok(())
}

/// run_exec_stage — stage 작업 실행(모델 B). stdin {skeleton:{program}, stage, args, model?} → ClaudeEmitHost 해석.
/// opts.publish 없는 agent(예: genPrompt)는 claude 실행, opts.publish:true agent 는 자식 노드 발행(stdout JSON line).
/// 최종 워크플로 return 은 {ev:result, value} 로. main.js reconcile 가 kind=task 노드를 이걸로 실행해 동적 발행.
fn run_exec_stage(argv: &[String]) -> Result<(), String> {
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
            other => return Err(format!("exec-stage: 미지 인자 {other:?}")),
        }
        i += 1;
    }
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw).map_err(|e| format!("read stdin: {e}"))?;
    let input: Value = serde_json::from_str(raw.trim()).map_err(|e| format!("exec-stage 입력 JSON 파싱: {e}"))?;
    // skeleton.program(완전 AST) 또는 program 직접.
    let program = input
        .get("skeleton")
        .and_then(|s| s.get("program"))
        .or_else(|| input.get("program"))
        .cloned()
        .ok_or("exec-stage 입력에 skeleton.program(완전 AST) 필요")?;
    let stage = input.get("stage").and_then(|s| s.as_str()).ok_or("exec-stage 입력에 stage 필요")?.to_string();
    // args = input.args(객체) + stage + lang 주입.
    let mut args_obj = match input.get("args") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    args_obj.insert("stage".to_string(), Value::String(stage.clone()));
    if let Some(l) = &lang {
        args_obj.insert("lang".to_string(), Value::String(l.code.clone()));
    }
    let args_json = Value::Object(args_obj);
    let model = model_override
        .or_else(|| input.get("model").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let (env, profile) = auth_env()?;
    eprintln!("[soksak] exec-stage stage={stage} (model={model}, 프로필={profile})");
    // claude 러너 = ClaudeHost(비-publish agent 만 탄다). publish agent 는 ClaudeEmitHost.wh 가 발행.
    let mut ch = ClaudeHost { env, allow_tools, default_model: model, lang };
    let run = move |p: &str, o: &BTreeMap<String, Val>| ch.agent(p, o);
    let mut h = ClaudeEmitHost::new(run).with_emit(Box::new(|ev: &NodeEvent| {
        if let Ok(s) = serde_json::to_string(ev) {
            println!("{s}");
        }
    }));
    let result = Interp::new(&mut h).run(&program, args_json).map_err(|e| format!("exec-stage interpret: {e}"))?;
    // 최종 워크플로 return — main.js 가 덩어리 title 갱신 등에 쓴다(ev:result 로 자식 add 와 구분).
    let out = json!({ "ev": "result", "value": val_to_json(&result) });
    println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    Ok(())
}

/// run_generate_skeleton — generate-skeleton 서브커맨드. 아이디어 → gen.js(LLM 저작) → skeleton stdout.
/// system=SKILL+api+patterns+draft-skill(--refs dir), user=아이디어+③파생(+lang 계약). schema 없음(gen.js=JS 소스).
/// gen.js 는 파일로 떨궈(cli.js parse 는 파일 인자만) `node <cc>/src/cli.js parse` → skeleton. --gen-out 시 gen.js 보존.
fn run_generate_skeleton(argv: &[String]) -> Result<(), String> {
    let mut idea = String::new();
    let mut model = DEFAULT_MODEL.to_string();
    let mut lang: Option<Language> = None;
    let mut gen_out: Option<String> = None;
    let mut refs: Option<String> = None;
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--idea" => {
                i += 1;
                idea = argv.get(i).cloned().ok_or("--idea 값 누락")?;
            }
            "--model" => {
                i += 1;
                model = argv.get(i).cloned().ok_or("--model 값 누락")?;
            }
            "--lang" => {
                i += 1;
                lang = Some(Language::parse(argv.get(i).ok_or("--lang 값 누락")?));
            }
            "--gen-out" => {
                i += 1;
                gen_out = Some(argv.get(i).cloned().ok_or("--gen-out 값 누락")?);
            }
            "--refs" => {
                i += 1;
                refs = Some(argv.get(i).cloned().ok_or("--refs 값 누락")?);
            }
            other => return Err(format!("generate-skeleton: 미지 인자 {other:?}")),
        }
        i += 1;
    }
    if idea.trim().is_empty() {
        return Err("generate-skeleton: --idea 필수".to_string());
    }
    // refs dir = <추출기>/references. --refs 우선, 없으면 env WORKFLOW_DIR/references.
    let refs_dir = refs
        .or_else(|| std::env::var("WORKFLOW_DIR").ok().filter(|d| !d.is_empty()).map(|d| format!("{d}/references")))
        .ok_or("generate-skeleton: --refs <추출기>/references 또는 env WORKFLOW_DIR 필요")?;
    let read_ref = |rel: &str| -> Result<String, String> {
        std::fs::read_to_string(format!("{refs_dir}/{rel}")).map_err(|e| format!("refs 읽기 {refs_dir}/{rel}: {e}"))
    };
    // system 층 = 범용 Workflow 저작 스킬 + soksak draft 역할 지시어(전문).
    let system = build_system_prompt(
        &read_ref("workflow/SKILL.md")?,
        &read_ref("workflow/api-reference.md")?,
        &read_ref("workflow/patterns.md")?,
        &read_ref("draft-skill.md")?,
    );
    // ③파생 도메인 지시어 → user 프롬프트 힌트.
    let directives = synth_directives(&idea, &builtin_library());
    let matched: Vec<&str> = directives.iter().map(|d| d.domain.as_str()).collect::<HashSet<_>>().into_iter().collect();
    eprintln!("[soksak] generate-skeleton: ③파생 도메인 {:?} → 지시어 {}개", matched, directives.len());
    let mut user = build_user_prompt(&idea, &directives);
    if let Some(l) = &lang {
        user.push_str(&l.contract());
    }

    // LLM 저작 — 인증 프로필, effort xhigh, schema 없음(gen.js 는 JS 소스 → run_agent_text raw). 529 backoff 는 provider.
    let (env, profile) = auth_env()?;
    eprintln!("[soksak] generate-skeleton (model={model}, 프로필={profile}) → claude -p 저작");
    let req = AgentRequest {
        prompt: user,
        model: &model,
        allowed_tools: vec![],
        timeout_secs: 7200,
        system_prompt: Some(system),
        schema: None,
        effort: "xhigh".into(),
    };
    let raw = run_agent_text(&req, &env)?;
    let gen_js = strip_js_fence(&raw);
    if gen_js.trim().is_empty() {
        return Err("generate-skeleton: 저작 산출이 비어있음(인증/모델/네트워크 확인)".to_string());
    }

    // gen.js 파일로 — cli.js parse 는 stdin 미지원(파일 인자만). --gen-out 없으면 temp(파싱 후 삭제).
    let gen_path = match &gen_out {
        Some(p) => p.clone(),
        None => format!("{}/soksak-gen-{}.js", std::env::temp_dir().display(), std::process::id()),
    };
    std::fs::write(&gen_path, &gen_js).map_err(|e| format!("gen.js 쓰기 {gen_path}: {e}"))?;

    // node <추출기>/src/cli.js parse <gen_path> → skeleton JSON stdout.
    let cc_root = std::path::Path::new(&refs_dir)
        .parent()
        .ok_or("generate-skeleton: refs_dir 부모(추출기 root) 해석 실패")?;
    let cli = cc_root.join("src").join("cli.js");
    let out = std::process::Command::new("node")
        .arg(&cli)
        .arg("parse")
        .arg(&gen_path)
        .output()
        .map_err(|e| format!("node parse spawn: {e} (cli={})", cli.display()))?;
    if !out.status.success() {
        if gen_out.is_none() {
            let _ = std::fs::remove_file(&gen_path);
        }
        return Err(format!(
            "추출기 parse 실패(gen.js 가 interp 서브셋 위반?): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // skeleton stdout 통과.
    print!("{}", String::from_utf8_lossy(&out.stdout));
    if gen_out.is_none() {
        let _ = std::fs::remove_file(&gen_path);
    } else {
        eprintln!("[soksak] gen.js 보존 → {gen_path}");
    }
    Ok(())
}
