//! soksak-run — 골격 실행 CLI(e2e). 골격 workflow.json 을 읽어 agent 를 claude -p 로 실행.
//!   soksak-run <workflow.json> [--arg KEY=VALUE ...] [--allow-tools "Tool1 Tool2"]
//! 인증 프로필 env(ANTHROPIC_*)는 호출자가 export(코어가 위임하는 형태). 결과 JSON 을 stdout 으로.

use serde_json::{json, Map, Value};
use soksak_plugin::derive_directive::synth_directives;
use soksak_plugin::domain_lib::builtin_library;
use soksak_plugin::exec::{run_skeleton, AgentInvocation};
use soksak_plugin::provider::{run_agent, AgentRequest};
use soksak_plugin::skeleton::Skeleton;
use std::collections::HashSet;

fn main() {
    if let Err(e) = real_main() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn real_main() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || argv[0] == "-h" || argv[0] == "--help" {
        eprintln!("usage: soksak-run <workflow.json> [--arg KEY=VALUE ...] [--allow-tools \"T1 T2\"]");
        return Ok(());
    }
    let path = &argv[0];
    let mut args: Map<String, Value> = Map::new();
    let mut allow_tools: Vec<String> = vec![];
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--arg" => {
                i += 1;
                let kv = argv.get(i).ok_or("--arg 값 누락")?;
                let (k, v) = kv.split_once('=').ok_or("--arg 는 KEY=VALUE 형식")?;
                args.insert(k.to_string(), Value::String(v.to_string()));
            }
            "--allow-tools" => {
                i += 1;
                let t = argv.get(i).ok_or("--allow-tools 값 누락")?;
                allow_tools = t.split_whitespace().map(|s| s.to_string()).collect();
            }
            other => return Err(format!("미지 인자 {other:?}")),
        }
        i += 1;
    }

    let raw = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    let skel = Skeleton::from_json(&raw)?;

    // ③파생: IDEA 에서 도메인 지시어 합성 → context 에 directives 주입(워크플로가 ${directives} 로 사용).
    if let Some(Value::String(idea)) = args.get("IDEA").cloned() {
        let directives = synth_directives(&idea, &builtin_library());
        let matched: Vec<&str> = directives.iter().map(|d| d.domain.as_str()).collect::<HashSet<_>>().into_iter().collect();
        eprintln!("[soksak-run] ③파생: 도메인 {:?} → 지시어 {}개 주입", matched, directives.len());
        args.insert("directives".to_string(), serde_json::to_value(&directives).unwrap_or_else(|_| json!([])));
    }
    eprintln!("[soksak-run] {} — steps={} agents 실행 시작", skel.meta.name, skel.steps.len());

    // 인증 프로필 env 수집(호출자가 export 한 ANTHROPIC_* 전부 전달).
    let env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| k.starts_with("ANTHROPIC_"))
        .collect();
    if env.is_empty() {
        return Err("ANTHROPIC_* env 미설정 — 인증 프로필 환경을 export 하고 실행하라".to_string());
    }

    // runner = claude -p(인증 프로필). agent 별 stderr 진행 로그.
    let runner = |inv: &AgentInvocation, _schema: Option<&Value>| -> Result<Value, String> {
        eprintln!("[soksak-run] agent {:?} (model={}) → claude -p", inv.label, inv.model);
        run_agent(
            &AgentRequest { prompt: inv.prompt.clone(), model: &inv.model, allowed_tools: allow_tools.clone() },
            &env,
        )
    };

    let results = run_skeleton(&skel, &args, runner)?;

    // 출력 = label → output(중복 label 은 첫 것 유지, 나머지 인덱스 접미).
    let mut used: HashSet<String> = HashSet::new();
    let mut out_map = Map::new();
    for (idx, r) in results.iter().enumerate() {
        let mut key = r.label.clone();
        if !used.insert(key.clone()) {
            key = format!("{}#{idx}", r.label);
        }
        out_map.insert(key, json!({ "phase": r.phase, "schema": r.schema, "output": r.output }));
    }
    println!("{}", serde_json::to_string_pretty(&Value::Object(out_map)).map_err(|e| e.to_string())?);
    Ok(())
}
