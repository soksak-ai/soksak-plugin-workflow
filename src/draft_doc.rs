//! draft_doc — generate stage 산출(평탄 NodeEvent 스트림)을 **id 기반 정규형 문서(DraftDoc)** 로 접고,
//! 순수 validator 로 인증한다. 목표(magical-twirling-pascal Phase 4): 공유값은 *변하는 수준에서 1회*,
//! 관계는 *id 참조*, 소비 시점(exec-one) 조립. validator 통과 못하면 발행 거부(fail-loud).
//!
//! **sha 는 넣지 않는다.** Rust sha ↔ kanban sha 불일치 위험 → 공유값(template/directive/schema)은
//! verify_contract 에 inline 1회. main.js relay 가 kanban prompt.put 으로 콘텐츠 주소화(단일 sha 원천=kanban JS).
//! 여기 규칙 6(콘텐츠 주소 정합)은 담당하지 않는다 — 규칙 1~5,7 만.
use crate::emit_host::NodeEvent;
use serde_json::Value as Json;

/// DraftDoc — generate stage 의 id 기반 정규형. 요건은 고유 필드만, 공유값은 verify_contract 1회.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DraftDoc {
    pub kind: String, // 항상 "draft-chunk"
    pub chunk_ref: String, // 기존 청크 kanban id(generate 산출이 붙는 덩어리)
    // 워크플로 return {chunkTitle} — 덩어리 title 갱신용(relay 가 chunk_ref 노드 title 에 적용). 없으면 생략.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chunk_title: Option<String>,
    pub verify_contract: VerifyContract,
    pub categories: Vec<Category>,
    pub requirements: Vec<Requirement>,
    pub tasks: Vec<Task>,
}

/// 전 요건 공유 계약 — 공유값 inline 1회(sha 아님). main.js 가 prompt.put 으로 주소화.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct VerifyContract {
    pub template: String,        // verify 프롬프트 템플릿(전역 공유)
    pub directive: String,       // 이 청크의 지시어(청크당 1회)
    pub schema: Json,            // oxf 출력 계약(전역 공유)
    pub initial_badge: String,   // 요건 최초 배지("검수전")
}

/// 의미 그룹(group 이벤트) — 순서 보존, id.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
}

/// 요건(item 이벤트) — 고유 필드만. 공유값(template/schema/directive/category 이름)은 인라인 0.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Requirement {
    pub id: String,
    pub category_id: String, // FK → Category.id
    pub title: String,
    pub description: String,
    pub origin: String, // user|agent|search
    pub badge: String,
}

/// stage 작업(task 이벤트: hunt/audit) — id + blockedBy(id 참조).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Task {
    pub id: String,
    pub stage: String,
    pub blocked_by: Vec<String>,
}

