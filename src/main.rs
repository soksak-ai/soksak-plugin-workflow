//! soksak-workflow — 워크플로 CLI. **workflow-doc@0.0.1**(언어중립 JSON 문서, doc_exec) 단일 경로 — stage 별로
//! 실행해 (a) 노드 DAG 를 *발행*(--emit)하거나 (b) stage/노드를 *실행*(exec-stage/exec-one)한다. agent 는
//! claude -p. 실행 오케스트레이션은 코어 스케줄러(kanban reconcile). 런타임은 워크플로 로직을 모름 —
//! 문서를 실행할 뿐. 레거시 skeleton(ESTree)/interp 경로는 backup/legacy-interp/ 에 보존(M5e).
//!
//!   soksak-workflow <doc.json|-> --emit [--args-json {...}] [--lang ko]     # 노드 DAG 발행(stdout JSON line, LLM 미호출)
//!   soksak-workflow --workflow <name> --emit [--args-json {...}]            # 번들 정본(workflows/<name>.doc.json) 발행
//!   soksak-workflow exec-one  [--lang ko] [--model m] [--allow-tools "..."] # stdin {prompt, schema?} 한 노드 실행 → {oxf, result} (스케줄러가 ready 노드에)
//!   soksak-workflow exec-stage [--lang ko] [--model m]                      # stdin {skeleton, stage, args} stage 실행 → 자식 {ev:add} + {ev:result}
//!   soksak-workflow synth --idea "..."                                      # ③파생 도메인 지시어만
//! 인증 env(ANTHROPIC_*)는 호출자가 export.

