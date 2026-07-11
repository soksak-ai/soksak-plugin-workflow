// reconcile.rs 테스트 — reconcile.test.mjs 111케이스 1:1 이식. #[path] 로 reconcile 모듈에 포함되어
// super::* 는 reconcile 를 가리킨다. 골든 문자열·봉투 의미론 byte-for-byte 보존.
// chunk 1: 순수 헬퍼(is_done·pick_ready·build_ledger·exec_result_to_edit·build_add_params·
// resolve_directive·gen_skeleton_args·build_secret_env_map·build_spawn_cmd·lease_active).
use super::*;
use serde_json::json;

// 노드 리터럴 헬퍼 — json! → Node.
fn node(v: Value) -> Node {
    serde_json::from_value(v).expect("node fixture")
}
fn nodes(vs: Vec<Value>) -> Vec<Node> {
    vs.into_iter().map(node).collect()
}
fn ids(ns: &[Node]) -> Vec<String> {
    ns.iter().map(|n| n.id.clone()).collect()
}
fn sorted_ids(ns: &[Node]) -> Vec<String> {
    let mut v = ids(ns);
    v.sort();
    v
}

// ── isDone ───────────────────────────────────────────────────────────────────
#[test]
fn is_done_status_done_only() {
    assert!(is_done(Some(&node(json!({ "id": "a", "status": "done" })))));
    assert!(!is_done(Some(&node(json!({ "id": "a", "status": "todo" })))));
    assert!(!is_done(None));
}

#[test]
fn is_done_item_badge_axis() {
    // 항목은 badge o/x/f 가 done(status 축 아님) — ① deadlock 방지.
    let mk = |badge: Value| node(json!({ "id": "i", "kind": "item", "badge": badge, "status": "todo" }));
    assert!(is_done(Some(&mk(json!("o")))));
    assert!(is_done(Some(&mk(json!("x")))));
    assert!(is_done(Some(&mk(json!("f")))));
    assert!(!is_done(Some(&mk(json!("검수전")))), "미검증 항목은 done 아님");
    assert!(!is_done(Some(&node(json!({ "id": "i", "kind": "item", "status": "todo" })))), "badge 없으면 done 아님");
}

// ── pickReady ──────────────────────────────────────────────────────────────
#[test]
fn pick_ready_verified_item_unblocks_hunt() {
    let ns = nodes(vec![
        json!({ "id": "i1", "kind": "item", "badge": "o", "status": "todo", "parentId": "g0", "blockedBy": [] }),
        json!({ "id": "i2", "kind": "item", "badge": "x", "status": "todo", "parentId": "g0", "blockedBy": [] }),
        json!({ "id": "hunt", "kind": "task", "status": "todo", "parentId": "chunk", "blockedBy": ["i1", "i2"] }),
    ]);
    assert_eq!(ids(&pick_ready(&ns)), vec!["hunt"]);
}

#[test]
fn pick_ready_pending_leaf_deps_done() {
    let ns = nodes(vec![
        json!({ "id": "a", "badge": "검수전", "blockedBy": [], "parentId": null, "status": "todo" }),
        json!({ "id": "b", "badge": "o", "blockedBy": [], "parentId": null, "status": "todo" }),
        json!({ "id": "c", "badge": "검수전", "blockedBy": ["a"], "parentId": null, "status": "todo" }),
        json!({ "id": "p", "badge": "검수전", "blockedBy": [], "parentId": null, "status": "todo" }),
        json!({ "id": "ch", "badge": "검수전", "blockedBy": [], "parentId": "p", "status": "todo" }),
    ]);
    assert_eq!(sorted_ids(&pick_ready(&ns)), vec!["a", "ch"]);
}

#[test]
fn pick_ready_blocked_by_done_unblocks() {
    let ns = nodes(vec![
        json!({ "id": "a", "badge": "o", "blockedBy": [], "parentId": null, "status": "done" }),
        json!({ "id": "c", "badge": "검수전", "blockedBy": ["a"], "parentId": null, "status": "todo" }),
    ]);
    assert_eq!(ids(&pick_ready(&ns)), vec!["c"]);
}

#[test]
fn pick_ready_stage_task_by_status() {
    let ns = nodes(vec![
        json!({ "id": "gen", "kind": "task", "status": "todo", "blockedBy": [], "parentId": null }),
        json!({ "id": "aud", "kind": "task", "status": "done", "blockedBy": [], "parentId": null }),
        json!({ "id": "hunt", "kind": "task", "status": "todo", "blockedBy": ["gen"], "parentId": null }),
    ]);
    assert_eq!(ids(&pick_ready(&ns)), vec!["gen"]);
}