/// build — 평탄 NodeEvent 스트림 → DraftDoc(정규형).
/// 방어적: register_prompts 없거나(구 계약) 필드 순서 달라도 견고하게 접는다.
/// - verify_contract: 첫 group 의 register_prompts{verify,directive}(+schema) → template/directive. schema 는
///   register_prompts.schema 우선, 없으면 첫 item 의 inline schema(구 계약 fixture) 폴백. initial_badge = 첫 item badge.
/// - categories: group 이벤트(순서 보존).
/// - requirements: item 이벤트(고유 필드만; category_id = item.parent).
/// - tasks: task 이벤트(hunt/audit; stage + blocked_by).
/// - chunk_ref: group 의 parent(= 기존 덩어리 id). group 없으면 item 조상 사슬로 유추, 그것도 없으면 "chunk".
pub fn build(events: &[NodeEvent]) -> Result<DraftDoc, String> {
    let mut categories: Vec<Category> = vec![];
    let mut requirements: Vec<Requirement> = vec![];
    let mut tasks: Vec<Task> = vec![];

    // verify_contract 재료 — 첫 group 의 register_prompts + 첫 item 폴백.
    let mut template: Option<String> = None;
    let mut directive: Option<String> = None;
    let mut schema: Option<Json> = None;
    let mut initial_badge: Option<String> = None;
    let mut item_schema_fallback: Option<Json> = None;

    // chunk_ref 유추 재료: group id → parent, item id → parent.
    let mut group_parents: std::collections::BTreeMap<String, Option<String>> = std::collections::BTreeMap::new();

    for ev in events {
        let NodeEvent::Add {
            id,
            parent,
            kind,
            title,
            description,
            origin,
            badge,
            register_prompts,
            schema: ev_schema,
            stage,
            blocked_by,
            ..
        } = ev;
        match kind.as_str() {
            "group" => {
                group_parents.insert(id.clone(), parent.clone());
                categories.push(Category { id: id.clone(), name: title.clone() });
                // 첫 group 에 register_prompts 로 공유값 등록(gen.js: 첫 그룹에만 얹음).
                if let Some(Json::Object(m)) = register_prompts {
                    if template.is_none() {
                        if let Some(Json::String(t)) = m.get("verify") {
                            template = Some(t.clone());
                        }
                    }
                    if directive.is_none() {
                        if let Some(Json::String(d)) = m.get("directive") {
                            directive = Some(d.clone());
                        }
                    }
                    if schema.is_none() {
                        if let Some(s) = m.get("schema") {
                            if s.is_object() {
                                schema = Some(s.clone());
                            }
                        }
                    }
                }
            }
            "item" => {
                let cat = parent.clone().unwrap_or_default();
                if initial_badge.is_none() {
                    initial_badge = badge.clone();
                }
                if item_schema_fallback.is_none() {
                    if let Some(s) = ev_schema {
                        if s.is_object() {
                            item_schema_fallback = Some(s.clone());
                        }
                    }
                }
                requirements.push(Requirement {
                    id: id.clone(),
                    category_id: cat,
                    title: title.clone(),
                    description: description.clone(),
                    origin: origin.clone().unwrap_or_default(),
                    badge: badge.clone().unwrap_or_default(),
                });
            }
            "task" => {
                tasks.push(Task {
                    id: id.clone(),
                    stage: stage.clone().unwrap_or_default(),
                    blocked_by: blocked_by.clone(),
                });
            }
            // chunk/phase/agent 등은 generate 정규형에 편입 안 함(방어적으로 무시).
            _ => {}
        }
    }

    // chunk_ref: 첫 group 의 parent(= 덩어리 id). group 없으면 첫 item 의 조상(item.parent 의 group parent),
    // 그것도 없으면 "chunk"(gen.js 기본 CHUNK_REF).
    let chunk_ref = categories
        .first()
        .and_then(|c| group_parents.get(&c.id).cloned().flatten())
        .or_else(|| {
            // group 없이 item 만(hunt 추가항목 등): item.parent 가 곧 덩어리일 수 있음.
            requirements.first().map(|r| r.category_id.clone()).filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "chunk".to_string());

    let verify_contract = VerifyContract {
        template: template.unwrap_or_default(),
        directive: directive.unwrap_or_default(),
        // schema: register_prompts.schema 우선, 없으면 item inline schema(구 계약), 그것도 없으면 null.
        schema: schema.or(item_schema_fallback).unwrap_or(Json::Null),
        initial_badge: initial_badge.unwrap_or_else(|| "검수전".to_string()),
    };

    Ok(DraftDoc {
        kind: "draft-chunk".to_string(),
        chunk_ref,
        chunk_title: None, // main.rs 가 워크플로 return {chunkTitle} 로 채운다.
        verify_contract,
        categories,
        requirements,
        tasks,
    })
}

/// validate — DraftDoc 인증(플랜 규칙 1~5,7 — 규칙 6 sha 정합은 kanban 담당). 위반 목록 반환.
/// 통과(빈 위반) 못하면 발행 거부(fail-loud). 규칙:
///   ① id 유일 — categories ∪ requirements ∪ tasks 전 id 유일.
///   ② FK — requirement.category_id ∈ categories · task.blocked_by ∈ requirements ∪ tasks.
///   ③ 완결 — 요건마다 title·description 비지 않음 · origin ∈ {user,agent,search}.
///   ④ 정규화 불변 — 요건에 schema/directive/template/category 이름 인라인 0(고유 필드만; 구조로 보장).
///   ⑤ 트리 — hunt.blocked_by = 전 요건 id 집합 · audit.blocked_by = 전 요건 ∪ {hunt}.
///   ⑦ 비어있지 않음 — categories ≥ 1 ∧ requirements ≥ 1.
pub fn validate(doc: &DraftDoc) -> Result<(), Vec<String>> {
    let mut v: Vec<String> = vec![];

    // ⑦ 비어있지 않음 — categories ≥ 1 ∧ requirements ≥ 1.
    if doc.categories.is_empty() {
        v.push("[⑦] categories 비어있음(≥1 필요)".to_string());
    }
    if doc.requirements.is_empty() {
        v.push("[⑦] requirements 비어있음(≥1 필요)".to_string());
    }

    // ① id 유일 — categories ∪ requirements ∪ tasks.
    let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    let all_ids = doc
        .categories
        .iter()
        .map(|c| c.id.as_str())
        .chain(doc.requirements.iter().map(|r| r.id.as_str()))
        .chain(doc.tasks.iter().map(|t| t.id.as_str()));
    for id in all_ids {
        if !seen.insert(id) {
            v.push(format!("[①] id 중복: {id:?}"));
        }
    }

    // ② FK — requirement.category_id ∈ categories.
    let cat_ids: std::collections::BTreeSet<&str> = doc.categories.iter().map(|c| c.id.as_str()).collect();
    for r in &doc.requirements {
        if !cat_ids.contains(r.category_id.as_str()) {
            v.push(format!("[②] requirement {:?} category_id {:?} 미존재(FK 위반)", r.id, r.category_id));
        }
    }
    // ② FK — task.blocked_by ∈ requirements ∪ tasks.
    let ref_targets: std::collections::BTreeSet<&str> = doc
        .requirements
        .iter()
        .map(|r| r.id.as_str())
        .chain(doc.tasks.iter().map(|t| t.id.as_str()))
        .collect();
    for t in &doc.tasks {
        for b in &t.blocked_by {
            if !ref_targets.contains(b.as_str()) {
                v.push(format!("[②] task {:?} blocked_by {:?} 미존재(FK 위반)", t.id, b));
            }
        }
    }

    // ③ 완결 — 요건마다 title·description 비지 않음 · origin ∈ {user,agent,search}.
    const ORIGINS: [&str; 3] = ["user", "agent", "search"];
    for r in &doc.requirements {
        if r.title.trim().is_empty() {
            v.push(format!("[③] requirement {:?} title 비어있음", r.id));
        }
        if r.description.trim().is_empty() {
            v.push(format!("[③] requirement {:?} description 비어있음", r.id));
        }
        if !ORIGINS.contains(&r.origin.as_str()) {
            v.push(format!("[③] requirement {:?} origin {:?} ∉ {{user,agent,search}}", r.id, r.origin));
        }
    }

    // ⑤ 트리 — hunt.blocked_by = 전 요건 id 집합 · audit.blocked_by = 전 요건 ∪ {hunt}.
    // hunt/audit 이 존재할 때만 검사(hunt-단독 재실행 등 부분 문서는 tasks 가 없을 수 있음).
    let req_ids: std::collections::BTreeSet<&str> = doc.requirements.iter().map(|r| r.id.as_str()).collect();
    if let Some(hunt) = doc.tasks.iter().find(|t| t.stage == "hunt") {
        let hb: std::collections::BTreeSet<&str> = hunt.blocked_by.iter().map(|s| s.as_str()).collect();
        if hb != req_ids {
            v.push("[⑤] hunt.blocked_by ≠ 전 요건 id 집합".to_string());
        }
    }
    if let Some(audit) = doc.tasks.iter().find(|t| t.stage == "audit") {
        let has_hunt = doc.tasks.iter().any(|t| t.stage == "hunt");
        let ab: std::collections::BTreeSet<&str> = audit.blocked_by.iter().map(|s| s.as_str()).collect();
        // 기대 = 전 요건 ∪ {hunt task id}(hunt 존재 시).
        let mut expected: std::collections::BTreeSet<&str> = req_ids.clone();
        let hunt_id = doc.tasks.iter().find(|t| t.stage == "hunt").map(|t| t.id.as_str());
        if let Some(hid) = hunt_id {
            expected.insert(hid);
        }
        if !has_hunt {
            v.push("[⑤] audit 존재하나 hunt task 부재(감사는 hunt 후행)".to_string());
        } else if ab != expected {
            v.push("[⑤] audit.blocked_by ≠ 전 요건 ∪ {hunt}".to_string());
        }
    }

    // 규칙 ④(정규화 불변)는 Requirement 구조 자체가 고유 필드만 갖게 강제 — 인라인 슬롯이 없다.
    // (schema/directive/template/category 이름 필드가 struct 에 존재하지 않음 → 구조로 보장.)

    if v.is_empty() {
        Ok(())
    } else {
        Err(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// group Add 이벤트(register_prompts 옵션).
    fn group_ev(id: &str, parent: &str, name: &str, register: Option<Json>) -> NodeEvent {
        NodeEvent::Add {
            id: id.into(),
            parent: Some(parent.into()),
            kind: "group".into(),
            title: name.into(),
            description: String::new(),
            prompt: String::new(),
            stage: None,
            schema: None,
            category: Some(name.into()),
            origin: None,
            prompt_role: None,
            vars: None,
            register_prompts: register,
            var_refs: None,
            schema_ref: None,
            blocked_by: vec![],
            badge: None,
            is_draft: false,
            parent_draft_id: None,
        }
    }
    /// item Add 이벤트(정규화: prompt '' + schema inline 폴백).
    fn item_ev(id: &str, parent: &str, title: &str, desc: &str, origin: &str, badge: &str, schema: Option<Json>) -> NodeEvent {
        NodeEvent::Add {
            id: id.into(),
            parent: Some(parent.into()),
            kind: "item".into(),
            title: title.into(),
            description: desc.into(),
            prompt: String::new(),
            stage: None,
            schema,
            category: None,
            origin: Some(origin.into()),
            prompt_role: Some("verify".into()),
            vars: Some(json!({ "title": title })),
            register_prompts: None,
            var_refs: Some(json!({ "directive": "directive" })),
            schema_ref: None,
            blocked_by: vec![],
            badge: Some(badge.into()),
            is_draft: false,
            parent_draft_id: None,
        }
    }
    /// task Add 이벤트(hunt/audit).
    fn task_ev(id: &str, parent: &str, stage: &str, blocked_by: &[&str]) -> NodeEvent {
        NodeEvent::Add {
            id: id.into(),
            parent: Some(parent.into()),
            kind: "task".into(),
            title: stage.into(),
            description: String::new(),
            prompt: String::new(),
            stage: Some(stage.into()),
            schema: None,
            category: None,
            origin: None,
            prompt_role: None,
            vars: None,
            register_prompts: None,
            var_refs: None,
            schema_ref: None,
            blocked_by: blocked_by.iter().map(|s| s.to_string()).collect(),
            badge: None,
            is_draft: false,
            parent_draft_id: None,
        }
    }
    fn schema_json() -> Json {
        json!({ "type": "object", "required": ["oxf", "origin"], "properties": { "oxf": { "type": "string" } } })
    }

    /// 정상 generate 이벤트 스트림(register_prompts 로 공유값 등록) → 합성.
    fn good_events() -> Vec<NodeEvent> {
        let register = json!({ "verify": "VERIFY_TMPL {{title}} {{directive}}", "directive": "약국 SaaS 지시어", "schema": schema_json() });
        vec![
            group_ev("g0", "chunk", "재고", Some(register)),
            item_ev("g0i0", "g0", "재고 차감", "판매 시 차감", "user", "검수전", Some(schema_json())),
            item_ev("g0i1", "g0", "유통기한 경고", "만료 임박 알림", "agent", "검수전", Some(schema_json())),
            task_ev("hunt", "chunk", "hunt", &["g0i0", "g0i1"]),
            task_ev("audit", "chunk", "audit", &["g0i0", "g0i1", "hunt"]),
        ]
    }

    #[test]
    fn build_folds_flat_events_into_normalized_doc() {
        let doc = build(&good_events()).unwrap();
        assert_eq!(doc.kind, "draft-chunk");
        assert_eq!(doc.chunk_ref, "chunk", "chunk_ref = 첫 group 의 parent(덩어리 id)");
        assert_eq!(doc.categories.len(), 1);
        assert_eq!(doc.categories[0].id, "g0");
        assert_eq!(doc.categories[0].name, "재고");
        assert_eq!(doc.requirements.len(), 2);
        assert_eq!(doc.requirements[0].id, "g0i0");
        assert_eq!(doc.requirements[0].category_id, "g0", "요건 category_id = item.parent(group)");
        assert_eq!(doc.requirements[0].origin, "user");
        assert_eq!(doc.tasks.len(), 2);
    }

    #[test]
    fn build_extracts_verify_contract_from_register_prompts() {
        let doc = build(&good_events()).unwrap();
        assert_eq!(doc.verify_contract.template, "VERIFY_TMPL {{title}} {{directive}}");
        assert_eq!(doc.verify_contract.directive, "약국 SaaS 지시어");
        assert_eq!(doc.verify_contract.schema, schema_json(), "schema = register_prompts.schema");
        assert_eq!(doc.verify_contract.initial_badge, "검수전");
    }

    #[test]
    fn build_falls_back_to_item_inline_schema_when_register_lacks_schema() {
        // 구 계약 fixture: register_prompts 에 schema 없고 item 이 inline schema 보유 → 폴백.
        let register = json!({ "verify": "T {{title}}", "directive": "D" });
        let events = vec![
            group_ev("g0", "chunk", "재고", Some(register)),
            item_ev("g0i0", "g0", "요건", "설명", "user", "검수전", Some(schema_json())),
        ];
        let doc = build(&events).unwrap();
        assert_eq!(doc.verify_contract.schema, schema_json(), "register.schema 부재 시 item inline schema 폴백");
    }

    #[test]
    fn build_defensive_no_register_prompts() {
        // register_prompts 전무(방어적) — 견고하게 접되 template/directive 는 빈 문자열.
        let events = vec![
            group_ev("g0", "chunk", "재고", None),
            item_ev("g0i0", "g0", "요건", "설명", "user", "검수전", None),
        ];
        let doc = build(&events).unwrap();
        assert_eq!(doc.verify_contract.template, "");
        assert_eq!(doc.verify_contract.directive, "");
        assert_eq!(doc.verify_contract.schema, Json::Null);
        assert_eq!(doc.categories.len(), 1);
        assert_eq!(doc.requirements.len(), 1);
    }

    #[test]
    fn build_requirement_has_only_unique_fields_no_inline_shared() {
        // 정규화 불변(④): 요건은 고유 필드만 — Requirement struct 에 schema/directive/template/category 이름 슬롯이 없다.
        let doc = build(&good_events()).unwrap();
        let r0 = serde_json::to_value(&doc.requirements[0]).unwrap();
        let obj = r0.as_object().unwrap();
        for k in ["schema", "directive", "template", "prompt", "category", "name"] {
            assert!(!obj.contains_key(k), "요건에 공유값 인라인 슬롯 {k:?} 있음(정규화 위반)");
        }
        assert!(obj.contains_key("category_id"), "요건은 categoryId FK 만 보유");
    }

    #[test]
    fn validate_accepts_good_doc() {
        let doc = build(&good_events()).unwrap();
        assert_eq!(validate(&doc), Ok(()), "정상 문서는 통과");
    }

    // ── 규칙별 위반 fixture (RED→GREEN) ──

    #[test]
    fn validate_rule1_rejects_duplicate_id() {
        let mut doc = build(&good_events()).unwrap();
        doc.requirements[1].id = "g0i0".to_string(); // 중복
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[①]")), "id 중복 위반 검출: {errs:?}");
    }

    #[test]
    fn validate_rule2_rejects_dangling_category_fk() {
        let mut doc = build(&good_events()).unwrap();
        doc.requirements[0].category_id = "gX".to_string(); // 미존재 카테고리
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[②]") && e.contains("category_id")), "category FK 위반: {errs:?}");
    }

    #[test]
    fn validate_rule2_rejects_dangling_blocked_by() {
        let mut doc = build(&good_events()).unwrap();
        doc.tasks[0].blocked_by = vec!["nope".to_string()]; // 미존재 참조
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[②]") && e.contains("blocked_by")), "blocked_by FK 위반: {errs:?}");
    }

    #[test]
    fn validate_rule3_rejects_empty_title_or_description() {
        let mut doc = build(&good_events()).unwrap();
        doc.requirements[0].title = "".to_string();
        doc.requirements[1].description = "  ".to_string();
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[③]") && e.contains("title")), "빈 title 검출: {errs:?}");
        assert!(errs.iter().any(|e| e.contains("[③]") && e.contains("description")), "빈 description 검출: {errs:?}");
    }

    #[test]
    fn validate_rule3_rejects_bad_origin() {
        let mut doc = build(&good_events()).unwrap();
        doc.requirements[0].origin = "made-up".to_string();
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[③]") && e.contains("origin")), "origin enum 위반: {errs:?}");
    }

    #[test]
    fn validate_rule5_rejects_wrong_hunt_blocked_by() {
        let mut doc = build(&good_events()).unwrap();
        // hunt 이 전 요건이 아닌 일부만 blockedBy — 트리 무결성 위반.
        doc.tasks.iter_mut().find(|t| t.stage == "hunt").unwrap().blocked_by = vec!["g0i0".to_string()];
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[⑤]") && e.contains("hunt")), "hunt 트리 위반: {errs:?}");
    }

    #[test]
    fn validate_rule5_rejects_wrong_audit_blocked_by() {
        let mut doc = build(&good_events()).unwrap();
        // audit 이 hunt 를 빠뜨림.
        doc.tasks.iter_mut().find(|t| t.stage == "audit").unwrap().blocked_by =
            vec!["g0i0".to_string(), "g0i1".to_string()];
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[⑤]") && e.contains("audit")), "audit 트리 위반: {errs:?}");
    }

    #[test]
    fn validate_rule7_rejects_empty_categories_or_requirements() {
        let mut doc = build(&good_events()).unwrap();
        doc.categories.clear();
        doc.requirements.clear();
        doc.tasks.clear();
        let errs = validate(&doc).unwrap_err();
        assert!(errs.iter().any(|e| e.contains("[⑦]") && e.contains("categories")), "빈 categories: {errs:?}");
        assert!(errs.iter().any(|e| e.contains("[⑦]") && e.contains("requirements")), "빈 requirements: {errs:?}");
    }

    #[test]
    fn draft_doc_round_trips_json() {
        // serde round-trip — main.js 미러가 파싱할 wire 형태 안정성.
        let doc = build(&good_events()).unwrap();
        let s = serde_json::to_string(&doc).unwrap();
        let back: DraftDoc = serde_json::from_str(&s).unwrap();
        assert_eq!(doc, back);
    }

    #[test]
    fn chunk_title_serializes_only_when_set() {
        let mut doc = build(&good_events()).unwrap();
        let s0 = serde_json::to_string(&doc).unwrap();
        assert!(!s0.contains("chunk_title"), "미설정 시 chunk_title 생략(군더더기 0)");
        doc.chunk_title = Some("약국 재고 SaaS".to_string());
        let s1 = serde_json::to_string(&doc).unwrap();
        assert!(s1.contains("\"chunk_title\":\"약국 재고 SaaS\""), "설정 시 직렬화");
        let back: DraftDoc = serde_json::from_str(&s1).unwrap();
        assert_eq!(back.chunk_title.as_deref(), Some("약국 재고 SaaS"));
    }

    /// [통합] 실측 fixture program(generate stage)을 ClaudeEmitHost(stub runner)로 돌린 이벤트 →
    /// build → validate 가 정규형 인증까지 통과하는지. LLM·앱 없이 Rust Interp 만으로.
    #[test]
    fn build_and_validate_from_fixture_generate_events() {
        use crate::emit_host::ClaudeEmitHost;
        use crate::interp::{Interp, Val};
        use std::cell::RefCell;
        use std::collections::BTreeMap;
        use std::rc::Rc;
        let skeleton: Json =
            serde_json::from_str(include_str!("../fixtures/gen.pharmacy.skeleton.json")).unwrap();
        let program = skeleton.get("program").expect("program(완전 AST)");
        // stub runner: GENERATOR 프롬프트 → 1그룹 2항목 트리 반환(다른 프롬프트는 빈 문자열).
        let val_obj = |pairs: Vec<(&str, Val)>| -> Val {
            let mut m = BTreeMap::new();
            for (k, v) in pairs {
                m.insert(k.to_string(), v);
            }
            Val::Obj(Rc::new(RefCell::new(m)))
        };
        let val_arr = |vs: Vec<Val>| -> Val { Val::Arr(Rc::new(RefCell::new(vs))) };
        let item = |t: &str, d: &str, o: &str| {
            val_obj(vec![
                ("title", Val::Str(t.into())),
                ("description", Val::Str(d.into())),
                ("origin", Val::Str(o.into())),
            ])
        };
        let mut h = ClaudeEmitHost::new(move |p: &str, _o: &BTreeMap<String, Val>| {
            if p.contains("GENERATOR") {
                let grp = val_obj(vec![
                    ("category", Val::Str("재고".into())),
                    ("items", val_arr(vec![item("항목1", "설명1", "user"), item("항목2", "설명2", "agent")])),
                ]);
                Ok(val_obj(vec![
                    ("title", Val::Str("테스트 덩어리".into())),
                    ("titleOrigin", Val::Str("agent".into())),
                    ("groups", val_arr(vec![grp])),
                ]))
            } else {
                Ok(Val::Str(String::new()))
            }
        });
        let args = json!({ "stage": "generate", "directive": "테스트 지시", "chunkRef": "chunk" });
        Interp::new(&mut h).run(program, args).expect("generate interp 해석");

        let doc = build(&h.wh.events).expect("build");
        assert_eq!(doc.chunk_ref, "chunk", "chunk_ref = CHUNK_REF");
        assert_eq!(doc.categories.len(), 1);
        assert_eq!(doc.requirements.len(), 2);
        assert_eq!(doc.tasks.len(), 2, "hunt+audit");
        // verify_contract: fixture 는 register_prompts.schema 없음(구 계약) → item inline schema 폴백이 채움.
        assert!(doc.verify_contract.schema.is_object(), "schema 폴백(item inline)으로 채워짐");
        assert!(!doc.verify_contract.template.is_empty(), "verify 템플릿 등록됨");
        assert!(!doc.verify_contract.directive.is_empty(), "directive 등록됨");
        // validate 통과 — 정규형 인증.
        assert_eq!(validate(&doc), Ok(()), "fixture generate 산출은 정규형 검증 통과");
    }
}