use serde_json::{json, Map, Value};
use soksak_plugin::derive_directive::synth_directives;
use soksak_plugin::domain_lib::builtin_library;
use soksak_plugin::exec_one;
use soksak_plugin::generate_skeleton::build_user_prompt;
use soksak_plugin::host::build_prompt_with_schema;
use soksak_plugin::lang::Language;
use soksak_plugin::provider::{run_agent, run_agent_text, AgentRequest};
use std::collections::HashSet;

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
        eprintln!("  soksak-workflow <doc.json|-> --emit [--args-json {{...}}] [--lang ko]                                  # workflow-doc 발행(stdout JSON line, LLM 미호출)");
        eprintln!("  soksak-workflow --workflow <name> --emit [--args-json {{...}}] [--lang ko]                             # 번들 정본(workflows/<name>.doc.json) 발행");
        eprintln!("  soksak-workflow generate-skeleton --idea \"...\" [--model m] [--lang ko] [--gen-out p] [--refs dir]    # 아이디어 → workflow-doc(LLM 저작·검증) JSON stdout");
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
    // 발행과 분리된 stateless 실행기. 코어 스케줄러가 칸반 ready 노드 하나를 이 경로로 실행한다.
    if argv[0] == "exec-one" {
        return run_exec_one(&argv);
    }

    // exec-stage — stage 작업 실행(동적 발행). stdin {workflow|skeleton(doc), stage, args:{directive, chunkRef, ledger…}}
    // → doc_exec 로 stage 실행(agent=claude, publish=NodeEvent) → 자식 {ev:add} JSON line + 최종 {ev:result}
    // (generate 는 DraftDoc 1문서). main.js reconcile 가 kind=task 노드를 이 경로로 실행해 항목/fact 동적 발행.
    if argv[0] == "exec-stage" {
        return run_exec_stage(&argv);
    }

    // generate-skeleton — 아이디어 → workflow-doc@0.0.1(LLM 저작) → validate(fail-loud) → doc JSON stdout.
    // system=workflow-doc 저작 스킬 + soksak draft-skill.md(역할), user=아이디어+③파생.
    if argv[0] == "generate-skeleton" {
        return run_generate_skeleton(&argv);
    }

    // --workflow <name> — 번들 정본 워크플로(plugin_root/workflows/<name>.doc.json) 해석(경로 대신 이름).
    // research/plan 처럼 저작 LLM 불참(PRINCIPLES §7) canonical doc 의 실행 통로.
    let (path, arg_start) = if argv[0] == "--workflow" {
        let name = argv.get(1).ok_or("--workflow 값(이름) 누락")?;
        (bundled_workflow_path(name)?, 2usize)
    } else {
        (argv[0].clone(), 1usize)
    };
    let path = &path;
    let mut args: Map<String, Value> = Map::new();
    let mut args_override: Option<Value> = None; // --args-json: cc 계약대로 args 를 verbatim(임의 JSON)
    let mut lang: Option<Language> = None; // --lang: 출력 언어 계약
    let mut emit = false; // --emit: 노드 발행만 + stdout JSON line. LLM 미호출.
    let mut i = arg_start;
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

    // doc 입력: "-" 면 stdin(플러그인이 저작 산출을 파이프), 그 외 파일.
    let raw = if path == "-" {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin(), &mut buf).map_err(|e| format!("read stdin: {e}"))?;
        buf
    } else {
        std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?
    };
    let doc: Value = serde_json::from_slice(&raw).map_err(|e| format!("parse workflow-doc: {e}"))?;
    // doc 단일 경로(M5e) — 레거시 skeleton(ESTree)/interp 는 backup/legacy-interp/ 로 이동, 비-doc 입력은 명시 거부.
    if !soksak_plugin::doc_exec::is_doc(&doc) {
        return Err("workflow-doc@0.0.1 필요(spec 필드) — 레거시 skeleton(ESTree AST) 경로는 제거됨(backup/legacy-interp/)".to_string());
    }
    if !emit {
        return Err("workflow-doc 직접 실행 경로 없음(실행=스케줄러) — 발행은 --emit, stage 실행은 exec-stage".to_string());
    }
    let name = doc.pointer("/meta/name").and_then(|n| n.as_str()).unwrap_or("workflow");
    if let Some(l) = &lang {
        eprintln!("[soksak] 출력 언어: {} ({})", l.name, l.code);
    }
    eprintln!("[soksak] {name} — 발행 모드(workflow-doc, 노드 DAG stdout, LLM 미호출)");
    // args = --args-json(verbatim) 우선, 없으면 --arg 조립. lang 주입.
    let mut args_json = args_override.take().unwrap_or(Value::Object(std::mem::take(&mut args)));
    if let (Some(l), Value::Object(m)) = (&lang, &mut args_json) {
        m.insert("lang".to_string(), Value::String(l.code.clone()));
    }
    // skeleton stage("") — validate 가 agent op 를 금지하므로(발행=LLM 미호출 계약) 러너는 도달 불가 방어.
    let mut no_agent = |_p: &str, _s: Option<&Value>, _l: &str| -> Result<Value, String> {
        Err("발행(--emit)은 agent 를 호출하지 않는다".to_string())
    };
    let (events, _result) = soksak_plugin::doc_exec::run(&doc, "", &args_json, &mut no_agent)?;
    for ev in &events {
        if let Ok(s) = serde_json::to_string(ev) {
            println!("{s}");
        }
    }
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
    let full = build_prompt_with_schema(&input.prompt, None, lang.as_ref()); // schema 는 --json-schema 강제로(prompt X)
    // 7200s(2h): provider 캡 = claude 무한 방지용. lease=프로세스-생존이라 천장 통일 불필요 — 정상은 provider 가
    // claude 종료→onExit→reply(검색 fan-out 1h+ 수용). register timeout_ms(zombie_backstop 3h)는 그것도 실패한
    // 좀비 전용(provider 캡보다 길게). 중복은 lease(도는 중 재발화 X)로 0 — 천장 일치 안 해도 안전.
    let has_schema = input.schema.is_some();
    let req = AgentRequest { prompt: full, model: &model, allowed_tools: allow_tools, timeout_secs: 7200, system_prompt: None, schema: input.schema, effort: "xhigh".into(), text_only: false };
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
    let stage = input.get("stage").and_then(|s| s.as_str()).ok_or("exec-stage 입력에 stage 필요")?.to_string();
    // workflow 슬롯(이름) — 번들 정본 doc 로드(canonical doc 을 task 마다 임베드하지 않는 통로; 단일 원천=번들 파일).
    if let Some(name) = input.get("workflow").and_then(|w| w.as_str()) {
        let p = bundled_workflow_path(name)?;
        let raw = std::fs::read(&p).map_err(|e| format!("번들 워크플로 읽기 {p}: {e}"))?;
        let doc: Value = serde_json::from_slice(&raw).map_err(|e| format!("번들 워크플로 파싱 {p}: {e}"))?;
        if !soksak_plugin::doc_exec::is_doc(&doc) {
            return Err(format!("번들 워크플로 {name:?} 가 workflow-doc@0.0.1 아님"));
        }
        return run_exec_stage_doc(&doc, &stage, &input, lang, allow_tools, model_override);
    }
    // workflow-doc@0.0.1 — task body 의 skeleton 슬롯에 doc 이 임베드돼 오면(main.js 는 무판별 relay) doc_exec 경로.
    if let Some(doc) = input.get("skeleton").filter(|s| soksak_plugin::doc_exec::is_doc(s)).cloned() {
        return run_exec_stage_doc(&doc, &stage, &input, lang, allow_tools, model_override);
    }
    // doc 단일 경로(M5e) — 레거시 skeleton(ESTree)/interp 는 backup/legacy-interp/ 로 이동, 비-doc 입력은 명시 거부.
    Err("exec-stage 입력에 workflow(번들 이름) 또는 skeleton(workflow-doc@0.0.1) 필요 — 레거시 program(ESTree AST) 경로는 제거됨(backup/legacy-interp/)".to_string())
}