#[test]
fn pick_ready_mixed_item_and_stage() {
    let ns = nodes(vec![
        json!({ "id": "gen", "kind": "task", "status": "done", "blockedBy": [], "parentId": null }),
        json!({ "id": "i1", "badge": "검수전", "kind": "item", "status": "todo", "blockedBy": [], "parentId": "g0" }),
        json!({ "id": "hunt", "kind": "task", "status": "todo", "blockedBy": ["gen"], "parentId": null }),
    ]);
    assert_eq!(sorted_ids(&pick_ready(&ns)), vec!["hunt", "i1"]);
}

#[test]
fn pick_ready_empty_safe() {
    assert_eq!(pick_ready(&[]).len(), 0);
}

#[test]
fn pick_ready_audit_gated_by_pending_item() {
    // audit(다른 task 의존)는 덩어리에 검수전 항목 남으면 not-ready (#6 게이트).
    let ns = nodes(vec![
        json!({ "id": "chunk", "kind": "chunk", "parentId": null, "status": "todo" }),
        json!({ "id": "g0", "kind": "group", "parentId": "chunk", "status": "todo" }),
        json!({ "id": "i1", "kind": "item", "parentId": "g0", "badge": "o", "blockedBy": [], "status": "todo" }),
        json!({ "id": "hunt", "kind": "task", "parentId": "chunk", "blockedBy": ["i1"], "status": "done" }),
        json!({ "id": "add0", "kind": "item", "parentId": "chunk", "badge": "검수전", "blockedBy": [], "status": "todo" }),
        json!({ "id": "audit", "kind": "task", "parentId": "chunk", "blockedBy": ["i1", "hunt"], "status": "todo" }),
    ]);
    assert_eq!(sorted_ids(&pick_ready(&ns)), vec!["add0"]);
}

#[test]
fn pick_ready_audit_ready_when_no_pending() {
    let ns = nodes(vec![
        json!({ "id": "chunk", "kind": "chunk", "parentId": null, "status": "todo" }),
        json!({ "id": "i1", "kind": "item", "parentId": "chunk", "badge": "o", "blockedBy": [], "status": "todo" }),
        json!({ "id": "hunt", "kind": "task", "parentId": "chunk", "blockedBy": ["i1"], "status": "done" }),
        json!({ "id": "add0", "kind": "item", "parentId": "chunk", "badge": "x", "blockedBy": [], "status": "todo" }),
        json!({ "id": "audit", "kind": "task", "parentId": "chunk", "blockedBy": ["i1", "hunt"], "status": "todo" }),
    ]);
    assert_eq!(ids(&pick_ready(&ns)), vec!["audit"]);
}

// ── buildLedger ────────────────────────────────────────────────────────────
#[test]
fn build_ledger_flat_descendants_items() {
    let ns = nodes(vec![
        json!({ "id": "chunk", "kind": "chunk", "parentId": null }),
        json!({ "id": "i1", "kind": "item", "parentId": "chunk", "title": "재고 차감", "description": "수량 확정 시 재고를 원자적으로 차감한다", "badge": "o", "category": "재고 관리" }),
        json!({ "id": "i2", "kind": "item", "parentId": "chunk", "title": "창고 연결", "badge": "검수전" }),
        json!({ "id": "other", "kind": "item", "parentId": "other-chunk", "title": "남의 항목", "badge": "o" }),
        json!({ "id": "gen", "kind": "task", "parentId": "chunk" }),
    ]);
    let ledger = build_ledger(&ns, "chunk", "item");
    assert_eq!(ledger.len(), 2);
    assert_eq!(ledger[0], json!({ "id": "i1", "title": "재고 차감", "description": "수량 확정 시 재고를 원자적으로 차감한다", "badge": "o", "category": "재고 관리" }));
    assert_eq!(ledger[1], json!({ "id": "i2", "title": "창고 연결", "description": null, "badge": "검수전", "category": null }));
}

// ── execResultToEdit ────────────────────────────────────────────────────────
#[test]
fn exec_result_to_edit_valid_oxf() {
    assert_eq!(
        exec_result_to_edit(&json!({ "oxf": "o", "result": { "reason": "실재" } })),
        json!({ "badge": "o", "result": json!({ "reason": "실재" }).to_string() })
    );
    assert_eq!(exec_result_to_edit(&json!({ "oxf": "f", "result": "치명" })), json!({ "badge": "f", "result": "치명" }));
}

