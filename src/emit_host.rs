//! emit_host — 발행 Host 구현: interp 의 agent/parallel/pipeline 을 칸반 노드 *발행*으로 매핑.
//!
//! 규칙(rule_workflow_pipeline_node_model) 준수:
//! - 규칙 A: 노드는 작업이다. parallel/pipeline 은 **노드가 아니다** — 관계다.
//!   - agent     → 단일 작업 노드 1개.
//!   - parallel  → 자식들을 형제로(동시 = blockedBy 없음). parallel 자체 노드 X.
//!   - pipeline  → 자식들을 blockedBy 체인으로(순차). pipeline 자체 노드 X.
//!   - phase     → 의미있는 컨테이너 노드(순차 게이트). 의미있는 title.
//!   group_enter/group_exit 는 *노드를 발행하지 않는다* — parallel/pipeline 스코프만 추적해
//!   blockedBy(형제 vs 체인)를 가른다(parallel-in-pipeline 도 형제로 보존). 컨테이너 노드는 phase 만.
//! - 규칙 B: 모든 노드 title = opts.title(LLM 발명), body = opts.description. label fallback 폐기.
//! - 규칙 C: 실행 안 함(발행만). agent 는 트리거를 일으키지 않는다 — exec 없음. 검증 전 노드는 badge="검수전".
//!   스케줄러(코어)가 칸반 상태를 보고 ready 노드를 별도로 실행(soksak-workflow --exec-one)한다.
use crate::host::stub_from_schema;
use crate::interp::{to_string, Host, Val};
use serde_json::Value as Json;
use std::collections::BTreeMap;

/// 발행되는 칸반 노드 이벤트(→ JSON line → main.js → soksak-plugin-kanban node.add).
/// 발행 전용: Add 만(실행 lifecycle status 없음 — 실행은 스케줄러+exec-one 의 몫).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "ev", rename_all = "lowercase")]
pub enum NodeEvent {
    Add {
        id: String,
        parent: Option<String>,
        // node kind — parallel/pipeline 은 노드 아님(규칙 A). 컨테이너="phase". 작업=opts.kind 통과:
        // draft 모델 B → "chunk"(덩어리·isDraft) | "group"(기능분류) | "item"(요건·badge) | "task"(Generate/Hunt/Audit).
        // 미지정 시 "agent"(일반 워크플로). main.js 가 kind 로 발행/실행 처리를 가른다.
        kind: String,
        title: String,
        description: String, // 규칙 B: 요건 설명(사람용, 칸반 description 필드). exec 입력 아님 — body 와 별개 축.
        #[serde(skip_serializing_if = "String::is_empty")]
        prompt: String, // agent 프롬프트(verifyPrompt 등). 정규화 item·task 는 빈 문자열 → 직렬화 생략(군더더기 0).
        // task 노드(generate/hunt/audit) 의 stage — opts.stage 통로. main.js relay 가 stage 필드로 exec-stage body 임베드.
        // 일반/항목/그룹 노드는 없음(생략). task 노드 prompt 는 비운다 — stage 가 별도 축.
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<Json>, // 구조화 출력 계약(exec-one 용). 없으면 raw 텍스트 agent.
        #[serde(skip_serializing_if = "Option::is_none")]
        category: Option<String>, // 의미 그룹 차원 라벨(group 노드 분류·item 의 소속). draft category 사후 군집.
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<String>, // 요건 출처(user/agent/search) — 규칙 D 출처 추적의 본질 메타. GEN it.origin → verify 갱신.
        // ── 프롬프트 정규화(콘텐츠 주소화) 통로 — Rust 는 해시 모름, 텍스트/role 만 relay. main.js 가 sha256·치환.
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt_role: Option<String>, // item: 논리 role(verify/hunt/audit). main.js relay 가 role→promptHash 치환.
        #[serde(skip_serializing_if = "Option::is_none")]
        vars: Option<Json>, // item: {{key}} 바인딩 변수({category,title,description,directive}). 소비 시점 조립.
        #[serde(skip_serializing_if = "Option::is_none")]
        register_prompts: Option<Json>, // chunk/stage 1회: {role: 템플릿텍스트}. main.js 가 prompt.put(sha256 dedup).
        #[serde(skip_serializing_if = "Option::is_none")]
        var_refs: Option<Json>, // item: {{key}} → 등록 role 라벨. main.js 가 role→hash → node body refs. 큰 공유값(directive) 콘텐츠 주소 참조(항목마다 복붙 X).
        #[serde(skip_serializing_if = "Option::is_none")]
        schema_ref: Option<String>, // item: 출력 schema 의 등록 role 라벨. main.js 가 role→hash → schemaHash(VERIFY_SCHEMA 1행 참조, 47× 복붙 제거).
        #[serde(skip_serializing_if = "Vec::is_empty")]
        blocked_by: Vec<String>,
        // 칸반 드래프트 계약(Phase 2): 항목=badge("검수전"), 덩어리 부모=is_draft, 복제 재제출=parent_draft_id.
        // 마커는 *드래프트 노드에만* 붙는다 — 일반 노드엔 없음(보드 오염 방지). 정책은 워크플로(opts), 여긴 통로일 뿐.
        // 칸반 subValidation 이 badge 보유 자손의 oxf 를 집계 → 그룹/덩어리 감사는 칸반이 자동 계산.
        #[serde(skip_serializing_if = "Option::is_none")]
        badge: Option<String>,
        #[serde(skip_serializing_if = "is_false")]
        is_draft: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_draft_id: Option<String>,
    },
}

/// serde skip_serializing_if(bool) — false 면 직렬화 생략(일반 노드에 is_draft:false 안 새게).
fn is_false(b: &bool) -> bool {
    !*b
}

/// parallel/pipeline 스코프 — blockedBy 를 형제(parallel)/체인(pipeline)으로 가른다. 노드는 만들지 않는다.
enum GroupScope {
    Parallel,
    Pipeline { prev: Option<String> }, // 같은 item 체인의 직전 노드
}

pub struct EmitHost {
    pub events: Vec<NodeEvent>,
    emit: Option<Box<dyn FnMut(&NodeEvent)>>, // 실시간 emit(stdout JSON line) — 없으면 buffer 만.
    stack: Vec<String>,        // 컨테이너 부모(phase) — 무한뎁스. parallel/pipeline 은 안 쌓음.
    scopes: Vec<GroupScope>,   // 현재 parallel/pipeline 스코프
    prev_phase: Option<String>, // phase 순차 blockedBy
    counter: usize,
}

impl Default for EmitHost {
    fn default() -> Self {
        Self::new()
    }
}