/// run_exec_stage_doc — workflow-doc@0.0.1 stage 실행(exec-stage 의 doc 분기). interp 경로와 출력 계약 동일:
/// generate = DraftDoc 1문서(build→validate→stdout, 위반=발행 거부) / 그 외 = {ev:add} 스트림 + {ev:result}.
fn run_exec_stage_doc(
    doc: &Value,
    stage: &str,
    input: &Value,
    lang: Option<Language>,
    allow_tools: Vec<String>,
    model_override: Option<String>,
) -> Result<(), String> {
    // args = input.args + stage + lang 주입(interp 경로와 동일 조립 — 워크플로가 args.ledger/chunkRef 를 읽는다).
    let mut args_obj = match input.get("args") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    args_obj.insert("stage".to_string(), Value::String(stage.to_string()));
    if let Some(l) = &lang {
        args_obj.insert("lang".to_string(), Value::String(l.code.clone()));
    }
    let args_json = Value::Object(args_obj);
    let model = model_override
        .or_else(|| input.get("model").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let (env, profile) = auth_env()?;
    eprintln!("[soksak] exec-stage stage={stage} (workflow-doc, model={model}, 프로필={profile})");
    // agent 러너 — ClaudeHost.agent 동형(빌드 프롬프트+언어 계약, schema 는 --json-schema 강제, 실패는 전파).
    let mut agent_fn = |prompt: &str, schema: Option<&Value>, label: &str| -> Result<Value, String> {
        let full = build_prompt_with_schema(prompt, None, lang.as_ref());
        eprintln!("[soksak] agent {label:?} (model={model}, effort=xhigh) → claude -p");
        let req = AgentRequest {
            prompt: full,
            model: &model,
            allowed_tools: allow_tools.clone(),
            timeout_secs: 3600,
            system_prompt: None,
            schema: schema.cloned(),
            effort: "xhigh".into(),
            text_only: false,
        };
        if schema.is_some() {
            run_agent(&req, &env).map_err(|e| format!("agent {label:?} 실패: {e}"))
        } else {
            run_agent_text(&req, &env).map(Value::String).map_err(|e| format!("agent {label:?} 실패: {e}"))
        }
    };
    let (events, result) = soksak_plugin::doc_exec::run(doc, stage, &args_json, &mut agent_fn)?;
    if stage == "generate" {
        // interp 경로와 동일한 generate 배치 계약: 이벤트 → DraftDoc build → validate(위반=거부) → 1문서 stdout.
        let mut ddoc = soksak_plugin::draft_doc::build(&events)?;
        if let Some(Value::String(t)) = result.get("chunkTitle") {
            if !t.is_empty() {
                ddoc.chunk_title = Some(t.clone());
            }
        }
        if let Err(violations) = soksak_plugin::draft_doc::validate(&ddoc) {
            eprintln!("[soksak] generate DraftDoc 검증 실패(발행 거부):");
            for x in &violations {
                eprintln!("  - {x}");
            }
            return Err(format!("generate DraftDoc 검증 실패({}건) — 발행 거부", violations.len()));
        }
        println!("{}", serde_json::to_string(&ddoc).map_err(|e| e.to_string())?);
    } else {
        for ev in &events {
            if let Ok(s) = serde_json::to_string(ev) {
                println!("{s}");
            }
        }
        let out = json!({ "ev": "result", "value": result });
        println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    }
    Ok(())
}

/// bundled_workflow_path — 번들 정본 워크플로 경로(plugin_root/workflows/<name>.doc.json).
/// 이름은 파일명 안전 문자만 허용(경로 탈출 차단 — 영숫자/-/_).
fn bundled_workflow_path(name: &str) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("--workflow 이름 부적합: {name:?} (영숫자/-/_ 만)"));
    }
    let root = plugin_root().ok_or("--workflow: 플러그인 루트 해석 실패(references/draft-skill.md 기준)")?;
    let p = root.join("workflows").join(format!("{name}.doc.json"));
    if !p.is_file() {
        return Err(format!("번들 워크플로 없음: {}", p.display()));
    }
    Ok(p.display().to_string())
}