#[test]
fn exec_result_to_edit_no_oxf() {
    let e = exec_result_to_edit(&json!({ "oxf": null, "result": { "items": [1, 2] } }));
    assert!(e.get("badge").is_none());
    assert_eq!(e["result"], json!({ "items": [1, 2] }).to_string());
}

// ── buildAddParams ──────────────────────────────────────────────────────────
#[test]
fn build_add_params_item_body_is_exec_input() {
    let ev = json!({ "id": "i1", "kind": "item", "title": "재고 차감", "description": "주문 시 차감", "prompt": "verify…", "schema": { "type": "object" }, "badge": "검수전" });
    let p = build_add_params(&ev, Some("k-1"), &[], None, &HashMap::new());
    assert_eq!(p["title"], "재고 차감");
    assert_eq!(p["parentId"], "k-1");
    assert_eq!(p["kind"], "item");
    assert_eq!(p["badge"], "검수전");
    assert_eq!(p["description"], "주문 시 차감");
    let body: Value = serde_json::from_str(p["body"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({ "prompt": "verify…", "schema": { "type": "object" } }));
    assert_eq!(p["locked"], true);
}

#[test]
fn build_add_params_group_empty_body() {
    let ev = json!({ "id": "g0", "kind": "group", "title": "재고", "category": "재고" });
    let p = build_add_params(&ev, Some("chunk-7"), &[], None, &HashMap::new());
    assert_eq!(p["kind"], "group");
    assert_eq!(p["body"], "");
    assert!(p.get("description").is_none());
    assert!(p.get("badge").is_none());
    assert!(p.get("isDraft").is_none());
}

#[test]
fn build_add_params_task_embeds_skeleton() {
    let ev = json!({ "id": "hunt", "kind": "task", "title": "Hunt", "stage": "hunt" });
    let ctx = json!({ "skeleton": { "program": { "type": "Program" } }, "directive": "약국 SaaS" });
    let p = build_add_params(&ev, Some("k-chunk"), &[], Some(&ctx), &HashMap::new());
    assert_eq!(p["kind"], "task");
    let body: Value = serde_json::from_str(p["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["skeleton"], json!({ "program": { "type": "Program" } }));
    assert_eq!(body["stage"], "hunt");
    assert_eq!(body["args"]["directive"], "약국 SaaS");
    assert_eq!(body["args"]["chunkRef"], "k-chunk");
    assert!(p.get("badge").is_none());
}

#[test]
fn build_add_params_task_no_ctx_stage_only() {
    let ev = json!({ "id": "hunt", "kind": "task", "stage": "hunt" });
    let p = build_add_params(&ev, Some("k1"), &[], None, &HashMap::new());
    let body: Value = serde_json::from_str(p["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["stage"], "hunt");
    assert!(body.get("skeleton").is_none());
}

// ── genSkeletonArgs ─────────────────────────────────────────────────────────
#[test]
fn gen_skeleton_args_idea_only() {
    assert_eq!(
        gen_skeleton_args(Some("약국 SaaS"), None, None, None, None).unwrap(),
        vec!["generate-skeleton", "--idea", "약국 SaaS", "--lang", "ko"]
    );
}

#[test]
fn gen_skeleton_args_full() {
    assert_eq!(
        gen_skeleton_args(Some("novel"), Some("glm-5.2"), Some("/cc/references"), Some("/o/gen.js"), Some("en")).unwrap(),
        vec!["generate-skeleton", "--idea", "novel", "--lang", "en", "--model", "glm-5.2", "--refs", "/cc/references", "--gen-out", "/o/gen.js"]
    );
}

#[test]
fn gen_skeleton_args_idea_required() {
    let e = gen_skeleton_args(None, Some("x"), None, None, None).unwrap_err();
    assert!(e.contains("idea 필수"));
}

// ── buildSecretEnvMap ───────────────────────────────────────────────────────
#[test]
fn build_secret_env_map_env_prefix_only() {
    let m = build_secret_env_map(&[
        "env:ANTHROPIC_BASE_URL".into(),
        "env:ANTHROPIC_AUTH_TOKEN".into(),
        "other".into(),
        "env:".into(),
    ]);
    let mut expected = HashMap::new();
    expected.insert("ANTHROPIC_BASE_URL".to_string(), "env:ANTHROPIC_BASE_URL".to_string());
    expected.insert("ANTHROPIC_AUTH_TOKEN".to_string(), "env:ANTHROPIC_AUTH_TOKEN".to_string());
    assert_eq!(m, expected);
    assert!(build_secret_env_map(&[]).is_empty());
}

// ── buildSpawnCmd ───────────────────────────────────────────────────────────
#[test]
fn build_spawn_cmd_bin_vs_default() {
    assert_eq!(
        build_spawn_cmd(Some("/x/bin/wf"), vec!["exec-one".into()]),
        ("/x/bin/wf".to_string(), vec!["exec-one".to_string()])
    );
    assert_eq!(
        build_spawn_cmd(None, vec!["exec-one".into(), "--lang".into(), "ko".into()]),
        ("sidecar:workflow".to_string(), vec!["exec-one".to_string(), "--lang".to_string(), "ko".to_string()])
    );
}

// ── resolveDirective ────────────────────────────────────────────────────────
#[test]
fn resolve_directive_priority() {
    let doc = json!({ "spec": "workflow-doc@0.0.1", "args": { "directive": { "default": "정련본" } } });
    assert_eq!(resolve_directive(Some("명시"), Some(&doc), Some("raw")).as_deref(), Some("명시"));
    assert_eq!(resolve_directive(None, Some(&doc), Some("raw")).as_deref(), Some("정련본"));
    assert_eq!(resolve_directive(Some(""), Some(&doc), Some("raw")).as_deref(), Some("정련본"));
    let non_doc = json!({ "program": {} });
    assert_eq!(resolve_directive(None, Some(&non_doc), Some("raw")).as_deref(), Some("raw"));
    assert_eq!(resolve_directive(None, None, Some("raw")).as_deref(), Some("raw"));
    let empty_default = json!({ "spec": "workflow-doc@0.0.1", "args": { "directive": { "default": "" } } });
    assert_eq!(resolve_directive(None, Some(&empty_default), Some("raw")).as_deref(), Some("raw"));
}

// ── leaseActive ─────────────────────────────────────────────────────────────
#[test]
fn lease_active_expiry() {
    let mut st = ReconcileState::default();
    assert!(!lease_active(&mut st, "n1", 100), "미설정 lease 는 비활성");
    st.leases.insert("n1".into(), 200);
    assert!(lease_active(&mut st, "n1", 100), "만료 전 활성");
    assert!(!lease_active(&mut st, "n1", 200), "만료 시각 도달 = 비활성 + 삭제");
    assert!(!st.leases.contains_key("n1"), "만료 lease 는 lazy 삭제");
}

// ── stagePublishedMarker ────────────────────────────────────────────────────
#[test]
fn stage_published_marker_variants() {
    let target = node(json!({ "id": "gen", "kind": "task", "parentId": "chunk", "blockedBy": ["i1"] }));
    // generate: 부모에 다른 task 있으면 발행됨.
    let ns = nodes(vec![
        json!({ "id": "gen", "kind": "task", "parentId": "chunk" }),
        json!({ "id": "hunt", "kind": "task", "parentId": "chunk" }),
    ]);
    assert!(stage_published_marker(&target, "{}", "generate", &ns));
    // hunt: blockedBy 밖의 item 있으면 발행됨.
    let hunt = node(json!({ "id": "hunt", "kind": "task", "parentId": "chunk", "blockedBy": ["i1"] }));
    let ns2 = nodes(vec![json!({ "id": "add0", "kind": "item", "parentId": "chunk" })]);
    assert!(stage_published_marker(&hunt, "{}", "hunt", &ns2));
    // body: file_path 일치 code(badge≠f/x) 있으면 발행됨.
    let bodyt = node(json!({ "id": "b", "kind": "task", "parentId": "chunk" }));
    let ns3 = nodes(vec![json!({ "id": "c1", "kind": "code", "parentId": "chunk", "category": "src/x.rs", "badge": "o" })]);
    assert!(stage_published_marker(&bodyt, r#"{"args":{"file_path":"src/x.rs"}}"#, "body", &ns3));
    // body: f 코드는 마커 아님(재작업 대상).
    let ns4 = nodes(vec![json!({ "id": "c1", "kind": "code", "parentId": "chunk", "category": "src/x.rs", "badge": "f" })]);
    assert!(!stage_published_marker(&bodyt, r#"{"args":{"file_path":"src/x.rs"}}"#, "body", &ns4));
}