impl EmitHost {
    pub fn new() -> Self {
        EmitHost {
            events: vec![],
            emit: None,
            stack: vec![],
            scopes: vec![],
            prev_phase: None,
            counter: 0,
        }
    }
    /// 실시간 emit 콜백 주입(stdout JSON line 등). 미주입 시 events buffer 만 채운다.
    pub fn with_emit(mut self, emit: Box<dyn FnMut(&NodeEvent)>) -> Self {
        self.emit = Some(emit);
        self
    }
    /// 노드 이벤트 발행: emit 콜백(실시간) + events buffer(검증·일괄).
    fn emit_node(&mut self, ev: NodeEvent) {
        if let Some(e) = self.emit.as_mut() {
            e(&ev);
        }
        self.events.push(ev);
    }
    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}-{}", self.counter)
    }
    fn opt_str(opts: &BTreeMap<String, Val>, key: &str) -> String {
        opts.get(key).map(to_string).unwrap_or_default()
    }
    /// 비어있지 않은 문자열 opt → Some(드래프트 마커 통로: badge/parentDraftId). 없으면 None(생략).
    fn opt_marker(opts: &BTreeMap<String, Val>, key: &str) -> Option<String> {
        match opts.get(key) {
            Some(Val::Str(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    }
    /// bool opt(isDraft 등). Val::Bool(true) 만 true.
    fn opt_bool(opts: &BTreeMap<String, Val>, key: &str) -> bool {
        matches!(opts.get(key), Some(Val::Bool(true)))
    }
    /// 문자열 배열 opt(blockedBy 등). Val::Arr → Vec<String>. 빈/미존재면 None.
    fn opt_str_array(opts: &BTreeMap<String, Val>, key: &str) -> Option<Vec<String>> {
        match opts.get(key) {
            Some(Val::Arr(a)) => {
                let v: Vec<String> = a.borrow().iter().map(to_string).filter(|s| !s.is_empty()).collect();
                if v.is_empty() {
                    None
                } else {
                    Some(v)
                }
            }
            _ => None,
        }
    }
}

impl Host for EmitHost {
    fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String> {
        // 명시적 트리(draft expand): opts.nodeId(자기 id)+opts.parent(부모 ref) 로 덩어리>그룹>항목 부모 사슬을
        // 워크플로가 직접 그린다(인터프리터 컨테이너 수술 회피). 미지정 시 자동 id + 현재 컨테이너(phase).
        let id = Self::opt_marker(opts, "nodeId").unwrap_or_else(|| self.next_id("task"));
        let parent = Self::opt_marker(opts, "parent").or_else(|| self.stack.last().cloned());
        // 규칙 B: title = opts.title(LLM 발명), description = opts.description(사람용). label fallback 없음.
        let title = Self::opt_str(opts, "title");
        let description = Self::opt_str(opts, "description");
        // blockedBy 통로: opts.blockedBy(명시적 — draft Hunt/Audit 순서: blockedBy=항목 nodeId들. main.js relay 가
        // keyOf 로 칸반 id 해석) 우선. 없으면 규칙 A pipeline 스코프(체인) / parallel·단일(형제, 없음).
        let in_pipeline = matches!(self.scopes.last(), Some(GroupScope::Pipeline { .. }));
        let blocked_by = match Self::opt_str_array(opts, "blockedBy") {
            Some(ids) => ids,
            None => match self.scopes.last() {
                Some(GroupScope::Pipeline { prev }) => prev.clone().into_iter().collect(),
                _ => vec![],
            },
        };
        let schema = opts.get("schema").map(crate::interp::val_to_json).filter(|s| s.is_object());
        // 칸반 드래프트 마커(통로): 워크플로(directive)가 항목엔 badge:"검수전", 덩어리엔 isDraft,
        // 복제엔 parentDraftId 를 opts 로 박는다. 일반 노드는 셋 다 없음 → 보드 오염 없음.
        let badge = Self::opt_marker(opts, "badge");
        let is_draft = Self::opt_bool(opts, "isDraft");
        let parent_draft_id = Self::opt_marker(opts, "parentDraftId");
        // node kind/category — draft 모델 B 가 opts 로 박는다(chunk/group/item/task + 분류 차원). 미지정=agent.
        let kind = Self::opt_marker(opts, "kind").unwrap_or_else(|| "agent".into());
        let category = Self::opt_marker(opts, "category");
        // 요건 출처(user/agent/search) — opts.origin. item 본질 메타(규칙 D 출처 추적).
        let origin = Self::opt_marker(opts, "origin");
        // task 노드 stage(generate/hunt/audit) — opts.stage. 일반/항목/그룹은 없음 → 생략.
        let stage = Self::opt_marker(opts, "stage");
        // 프롬프트 정규화 통로(콘텐츠 주소화): item 은 promptRole+vars(참조), chunk/stage 는 registerPrompts(등록).
        // Rust 는 텍스트/role 만 relay — sha256·치환은 main.js(kanban prompt.put). 완성 프롬프트를 node 에 안 박는다.
        let prompt_role = Self::opt_marker(opts, "promptRole");
        let vars = opts.get("vars").map(crate::interp::val_to_json).filter(|v| v.is_object());
        let register_prompts = opts.get("registerPrompts").map(crate::interp::val_to_json).filter(|v| v.is_object());
        let var_refs = opts.get("varRefs").map(crate::interp::val_to_json).filter(|v| v.is_object());
        let schema_ref = Self::opt_marker(opts, "schemaRef");
        self.emit_node(NodeEvent::Add {
            id: id.clone(),
            parent,
            kind,
            title,
            description,
            prompt: prompt.into(),
            schema,
            category,
            origin,
            prompt_role,
            vars,
            register_prompts,
            var_refs,
            schema_ref,
            blocked_by,
            badge,
            is_draft,
            parent_draft_id,
            stage,
        });
        // pipeline 체인 전진(같은 item 의 다음 stage 가 이 노드에 blockedBy).
        if in_pipeline {
            if let Some(GroupScope::Pipeline { prev }) = self.scopes.last_mut() {
                *prev = Some(id);
            }
        }
        // 규칙 C: 실행 안 함(발행만). interp 데이터 흐름은 schema-shaped stub 으로 잇는다(LLM 미호출).
        Ok(stub_from_schema(opts.get("schema")))
    }

    fn phase(&mut self, title: &str) {
        let id = self.next_id("phase");
        let blocked_by: Vec<String> = self.prev_phase.clone().into_iter().collect(); // 직전 phase 에 의존(순차)
        self.emit_node(NodeEvent::Add {
            id: id.clone(),
            parent: None,
            kind: "phase".into(),
            title: title.into(),
            description: String::new(),
            prompt: String::new(),
            schema: None,
            category: None,
            origin: None,
            prompt_role: None,
            vars: None,
            register_prompts: None,
            var_refs: None,
            schema_ref: None,
            blocked_by,
            // 컨테이너: 드래프트 마커 없음. 집계 배지는 칸반(subValidation)이 자식 oxf 로 자동 계산.
            badge: None,
            is_draft: false,
            parent_draft_id: None,
            stage: None, // phase 컨테이너는 stage 작업 아님.
        });
        self.stack = vec![id.clone()]; // phase 는 최상위 단계 — stack 리셋
        self.prev_phase = Some(id);
    }

    fn log(&mut self, _msg: &str) {}

    /// 규칙 A: parallel/pipeline 진입 = *스코프*만 push(노드 발행 X). blockedBy 를 형제/체인으로 가른다.
    fn group_enter(&mut self, kind: &str) {
        self.scopes.push(if kind == "pipeline" {
            GroupScope::Pipeline { prev: None }
        } else {
            GroupScope::Parallel
        });
    }

    fn group_exit(&mut self) {
        self.scopes.pop();
    }

    fn stage_boundary(&mut self) {
        // pipeline 의 새 item 체인 시작 — 현재 pipeline 스코프의 체인 리셋(item 간 독립).
        if let Some(GroupScope::Pipeline { prev }) = self.scopes.last_mut() {
            *prev = None;
        }
    }
}

/// ClaudeEmitHost — exec-stage 호스트. opts.publish 로 실행(claude) vs 발행(노드)을 가른다(규칙 C·결정3):
/// - opts.publish 없음 → 주입된 run(claude) 실행. stage 의 LLM 작업(예: genPrompt) = 진짜 호출, 결과로 데이터흐름.
/// - opts.publish:true → EmitHost 위임(자식 노드 발행, schema-shaped stub 반환). claude 안 돌림.
/// 즉 한 stage exec = claude 1+회 + 결과 트리를 항목/그룹 노드로 emit. 멱등은 스케줄러(done 재실행 X).
/// run = 주입(테스트는 fake, 실행은 ClaudeHost.agent). 발행 콜백(stdout)은 wh 에 위임.
pub struct ClaudeEmitHost<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> {
    pub wh: EmitHost,
    run: F,
}

impl<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> ClaudeEmitHost<F> {
    pub fn new(run: F) -> Self {
        ClaudeEmitHost { wh: EmitHost::new(), run }
    }
    /// 발행 노드 실시간 emit(stdout JSON line) — wh 에 위임.
    pub fn with_emit(mut self, emit: Box<dyn FnMut(&NodeEvent)>) -> Self {
        self.wh = self.wh.with_emit(emit);
        self
    }
    fn is_publish(opts: &BTreeMap<String, Val>) -> bool {
        matches!(opts.get("publish"), Some(Val::Bool(true)))
    }
}

impl<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> Host for ClaudeEmitHost<F> {
    fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String> {
        if Self::is_publish(opts) {
            self.wh.agent(prompt, opts) // 발행만(노드 emit + stub)
        } else {
            (self.run)(prompt, opts) // claude 실행(stage 의 LLM 작업)
        }
    }
    fn phase(&mut self, title: &str) {
        self.wh.phase(title);
    }
    fn log(&mut self, _msg: &str) {}
    fn group_enter(&mut self, kind: &str) {
        self.wh.group_enter(kind);
    }
    fn group_exit(&mut self) {
        self.wh.group_exit();
    }
    fn stage_boundary(&mut self) {
        self.wh.stage_boundary();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> EmitHost {
        EmitHost::new()
    }
    fn opts(pairs: &[(&str, &str)]) -> BTreeMap<String, Val> {
        let mut m = BTreeMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), Val::Str((*v).to_string()));
        }
        m
    }
    /// Val::Arr(문자열) — opts.blockedBy 등 배열 통로 테스트용.
    fn val_arr(ids: &[&str]) -> Val {
        Val::Arr(std::rc::Rc::new(std::cell::RefCell::new(ids.iter().map(|s| Val::Str((*s).to_string())).collect())))
    }
    /// Add 이벤트 → (kind, id, parent, blocked_by).
    fn adds(h: &EmitHost) -> Vec<(String, String, Option<String>, Vec<String>)> {
        h.events
            .iter()
            .map(|e| match e {
                NodeEvent::Add { kind, id, parent, blocked_by, .. } => {
                    (kind.clone(), id.clone(), parent.clone(), blocked_by.clone())
                }
            })
            .collect()
    }
    /// agent 노드만 → (id, parent, blocked_by).
    fn agents(h: &EmitHost) -> Vec<(String, Option<String>, Vec<String>)> {
        adds(h).into_iter().filter(|x| x.0 == "agent").map(|x| (x.1, x.2, x.3)).collect()
    }

    #[test]
    fn agent_single_leaf_no_blockedby() {
        let mut h = host();
        h.agent("p", &BTreeMap::new()).unwrap();
        let a = agents(&h);
        assert_eq!(a.len(), 1);
        assert!(a[0].2.is_empty(), "단일 작업은 blockedBy 없음");
    }

    #[test]
    fn rule_a_no_parallel_or_pipeline_nodes() {
        // [규칙 A] parallel/pipeline 은 노드가 아니다 — 어떤 발행 이벤트도 그 kind 를 갖지 않는다.
        let mut h = host();
        h.group_enter("parallel");
        h.agent("a", &BTreeMap::new()).unwrap();
        h.group_exit();
        h.group_enter("pipeline");
        h.stage_boundary();
        h.agent("b", &BTreeMap::new()).unwrap();
        h.group_exit();
        for (kind, ..) in adds(&h) {
            assert!(kind != "parallel" && kind != "pipeline", "구조 키워드가 노드가 됨: {kind}");
        }
    }

    #[test]
    fn rule_a_parallel_children_are_siblings() {
        // parallel 자식 = 형제(동시): blockedBy 없음, 부모는 *바깥 컨테이너*(여기선 phase).
        let mut h = host();
        h.phase("분해");
        h.group_enter("parallel");
        h.agent("a", &BTreeMap::new()).unwrap();
        h.agent("b", &BTreeMap::new()).unwrap();
        h.group_exit();
        let phase_id = adds(&h).into_iter().find(|x| x.0 == "phase").unwrap().1;
        let a = agents(&h);
        assert_eq!(a.len(), 2);
        assert!(a[0].2.is_empty() && a[1].2.is_empty(), "동시: 둘 다 blockedBy 없음");
        assert_eq!(a[0].1, Some(phase_id.clone()), "부모 = 바깥 phase(parallel 컨테이너 아님)");
        assert_eq!(a[1].1, Some(phase_id));
    }

    #[test]
    fn rule_a_pipeline_children_chain_blockedby() {
        let mut h = host();
        h.group_enter("pipeline");
        h.stage_boundary(); // item 시작
        h.agent("s1", &BTreeMap::new()).unwrap();
        h.agent("s2", &BTreeMap::new()).unwrap();
        h.group_exit();
        let a = agents(&h);
        assert!(a[0].2.is_empty(), "s1 체인 시작 — blockedBy 없음");
        assert_eq!(a[1].2, vec![a[0].0.clone()], "s2 blockedBy [s1]");
    }

    #[test]
    fn rule_a_pipeline_items_independent() {
        let mut h = host();
        h.group_enter("pipeline");
        h.stage_boundary();
        h.agent("i1s1", &BTreeMap::new()).unwrap();
        h.agent("i1s2", &BTreeMap::new()).unwrap();
        h.stage_boundary(); // 새 item
        h.agent("i2s1", &BTreeMap::new()).unwrap();
        h.agent("i2s2", &BTreeMap::new()).unwrap();
        h.group_exit();
        let a = agents(&h);
        assert!(a[2].2.is_empty(), "item2 첫 stage 는 item1 과 독립(blockedBy 없음)");
        assert_eq!(a[3].2, vec![a[2].0.clone()], "item2 stage2 blockedBy item2 stage1");
    }

    #[test]
    fn rule_a_parallel_inside_pipeline_children_are_siblings() {
        // parallel 이 pipeline 한 stage 안에 있으면 그 자식들은 형제(체인 X) — parallel 이 체인을 막는다.
        let mut h = host();
        h.group_enter("pipeline");
        h.stage_boundary();
        h.group_enter("parallel");
        h.agent("x", &BTreeMap::new()).unwrap();
        h.agent("y", &BTreeMap::new()).unwrap();
        h.group_exit();
        h.group_exit();
        let a = agents(&h);
        assert_eq!(a.len(), 2);
        assert!(a[0].2.is_empty() && a[1].2.is_empty(), "pipeline 안의 parallel 자식도 형제(체인 X)");
    }

    #[test]
    fn phase_is_container_node_sequential() {
        let mut h = host();
        h.phase("Scope");
        h.phase("Verify");
        h.phase("Synthesize");
        let p: Vec<_> = adds(&h).into_iter().filter(|x| x.0 == "phase").collect();
        assert_eq!(p.len(), 3, "phase 는 컨테이너 노드");
        assert!(p[0].3.is_empty(), "Scope 첫 phase");
        assert_eq!(p[1].3, vec![p[0].1.clone()], "Verify blockedBy [Scope]");
        assert_eq!(p[2].3, vec![p[1].1.clone()], "Synthesize blockedBy [Verify]");
    }

    #[test]
    fn rule_b_title_and_description_from_opts() {
        let mut h = host();
        h.agent("프롬프트 본문", &opts(&[("title", "재고 동기화"), ("description", "주문 시 재고 차감")]))
            .unwrap();
        match &h.events[0] {
            NodeEvent::Add { title, description, prompt, .. } => {
                assert_eq!(title, "재고 동기화", "title = opts.title(LLM 발명)");
                assert_eq!(description, "주문 시 재고 차감", "description = opts.description(사람용, body 와 별개)");
                assert_eq!(prompt, "프롬프트 본문", "prompt = agent 본문(verifyPrompt — 칸반 body 로)");
            }
        }
    }

    #[test]
    fn rule_b_no_label_fallback() {
        // [규칙 B] label 은 더 이상 title 로 쓰이지 않는다 — label 만 있고 title 없으면 title 은 빈 문자열.
        let mut h = host();
        h.agent("p", &opts(&[("label", "agent#1")])).unwrap();
        match &h.events[0] {
            NodeEvent::Add { title, .. } => assert_eq!(title, "", "label fallback 폐기 — 기계 라벨이 title 로 새지 않음"),
        }
    }

    #[test]
    fn draft_badge_only_when_opts_marks_item() {
        // [칸반 계약] badge 는 드래프트 항목에만(opts.badge). 일반 노드엔 없음(보드 오염 방지).
        let mut h = host();
        h.agent("process", &BTreeMap::new()).unwrap(); // 일반 노드 → badge 없음
        h.agent("item", &opts(&[("badge", "검수전")])).unwrap(); // 드래프트 항목 → badge
        let badges: Vec<Option<String>> = h
            .events
            .iter()
            .map(|e| match e {
                NodeEvent::Add { badge, .. } => badge.clone(),
            })
            .collect();
        assert_eq!(badges[0], None, "일반 노드엔 badge 없음(보드 오염 방지)");
        assert_eq!(badges[1], Some("검수전".into()), "드래프트 항목 = opts.badge");
    }

    #[test]
    fn draft_kind_and_category_from_opts() {
        // [모델 B emit 확장] kind(chunk/group/item/task) + category 가 opts 에서 흘러온다. 미지정=agent.
        let mut h = host();
        h.agent("", &opts(&[("kind", "group"), ("category", "재고 관리"), ("title", "재고")])).unwrap();
        h.agent("p", &BTreeMap::new()).unwrap(); // 미지정 → agent, category 없음
        match &h.events[0] {
            NodeEvent::Add { kind, category, .. } => {
                assert_eq!(kind, "group");
                assert_eq!(category.as_deref(), Some("재고 관리"));
            }
        }
        match &h.events[1] {
            NodeEvent::Add { kind, category, .. } => {
                assert_eq!(kind, "agent", "미지정 기본 kind");
                assert_eq!(category, &None, "category 미지정 시 생략");
            }
        }
    }

    #[test]
    fn draft_prompt_normalization_channel() {
        // [프롬프트 정규화] item = promptRole+vars(참조), chunk = registerPrompts(등록). Rust 는 텍스트/role 만 relay.
        let mut h = host();
        // chunk: registerPrompts 등록 통로
        let mut chunk_opts = opts(&[("kind", "chunk")]);
        chunk_opts.insert(
            "registerPrompts".into(),
            val_obj(vec![("verify", Val::Str("SHARED... {{title}}".into()))]),
        );
        h.agent("", &chunk_opts).unwrap();
        // item: promptRole + vars 참조(1번째 인자 빈 문자열 — 완성 프롬프트 안 실림)
        let mut item_opts = opts(&[("kind", "item"), ("promptRole", "verify")]);
        item_opts.insert("vars".into(), val_obj(vec![("title", Val::Str("슬롯≠재고".into()))]));
        h.agent("", &item_opts).unwrap();

        // chunk 이벤트: register_prompts 있음, prompt_role 없음
        match &h.events[0] {
            NodeEvent::Add { register_prompts, prompt_role, .. } => {
                assert!(register_prompts.is_some(), "chunk 에 registerPrompts relay");
                assert_eq!(prompt_role, &None);
            }
        }
        // item 이벤트: prompt_role='verify', vars 있음, prompt(1번째 인자)=빈 문자열
        match &h.events[1] {
            NodeEvent::Add { prompt_role, vars, prompt, register_prompts, .. } => {
                assert_eq!(prompt_role.as_deref(), Some("verify"), "item promptRole relay");
                assert!(vars.is_some(), "item vars relay");
                assert_eq!(prompt, "", "정규화 item 은 완성 프롬프트 안 실음(1번째 인자 빈 문자열)");
                assert_eq!(register_prompts, &None, "item 엔 registerPrompts 없음");
            }
        }
    }

    #[test]
    fn claude_emit_host_publish_emits_else_runs() {
        // [exec-stage] opts.publish:true → 노드 발행(claude X). 없음 → 주입 run(claude) 실행.
        let mut h = ClaudeEmitHost::new(|p: &str, _o: &BTreeMap<String, Val>| Ok(Val::Str(format!("ran:{p}"))));
        // 비-publish(genPrompt) → run 실행, 노드 발행 안 함.
        let r = h.agent("genPrompt", &BTreeMap::new()).unwrap();
        assert_eq!(to_string(&r), "ran:genPrompt", "비-publish 는 주입 run(claude) 실행");
        assert!(h.wh.events.is_empty(), "비-publish 는 노드 발행 0");
        // publish 항목 → 노드 발행(claude 안 돌림), prompt=verifyPrompt 가 body 로.
        let mut o = opts(&[("kind", "item"), ("nodeId", "g0i0"), ("parent", "g0"), ("title", "재고 차감"), ("badge", "검수전")]);
        o.insert("publish".into(), Val::Bool(true));
        h.agent("재고 차감 검증 프롬프트", &o).unwrap();
        assert_eq!(h.wh.events.len(), 1, "publish 는 노드 1개 발행");
        match &h.wh.events[0] {
            NodeEvent::Add { kind, id, parent, prompt, badge, .. } => {
                assert_eq!(kind, "item");
                assert_eq!(id, "g0i0");
                assert_eq!(parent.as_deref(), Some("g0"));
                assert_eq!(prompt, "재고 차감 검증 프롬프트", "항목 prompt=verifyPrompt(exec-one 입력)");
                assert_eq!(badge.as_deref(), Some("검수전"));
            }
        }
    }

    #[test]
    fn claude_emit_host_publish_carries_blockedby_and_description() {
        // [exec-stage 경로] ClaudeEmitHost.publish 가 opts.blockedBy→ev.blocked_by + opts.description→ev.description 를
        // 함께 emit(publish 분기 = EmitHost.agent 위임). 없으면 Hunt 가 항목 검증 전 ready(B) + 요건설명 표시 깨짐(A).
        let mut h = ClaudeEmitHost::new(|_p: &str, _o: &BTreeMap<String, Val>| Ok(Val::Str(String::new())));
        let mut o = opts(&[("kind", "task"), ("stage", "hunt"), ("nodeId", "hunt"), ("title", "누락 탐색"), ("description", "전체 원장 누락 탐색")]);
        o.insert("publish".into(), Val::Bool(true));
        o.insert("blockedBy".into(), val_arr(&["g0i0", "g0i1"]));
        h.agent("", &o).unwrap();
        match &h.wh.events[0] {
            NodeEvent::Add { blocked_by, description, .. } => {
                assert_eq!(blocked_by, &vec!["g0i0".to_string(), "g0i1".to_string()], "exec-stage publish 가 opts.blockedBy emit(Hunt/Audit 순서)");
                assert_eq!(description, "전체 원장 누락 탐색", "exec-stage publish 가 opts.description emit(규칙 B 요건설명 표시)");
            }
        }
    }

    #[test]
    fn opts_blocked_by_explicit_for_hunt_audit_order() {
        // [모델 B] opts.blockedBy(명시적 — draft Hunt/Audit: blockedBy=항목 nodeId들) → NodeEvent.blocked_by.
        // 없으면 Hunt 가 항목 검증 전 ready 되는 버그. main.js relay 가 keyOf 로 칸반 id 해석.
        let mut h = host();
        let mut o = opts(&[("kind", "task"), ("nodeId", "hunt"), ("title", "누락 탐색")]);
        o.insert("blockedBy".into(), val_arr(&["g0i0", "g0i1", "g1i0"]));
        h.agent("hunt", &o).unwrap();
        match &h.events[0] {
            NodeEvent::Add { blocked_by, id, .. } => {
                assert_eq!(id, "hunt");
                assert_eq!(blocked_by, &vec!["g0i0".to_string(), "g0i1".to_string(), "g1i0".to_string()], "opts.blockedBy → blocked_by(순서 보장)");
            }
        }
    }

    #[test]
    fn opts_stage_to_node_stage_field() {
        // [모델 B] task 노드의 stage(generate/hunt/audit)는 opts.stage → NodeEvent.stage 필드.
        // prompt 가 아니다 — task 노드 prompt 는 비운다(main.js relay 가 stage 필드로 exec-stage body 임베드).
        let mut h = host();
        h.agent("", &opts(&[("kind", "task"), ("stage", "generate"), ("nodeId", "gen"), ("title", "요건 도출")]))
            .unwrap();
        match &h.events[0] {
            NodeEvent::Add { stage, kind, prompt, .. } => {
                assert_eq!(stage.as_deref(), Some("generate"), "opts.stage → ev.stage 필드");
                assert_eq!(kind, "task");
                assert_eq!(prompt, "", "task 노드 prompt 비움(stage 는 별도 필드)");
            }
        }
        // 일반 노드(stage 미지정) → stage 생략(JSON 에 안 실림 — 보드 오염 0).
        h.agent("p", &BTreeMap::new()).unwrap();
        match &h.events[1] {
            NodeEvent::Add { stage, .. } => assert_eq!(stage, &None, "stage 미지정 시 생략"),
        }
        let js = serde_json::to_string(&h.events[1]).unwrap();
        assert!(!js.contains("stage"), "일반 노드 JSON 엔 stage 없음: {js}");
    }

    #[test]
    fn draft_explicit_nodeid_parent_tree() {
        // [모델 B expand] opts.nodeId/parent 로 덩어리>그룹>항목 명시적 부모 사슬을 그린다(자동 id/stack 무시).
        let mut h = host();
        let mut g = opts(&[("kind", "group"), ("nodeId", "g0"), ("parent", "CHUNK-7"), ("title", "재고")]);
        g.insert("category".into(), Val::Str("재고".into()));
        h.agent("", &g).unwrap();
        let it = opts(&[("kind", "item"), ("nodeId", "g0i0"), ("parent", "g0"), ("title", "재고 차감"), ("badge", "검수전")]);
        h.agent("주문 시 재고를 차감해야 한다 — 검증 프롬프트", &it).unwrap();
        // 그룹: id=g0, parent=기존 덩어리(CHUNK-7).
        match &h.events[0] {
            NodeEvent::Add { id, parent, kind, .. } => {
                assert_eq!(id, "g0");
                assert_eq!(parent.as_deref(), Some("CHUNK-7"), "그룹 부모 = 기존 덩어리 ref");
                assert_eq!(kind, "group");
            }
        }
        // 항목: id=g0i0, parent=g0(그룹), prompt=verify 본문(칸반 body 로 갈 exec 입력).
        match &h.events[1] {
            NodeEvent::Add { id, parent, kind, prompt, badge, .. } => {
                assert_eq!(id, "g0i0");
                assert_eq!(parent.as_deref(), Some("g0"), "항목 부모 = 그룹");
                assert_eq!(kind, "item");
                assert_eq!(prompt, "주문 시 재고를 차감해야 한다 — 검증 프롬프트", "항목 prompt=verifyPrompt(exec 입력)");
                assert_eq!(badge.as_deref(), Some("검수전"));
            }
        }
    }

    #[test]
    fn draft_chunk_isdraft_and_clone_parentdraftid() {
        // [칸반 계약] 덩어리 부모=isDraft, 복제 재제출=parentDraftId(덩어리 수준). opts 에서 통과.
        let mut h = host();
        let mut o = opts(&[("parentDraftId", "chunk-v1"), ("title", "재고 정합성")]);
        o.insert("isDraft".into(), Val::Bool(true));
        h.agent("chunk", &o).unwrap();
        match &h.events[0] {
            NodeEvent::Add { is_draft, parent_draft_id, badge, .. } => {
                assert!(*is_draft, "덩어리 부모 isDraft");
                assert_eq!(parent_draft_id.as_deref(), Some("chunk-v1"), "복제 계보(덩어리 수준)");
                assert_eq!(badge, &None, "덩어리는 항목 badge 가 아님");
            }
        }
    }

    #[test]
    fn plain_node_json_omits_draft_markers() {
        // [칸반 계약] 직렬화 수준 — 일반 노드 JSON 엔 드래프트 마커가 *전혀* 안 실린다(보드 오염 방지).
        let mut h = host();
        h.agent("p", &BTreeMap::new()).unwrap();
        h.phase("X");
        for ev in &h.events {
            let js = serde_json::to_string(ev).unwrap();
            assert!(!js.contains("badge"), "일반 노드에 badge 없음: {js}");
            assert!(!js.contains("is_draft"), "일반 노드에 is_draft 없음: {js}");
            assert!(!js.contains("parent_draft_id"), "일반 노드에 parent_draft_id 없음: {js}");
        }
    }

    #[test]
    fn draft_item_json_carries_badge() {
        // 드래프트 항목은 JSON 에 badge 가 실린다(칸반 node.add 가 드래프트로 인식).
        let mut h = host();
        h.agent("item", &opts(&[("badge", "검수전")])).unwrap();
        let js = serde_json::to_string(&h.events[0]).unwrap();
        assert!(js.contains("\"badge\":\"검수전\""), "드래프트 항목 JSON 에 badge: {js}");
    }

    #[test]
    fn rule_c_publish_only_no_status_events() {
        // [규칙 C] 발행만 — 모든 이벤트는 Add. 실행 lifecycle(status) 이벤트 없음(스케줄러+exec-one 의 몫).
        let mut h = host();
        h.agent("p", &BTreeMap::new()).unwrap();
        h.phase("X");
        assert!(h.events.iter().all(|e| matches!(e, NodeEvent::Add { .. })), "발행 이벤트는 Add 뿐");
    }

    // ── interp → host 통합: run_parallel/run_pipeline 가 실제로 형제/체인을 그리는지(직접 호출 아님) ──
    use crate::interp::Interp;
    use serde_json::json;

    /// arrow (params)=>agent(prompt,{}) 의 ESTree 노드.
    fn arrow_agent(params: &[&str], prompt: &str) -> serde_json::Value {
        json!({
            "type": "ArrowFunctionExpression",
            "params": params.iter().map(|p| json!({"type":"Identifier","name":p})).collect::<Vec<_>>(),
            "body": {"type":"CallExpression","callee":{"type":"Identifier","name":"agent"},
                "arguments":[{"type":"Literal","value":prompt},{"type":"ObjectExpression","properties":[]}]}
        })
    }
    fn run_program(prog: &serde_json::Value) -> EmitHost {
        let mut wh = EmitHost::new();
        Interp::new(&mut wh).run(prog, serde_json::Value::Null).expect("interp 해석");
        wh
    }

    #[test]
    fn interp_parallel_emits_siblings_no_node() {
        // parallel([()=>agent("a"), ()=>agent("b")]) → 형제 2개, parallel 노드 0.
        let prog = json!({"type":"Program","body":[{"type":"ExpressionStatement","expression":{
            "type":"CallExpression","callee":{"type":"Identifier","name":"parallel"},
            "arguments":[{"type":"ArrayExpression","elements":[arrow_agent(&[],"a"), arrow_agent(&[],"b")]}]
        }}]});
        let h = run_program(&prog);
        for (kind, ..) in adds(&h) {
            assert!(kind != "parallel", "parallel 이 노드가 됨");
        }
        let a = agents(&h);
        assert_eq!(a.len(), 2, "agent 2");
        assert!(a[0].2.is_empty() && a[1].2.is_empty(), "interp parallel → 형제(blockedBy 없음)");
    }

    #[test]
    fn interp_pipeline_emits_chain_per_item_no_node() {
        // pipeline(["a","b"], (x)=>agent("s1"), (x)=>agent("s2")) → item 마다 s1→s2 체인, pipeline 노드 0.
        let prog = json!({"type":"Program","body":[{"type":"ExpressionStatement","expression":{
            "type":"CallExpression","callee":{"type":"Identifier","name":"pipeline"},
            "arguments":[
                {"type":"ArrayExpression","elements":[{"type":"Literal","value":"a"},{"type":"Literal","value":"b"}]},
                arrow_agent(&["x"],"s1"),
                arrow_agent(&["x"],"s2")
            ]
        }}]});
        let h = run_program(&prog);
        for (kind, ..) in adds(&h) {
            assert!(kind != "pipeline", "pipeline 이 노드가 됨");
        }
        let a = agents(&h);
        assert_eq!(a.len(), 4, "item 2 × stage 2 = agent 4");
        assert!(a[0].2.is_empty(), "item1 stage1 체인 시작");
        assert_eq!(a[1].2, vec![a[0].0.clone()], "item1 stage2 blockedBy item1 stage1");
        assert!(a[2].2.is_empty(), "item2 stage1 은 item1 과 독립(blockedBy 없음)");
        assert_eq!(a[3].2, vec![a[2].0.clone()], "item2 stage2 blockedBy item2 stage1");
    }

    #[test]
    fn draft_string_args_sets_directive_not_sample() {
        // [#7] args 가 문자열(지시어)이면 draft.js 가 DIRECTIVE=args 로 받아야 한다. 클론 VM 의 member(Str,"split")
        // 은 Undefined 라 구 `if (args && args.split)` 분기는 영영 falsy → string 지시어 폐기 → SAMPLE 폴백 버그.
        // 수정(typeof args === 'string') 후엔 emit 된 덩어리(chunk) description = 넘긴 문자열.
        // fixtures/gen.pharmacy.skeleton.json = generate-skeleton(glm-5.2, 약국 SaaS) 실측 산출(gen.js→parse). 실행 워크플로=gen.js.
        // (재생성: make -C e2e e2e && make -C e2e commit-fixture. draft.js 는 backup 비교물, 여기 미참여.)
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/gen.pharmacy.skeleton.json")).unwrap();
        let program = skeleton.get("program").expect("program(완전 AST)");
        let mut wh = EmitHost::new();
        Interp::new(&mut wh)
            .run(program, Json::String("내 고유 지시어 XYZ".to_string()))
            .expect("interp 해석");
        let chunk_desc = wh.events.iter().find_map(|ev| {
            let NodeEvent::Add { kind, description, .. } = ev;
            if kind == "chunk" { Some(description.clone()) } else { None }
        });
        assert_eq!(
            chunk_desc.as_deref(),
            Some("내 고유 지시어 XYZ"),
            "string args → DIRECTIVE=args (SAMPLE 폴백 아님)"
        );
    }

    #[test]
    fn emit_callback_receives_published_nodes() {
        // with_emit 콜백이 실시간으로 발행 노드를 받는다(stdout JSON line 경로).
        use std::cell::RefCell;
        use std::rc::Rc;
        let seen = Rc::new(RefCell::new(Vec::<String>::new()));
        let sink = seen.clone();
        let mut h = host().with_emit(Box::new(move |ev: &NodeEvent| {
            let NodeEvent::Add { id, .. } = ev;
            sink.borrow_mut().push(id.clone());
        }));
        h.agent("p", &BTreeMap::new()).unwrap();
        assert_eq!(seen.borrow().len(), 1, "콜백이 발행 노드를 실시간 수신");
    }

    /// Val::Obj 헬퍼 — stub runner 가 genPrompt/huntPrompt/auditPrompt 산출(트리)을 만들 때 씀.
    fn val_obj(pairs: Vec<(&str, Val)>) -> Val {
        let mut m = BTreeMap::new();
        for (k, v) in pairs {
            m.insert(k.to_string(), v);
        }
        Val::Obj(std::rc::Rc::new(std::cell::RefCell::new(m)))
    }
    fn val_arr_vals(vs: Vec<Val>) -> Val {
        Val::Arr(std::rc::Rc::new(std::cell::RefCell::new(vs)))
    }

    /// [Phase5 e2e — AST→Rust 런타임] gen.pharmacy.skeleton.json program(generate stage) 을 ClaudeEmitHost(stub runner)
    /// 로 돌려 genPrompt→평탄 requirements(2항목, CHUNK_REF 직속, category 없음) + Hunt→Classify→Audit task(blockedBy 사슬) emit.
    /// fixtures/gen.pharmacy.skeleton.json 은 glm-5.2 실측 **평탄 program**(classify-late): stub 이 requirements[] 를
    /// 반환하면 program 이 flat item(CHUNK_REF 직속, category 없음) + hunt/classify/audit task(blockedBy 사슬)를 발행한다.
    #[test]
    fn draft_generate_stage_emits_flat_items_hunt_classify_audit() {
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/gen.pharmacy.skeleton.json")).unwrap();
        let program = skeleton.get("program").expect("program(완전 AST)");
        let req = |t: &str, d: &str, o: &str| {
            val_obj(vec![
                ("title", Val::Str(t.into())),
                ("description", Val::Str(d.into())),
                ("origin", Val::Str(o.into())),
            ])
        };
        let mut h = ClaudeEmitHost::new(|p: &str, _o: &BTreeMap<String, Val>| {
            if p.contains("GENERATOR") {
                // 평탄 계약: groups 없이 requirements[] 만 발굴.
                Ok(val_obj(vec![
                    ("title", Val::Str("테스트 덩어리".into())),
                    ("titleOrigin", Val::Str("agent".into())),
                    ("requirements", val_arr_vals(vec![req("항목1", "설명1", "user"), req("항목2", "설명2", "agent")])),
                ]))
            } else {
                Ok(Val::Str(String::new()))
            }
        });
        let args = json!({ "stage": "generate", "directive": "테스트 지시", "chunkRef": "chunk" });
        Interp::new(&mut h).run(program, args).expect("generate interp 해석");

        let ev = &h.wh.events;
        // 평탄: 그룹 0, 항목 2(CHUNK_REF 직속).
        let groups = ev.iter().filter(|e| matches!(e, NodeEvent::Add { kind, .. } if kind == "group")).count();
        let items = ev.iter().filter(|e| matches!(e, NodeEvent::Add { kind, .. } if kind == "item")).count();
        assert_eq!(groups, 0, "generate → 그룹 emit 0(평탄)");
        assert_eq!(items, 2, "generate → 평탄 항목 2개 emit");
        // 항목은 CHUNK_REF 직속 + badge=검수전 + category 없음.
        let i0 = ev.iter().find(|e| matches!(e, NodeEvent::Add { kind, id, .. } if kind == "item" && id == "i0"));
        assert!(
            matches!(i0, Some(NodeEvent::Add { parent, badge, category, .. })
                if parent.as_deref() == Some("chunk") && badge.as_deref() == Some("검수전") && category.is_none()),
            "평탄 항목: parent=CHUNK_REF 직속, badge=검수전, category 없음"
        );
        // 정규화(콘텐츠 주소화): prompt '' + promptRole=verify + vars(작은값) + var_refs(directive 콘텐츠 주소).
        assert!(
            matches!(i0, Some(NodeEvent::Add { prompt, prompt_role, vars, var_refs, .. })
                if prompt.is_empty() && prompt_role.as_deref() == Some("verify") && vars.is_some() && var_refs.is_some()),
            "항목 정규화: prompt '' + promptRole=verify + vars(작은값) + var_refs(directive 콘텐츠 주소 참조)"
        );
        if let Some(NodeEvent::Add { vars: Some(v), .. }) = i0 {
            assert!(v.get("directive").is_none(), "directive 는 vars 에 없어야(복붙 방지) — var_refs 로 참조");
        }

        // task 사슬: Hunt[i0,i1] → Classify[i0,i1,hunt] → Audit[i0,i1,hunt,classify].
        let hunt = ev.iter().find(|e| matches!(e, NodeEvent::Add { kind, id, .. } if kind == "task" && id == "hunt"));
        assert!(
            matches!(hunt, Some(NodeEvent::Add { blocked_by, .. }) if blocked_by == &vec!["i0".to_string(), "i1".to_string()]),
            "hunt blockedBy=[i0,i1] (항목 검증 후 실행)"
        );
        let classify = ev.iter().find(|e| matches!(e, NodeEvent::Add { kind, id, .. } if kind == "task" && id == "classify"));
        assert!(
            matches!(classify, Some(NodeEvent::Add { blocked_by, .. }) if blocked_by == &vec!["i0".to_string(), "i1".to_string(), "hunt".to_string()]),
            "classify blockedBy=[i0,i1,hunt] (hunt 후 = 완성 집합)"
        );
        let audit = ev.iter().find(|e| matches!(e, NodeEvent::Add { kind, id, .. } if kind == "task" && id == "audit"));
        assert!(
            matches!(audit, Some(NodeEvent::Add { blocked_by, .. }) if blocked_by == &vec!["i0".to_string(), "i1".to_string(), "hunt".to_string(), "classify".to_string()]),
            "audit blockedBy=[i0,i1,hunt,classify] (분류 후 실행)"
        );
    }

    /// [Phase5 e2e] skeleton stage(args 없음) → chunk(isDraft) + Generate task(kind:task) emit.
    #[test]
    fn draft_skeleton_stage_emits_chunk_and_generate_task() {
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/gen.pharmacy.skeleton.json")).unwrap();
        let program = skeleton.get("program").expect("program");
        let mut h = ClaudeEmitHost::new(|_p: &str, _o: &BTreeMap<String, Val>| Ok(Val::Str(String::new())));
        // directive 는 args 로 주입(런타임은 workflow.run 이 runtime.directive 전달) — chunk description = DIRECTIVE.
        // gen.js 는 SAMPLE 폴백 없음(정상): directive 미주입이면 desc 빈 문자열이 맞다.
        Interp::new(&mut h).run(program, json!({ "title": "내 백로그", "directive": "약국 재고 SaaS 지시어" })).expect("skeleton interp");
        let ev = &h.wh.events;
        let chunk = ev.iter().find(|e| matches!(e, NodeEvent::Add { kind, .. } if kind == "chunk"));
        assert!(matches!(chunk, Some(NodeEvent::Add { description, .. }) if description.contains("약국")), "chunk emit + description=DIRECTIVE(args 주입)");
        let gen = ev.iter().find(|e| matches!(e, NodeEvent::Add { kind, id, .. } if kind == "task" && id == "gen"));
        assert!(gen.is_some(), "Generate task(kind:task) emit");
    }

    /// [Phase5 e2e] hunt stage — huntPrompt(ledger)→additions → 추가항목(badge=검수전, 평탄 CHUNK_REF 직속, category 없음) emit.
    /// glm-5.2 실측 평탄 program: HUNT_SCHEMA 에 category 없음 → additions 는 category 없는 평탄 요건(CHUNK_REF 직속).
    #[test]
    fn draft_hunt_stage_emits_flat_additions() {
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/gen.pharmacy.skeleton.json")).unwrap();
        let program = skeleton.get("program").expect("program");
        let mut h = ClaudeEmitHost::new(|p: &str, _o: &BTreeMap<String, Val>| {
            if p.contains("AUDITOR") {
                Ok(Val::Str(String::new()))
            } else if p.contains("GOAL-REACH") {
                // 평탄 계약: additions 에 category 없음(분류는 classify 몫).
                let add = val_obj(vec![
                    ("title", Val::Str("추가항목".into())),
                    ("description", Val::Str("누락 make-or-break".into())),
                    ("origin", Val::Str("agent".into())),
                ]);
                Ok(val_obj(vec![("additions", val_arr_vals(vec![add]))]))
            } else {
                Ok(Val::Str(String::new()))
            }
        });
        let args = json!({ "stage": "hunt", "ledger": [{ "id": "i0", "title": "기존", "badge": "o" }] });
        Interp::new(&mut h).run(program, args).expect("hunt interp");
        let ev = &h.wh.events;
        let adds: Vec<&NodeEvent> = ev
            .iter()
            .filter(|e| matches!(e, NodeEvent::Add { kind, id, .. } if kind == "item" && id.starts_with("add")))
            .collect();
        assert_eq!(adds.len(), 1, "hunt → 추가항목 1개 emit");
        assert!(
            matches!(adds[0], NodeEvent::Add { kind, badge, parent, category, .. }
                if kind == "item" && badge.as_deref() == Some("검수전") && parent.as_deref() == Some("chunk") && category.is_none()),
            "추가항목 badge=검수전, parent=CHUNK_REF(덩어리 직속), category 없음(평탄)"
        );
    }

    /// [Phase5 e2e] audit stage — auditPrompt(ledger)→{complete,verdict} return (emit 없음).
    #[test]
    fn draft_audit_stage_returns_verdict_no_emit() {
        let skeleton: Json = serde_json::from_str(include_str!("../fixtures/gen.pharmacy.skeleton.json")).unwrap();
        let program = skeleton.get("program").expect("program");
        let mut h = ClaudeEmitHost::new(|p: &str, _o: &BTreeMap<String, Val>| {
            if p.contains("AUDITOR") {
                Ok(val_obj(vec![("complete", Val::Bool(true)), ("verdict", Val::Str("완결".into())), ("gaps", val_arr_vals(vec![])), ("contradictions", val_arr_vals(vec![])), ("sufficiency", Val::Str("충분".into()))]))
            } else {
                Ok(Val::Str(String::new()))
            }
        });
        let args = json!({ "stage": "audit", "ledger": [{ "title": "항목", "badge": "o", "category": "재고" }] });
        let ret = Interp::new(&mut h).run(program, args).expect("audit interp");
        // emit 0 (audit는 return 만)
        assert!(h.wh.events.is_empty(), "audit → 노드 emit 0 (return 만)");
        // return 값이 {verdict, complete}
        let verdict = match &ret {
            Val::Obj(m) => {
                let map = m.borrow();
                match (map.get("verdict"), map.get("complete")) {
                    (Some(Val::Str(v)), Some(Val::Bool(c))) => Some((v.clone(), *c)),
                    _ => None,
                }
            }
            _ => None,
        };
        assert_eq!(verdict, Some(("완결".to_string(), true)), "audit return = verdict:'완결', complete:true");
    }
}
