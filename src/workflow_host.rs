//! workflow_host — Host 구현: interp 의 agent/parallel/pipeline 을 칸반 노드 *발행*으로 매핑.
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
        prompt: String, // agent 프롬프트(verifyPrompt 등). main.js relay 가 schema 와 묶어 칸반 body(exec-one 입력)로.
        // task 노드(generate/hunt/audit) 의 stage — opts.stage 통로. main.js relay 가 stage 필드로 exec-stage body 임베드.
        // 일반/항목/그룹 노드는 없음(생략). task 노드 prompt 는 비운다 — stage 가 별도 축.
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<Json>, // 구조화 출력 계약(exec-one 용). 없으면 raw 텍스트 agent.
        #[serde(skip_serializing_if = "Option::is_none")]
        category: Option<String>, // 의미 그룹 차원 라벨(group 노드 분류·item 의 소속). draft category 사후 군집.
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

pub struct WorkflowHost {
    pub events: Vec<NodeEvent>,
    emit: Option<Box<dyn FnMut(&NodeEvent)>>, // 실시간 emit(stdout JSON line) — 없으면 buffer 만.
    stack: Vec<String>,        // 컨테이너 부모(phase) — 무한뎁스. parallel/pipeline 은 안 쌓음.
    scopes: Vec<GroupScope>,   // 현재 parallel/pipeline 스코프
    prev_phase: Option<String>, // phase 순차 blockedBy
    counter: usize,
}

impl Default for WorkflowHost {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkflowHost {
    pub fn new() -> Self {
        WorkflowHost {
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

impl Host for WorkflowHost {
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
        // task 노드 stage(generate/hunt/audit) — opts.stage. 일반/항목/그룹은 없음 → 생략.
        let stage = Self::opt_marker(opts, "stage");
        self.emit_node(NodeEvent::Add {
            id: id.clone(),
            parent,
            kind,
            title,
            description,
            prompt: prompt.into(),
            schema,
            category,
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
/// - opts.publish:true → WorkflowHost 위임(자식 노드 발행, schema-shaped stub 반환). claude 안 돌림.
/// 즉 한 stage exec = claude 1+회 + 결과 트리를 항목/그룹 노드로 emit. 멱등은 스케줄러(done 재실행 X).
/// run = 주입(테스트는 fake, 실행은 ClaudeHost.agent). 발행 콜백(stdout)은 wh 에 위임.
pub struct ClaudeEmitHost<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> {
    pub wh: WorkflowHost,
    run: F,
}

impl<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> ClaudeEmitHost<F> {
    pub fn new(run: F) -> Self {
        ClaudeEmitHost { wh: WorkflowHost::new(), run }
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

    fn host() -> WorkflowHost {
        WorkflowHost::new()
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
    fn adds(h: &WorkflowHost) -> Vec<(String, String, Option<String>, Vec<String>)> {
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
    fn agents(h: &WorkflowHost) -> Vec<(String, Option<String>, Vec<String>)> {
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
    fn run_program(prog: &serde_json::Value) -> WorkflowHost {
        let mut wh = WorkflowHost::new();
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
}
