//! soksak-workflow — 워크플로 CLI. **workflow-doc@0.0.1**(언어중립 JSON 문서, doc_exec)을 stage 별로 실행해
//! (a) 노드 DAG 를 *발행*(--emit)하거나 (b) stage/노드를 *실행*(exec-stage/exec-one)한다. 레거시 skeleton
//! (추출기 ESTree AST, interp)도 같은 진입점에서 하위호환으로 해석한다. agent 는 host(claude -p 인증 프로필).
//! 실행 오케스트레이션은 코어 스케줄러(kanban reconcile). 런타임은 워크플로 로직을 모름 — 문서/AST 를 실행할 뿐.
//!
//!   soksak-workflow <doc.json|skeleton.json|-> --emit [--arg K=V ...] [--lang ko]  # 노드 DAG 발행(stdout JSON line, LLM 미호출)
//!   soksak-workflow exec-one  [--lang ko] [--model m] [--allow-tools "..."] # stdin {prompt, schema?} 한 노드 실행 → {oxf, result} (스케줄러가 ready 노드에)
//!   soksak-workflow exec-stage [--lang ko] [--model m]                      # stdin {skeleton, stage, args} stage 실행 → 자식 {ev:add} + {ev:result}
//!   soksak-workflow synth --idea "..."                                      # ③파생 도메인 지시어만
//! 인증 env(ANTHROPIC_*)는 호출자가 export.