/// plugin_root — 이 바이너리가 속한 플러그인 루트(self-contained references/·tools/ 소재).
/// current_exe(<plugin>/target/<profile>/soksak-workflow)의 조상 중 `references/draft-skill.md` 를 가진 첫 디렉토리.
/// generate-skeleton 이 외부 리포(추출기) 없이 자기 트리의 지시어·파서를 찾는 근거.
fn plugin_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent();
    while let Some(d) = dir {
        if d.join("references/draft-skill.md").is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// run_generate_skeleton — generate-skeleton 서브커맨드. 아이디어 → workflow-doc@0.0.1(LLM 저작) → doc JSON stdout.
/// system=SKILL+api+patterns+draft-skill(**플러그인 번들 references/**, --refs 로 override 가능), user=아이디어+③파생.
/// 저작 게이트 = JSON 파싱(parse_json_lenient — 펜스/prose 방어) + doc_exec::validate(fail-loud) —
/// 종전 gen.js(JS 저작)의 acorn 파싱·node 서브프로세스는 doc 경로에서 불필요(문법 실패 모드 자체가 소멸).
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
    // refs dir 해석: ① --refs, ② env WORKFLOW_DIR/references(레거시 override), ③ **플러그인 번들**(self-contained 기본).
    let refs_dir = refs
        .or_else(|| std::env::var("WORKFLOW_DIR").ok().filter(|d| !d.is_empty()).map(|d| format!("{d}/references")))
        .or_else(|| plugin_root().map(|r| format!("{}/references", r.display())))
        .ok_or("generate-skeleton: references 해석 실패 — --refs 또는 플러그인 번들(references/draft-skill.md) 확인")?;
    // system 층 = draft **정련** 역할 지시어. LLM 은 정련만 한다(PRINCIPLES §7) — 문서 골격·상수(COMMON·
    // 스키마·프롬프트)는 번들 정본(workflows/draft.doc.json)을 도구가 조립한다. 19KB verbatim 재타이핑은
    // 문자 하나 누락으로 전체가 깨지는 취약 구조였다(실측: 18,911번째 문자 따옴표 누락).
    let system = std::fs::read_to_string(format!("{refs_dir}/draft-skill.md"))
        .map_err(|e| format!("refs 읽기 {refs_dir}/draft-skill.md: {e}"))?;
    // ③파생 도메인 지시어 → user 프롬프트 힌트.
    let directives = synth_directives(&idea, &builtin_library());
    let matched: Vec<&str> = directives.iter().map(|d| d.domain.as_str()).collect::<HashSet<_>>().into_iter().collect();
    eprintln!("[soksak] generate-skeleton: ③파생 도메인 {:?} → 지시어 {}개", matched, directives.len());
    let mut user = build_user_prompt(&idea, &directives);
    if let Some(l) = &lang {
        user.push_str(&l.contract());
    }

    // LLM 정련 — StructuredOutput 강제(REFINE_SCHEMA): 산출은 {directive, description} 소형 JSON 뿐이라
    // 문법 실패(따옴표/펜스/잘림) 클래스가 구조적으로 소멸한다. text_only: 도구 전면 차단. 529 backoff 는 provider.
    let (env, profile) = auth_env()?;
    eprintln!("[soksak] generate-skeleton (model={model}, 프로필={profile}) → claude -p 정련(directive)");
    let refine_schema = json!({
        "type": "object",
        "required": ["directive", "description"],
        "properties": {
            "directive": { "type": "string", "description": "정련된 DIRECTIVE 전문 — 아이디어의 실제 의도를 담은 지시어(섹션 라벨 재구성 허용, 실질 요건 누락 금지)" },
            "description": { "type": "string", "description": "이 드래프트의 한 줄 서술(담백)" }
        }
    });
    let req = AgentRequest {
        prompt: user,
        model: &model,
        allowed_tools: vec![],
        timeout_secs: 7200,
        system_prompt: Some(system), text_only: true,
        schema: Some(refine_schema),
        effort: "xhigh".into(),
    };
    // 번들 정본 골격 로드 — 상수(COMMON·스키마·프롬프트·stages)는 도구가 조립(byte 안정 §3, LLM 재타이핑 0).
    let tpl_path = bundled_workflow_path("draft")?;
    let tpl_raw = std::fs::read(&tpl_path).map_err(|e| format!("번들 draft 읽기 {tpl_path}: {e}"))?;
    let template: Value = serde_json::from_slice(&tpl_raw).map_err(|e| format!("번들 draft 파싱 {tpl_path}: {e}"))?;

    // 정련은 LLM 비결정 — 총 2회 시도(재정련 1회). 각 시도는 동일 게이트(주입+validate)를 통과해야 하고 최종 실패는 loud.
    let mut last_err = String::new();
    for attempt in 1..=2 {
        if attempt > 1 {
            eprintln!("[soksak] generate-skeleton 재정련 시도 {attempt}/2 — 직전: {last_err}");
        }
        let out = match run_agent(&req, &env) {
            Ok(o) => o,
            Err(e) => {
                last_err = format!("정련 호출 실패: {e}");
                continue;
            }
        };
        if let Some(p) = &gen_out {
            let _ = std::fs::write(p, serde_json::to_string_pretty(&out).unwrap_or_default());
            eprintln!("[soksak] 정련 산출 보존 → {p}");
        }
        let directive = out.get("directive").and_then(|d| d.as_str()).unwrap_or("").trim().to_string();
        let description = out.get("description").and_then(|d| d.as_str()).unwrap_or("").trim().to_string();
        if directive.is_empty() {
            last_err = "정련 directive 비어있음".to_string();
            continue;
        }
        let doc = soksak_plugin::doc_exec::inject_refinement(&template, &directive, &description);
        if let Err(violations) = soksak_plugin::doc_exec::validate(&doc) {
            last_err = format!("조립 doc 검증 실패({}건): {}", violations.len(), violations.first().cloned().unwrap_or_default());
            continue;
        }
        println!("{}", serde_json::to_string(&doc).map_err(|e| e.to_string())?);
        return Ok(());
    }
    Err(format!("generate-skeleton: 정련 2회 실패 — {last_err}"))
}