use serde_json::{json, Map, Value};
use soksak_plugin::derive_directive::synth_directives;
use soksak_plugin::domain_lib::builtin_library;
use soksak_plugin::exec_one;
use soksak_plugin::generate_skeleton::{build_system_prompt, build_user_prompt};
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

    // generate-skeleton — 아이디어 → workflow-doc@0.0.1(LLM 저작) → validate(fail-loud) → doc JSON stdout.
    // system=workflow-doc 저작 스킬 + soksak draft-skill.md(역할), user=아이디어+③파생.
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
    // workflow-doc@0.0.1(언어중립 JSON 문서) — doc_exec 경로. skeleton(ESTree AST)은 종래 interp 경로(하위호환).
    if soksak_plugin::doc_exec::is_doc(&skeleton) {
        if !emit {
            return Err("workflow-doc 직접 실행 경로 없음(실행=스케줄러) — 발행은 --emit, stage 실행은 exec-stage".to_string());
        }
        let name = skeleton.pointer("/meta/name").and_then(|n| n.as_str()).unwrap_or("workflow");
        if let Some(l) = &lang {
            eprintln!("[soksak] 출력 언어: {} ({})", l.name, l.code);
        }
        eprintln!("[soksak] {name} — 발행 모드(workflow-doc, 노드 DAG stdout, LLM 미호출)");
        // args: --arg/--args-json 조립 재사용 — doc 경로는 아래 program 조립 없이 바로 실행.
        let mut args_json2 = args_override.take().unwrap_or(Value::Object(std::mem::take(&mut args)));
        if let (Some(l), Value::Object(m)) = (&lang, &mut args_json2) {
            m.insert("lang".to_string(), Value::String(l.code.clone()));
        }
        // skeleton stage("") — validate 가 agent op 를 금지하므로(발행=LLM 미호출 계약) 러너는 도달 불가 방어.
        let mut no_agent = |_p: &str, _s: Option<&Value>, _l: &str| -> Result<Value, String> {
            Err("발행(--emit)은 agent 를 호출하지 않는다".to_string())
        };
        let (events, _result) = soksak_plugin::doc_exec::run(&skeleton, "", &args_json2, &mut no_agent)?;
        for ev in &events {
            if let Ok(s) = serde_json::to_string(ev) {
                println!("{s}");
            }
        }
        return Ok(());
    }
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
    // workflow-doc@0.0.1 — task body 의 skeleton 슬롯에 doc 이 임베드돼 오면(main.js 는 무판별 relay) doc_exec 경로.
    if let Some(doc) = input.get("skeleton").filter(|s| soksak_plugin::doc_exec::is_doc(s)).cloned() {
        return run_exec_stage_doc(&doc, &stage, &input, lang, allow_tools, model_override);
    }
    // skeleton.program(완전 AST) 또는 program 직접 — 종래 interp 경로(하위호환).
    let program = input
        .get("skeleton")
        .and_then(|s| s.get("program"))
        .or_else(|| input.get("program"))
        .cloned()
        .ok_or("exec-stage 입력에 skeleton.program(완전 AST) 필요")?;
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
    // generate stage 는 산출을 **id 기반 정규형 DraftDoc 1문서**로 배치 출력(스트림 대신) — build+validate 로 인증.
    // hunt/audit·비-draft·기타 stage 는 **기존 줄단위 스트림 유지**(자식 {ev:add} + {ev:result}) — 하위호환.
    let is_generate = stage == "generate";
    let mut h = if is_generate {
        // 스트림 콜백 미설치 — 이벤트를 wh.events 버퍼에만 수집(끝에 DraftDoc 로 접어 배치 출력).
        ClaudeEmitHost::new(run)
    } else {
        ClaudeEmitHost::new(run).with_emit(Box::new(|ev: &NodeEvent| {
            if let Ok(s) = serde_json::to_string(ev) {
                println!("{s}");
            }
        }))
    };
    let result = Interp::new(&mut h).run(&program, args_json).map_err(|e| format!("exec-stage interpret: {e}"))?;
    if is_generate {
        // 수집 이벤트 → DraftDoc(정규형) → validate(위반 시 stderr+exit). 통과 시 DraftDoc JSON 1문서 stdout.
        let mut doc = soksak_plugin::draft_doc::build(&h.wh.events)?;
        // 워크플로 return {chunkTitle} → 덩어리 title 갱신(relay 가 chunk_ref 노드에 적용). 스트림 result 대체.
        if let Value::Object(m) = val_to_json(&result) {
            if let Some(Value::String(t)) = m.get("chunkTitle") {
                if !t.is_empty() {
                    doc.chunk_title = Some(t.clone());
                }
            }
        }
        if let Err(violations) = soksak_plugin::draft_doc::validate(&doc) {
            eprintln!("[soksak] generate DraftDoc 검증 실패(발행 거부):");
            for x in &violations {
                eprintln!("  - {x}");
            }
            return Err(format!("generate DraftDoc 검증 실패({}건) — 발행 거부", violations.len()));
        }
        // DraftDoc 1문서 — main.js relay 가 파싱(verify_contract prompt.put + requirements/tasks node.add; 평탄 — 그룹 없음).
        println!("{}", serde_json::to_string(&doc).map_err(|e| e.to_string())?);
    } else {
        // 최종 워크플로 return — main.js 가 덩어리 title 갱신 등에 쓴다(ev:result 로 자식 add 와 구분).
        let out = json!({ "ev": "result", "value": val_to_json(&result) });
        println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    }
    Ok(())
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
    // 기본 = 이 바이너리가 속한 플러그인 트리의 references/ — 외부 리포(추출기) 런타임 의존 없음.
    let refs_dir = refs
        .or_else(|| std::env::var("WORKFLOW_DIR").ok().filter(|d| !d.is_empty()).map(|d| format!("{d}/references")))
        .or_else(|| plugin_root().map(|r| format!("{}/references", r.display())))
        .ok_or("generate-skeleton: references 해석 실패 — --refs 또는 플러그인 번들(references/draft-skill.md) 확인")?;
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

    // LLM 저작 — 인증 프로필, effort xhigh, schema 없음(문서는 크고 자유형 문자열 값이 많아 raw 텍스트 → 관용 파싱).
    // text_only: 도구 전면 차단(모델이 파일 Write 시도 등으로 이탈 못 하게 — 순수 JSON 텍스트만). 529 backoff 는 provider.
    let (env, profile) = auth_env()?;
    eprintln!("[soksak] generate-skeleton (model={model}, 프로필={profile}) → claude -p 저작(workflow-doc)");
    let req = AgentRequest {
        prompt: user,
        model: &model,
        allowed_tools: vec![],
        timeout_secs: 7200,
        system_prompt: Some(system), text_only: true,
        schema: None,
        effort: "xhigh".into(),
    };
    let raw = run_agent_text(&req, &env)?;
    if let Some(p) = &gen_out {
        std::fs::write(p, &raw).map_err(|e| format!("저작 원문 쓰기 {p}: {e}"))?;
        eprintln!("[soksak] 저작 원문 보존 → {p}");
    }
    // 저작 게이트 ① JSON 파싱(펜스·앞뒤 prose 방어 — parse_json_lenient) ② workflow-doc validate(fail-loud).
    let doc = soksak_plugin::provider::parse_json_lenient(&raw)
        .map_err(|e| format!("generate-skeleton: 저작 산출이 JSON 아님 — {e}"))?;
    if !soksak_plugin::doc_exec::is_doc(&doc) {
        return Err(format!(
            "generate-skeleton: 저작 산출이 workflow-doc@0.0.1 아님(spec={:?})",
            doc.get("spec").and_then(|s| s.as_str()).unwrap_or("")
        ));
    }
    if let Err(violations) = soksak_plugin::doc_exec::validate(&doc) {
        eprintln!("[soksak] 저작 doc 검증 실패:");
        for x in &violations {
            eprintln!("  - {x}");
        }
        return Err(format!("generate-skeleton: 저작 doc 검증 실패({}건)", violations.len()));
    }
    println!("{}", serde_json::to_string(&doc).map_err(|e| e.to_string())?);
    Ok(())
}
