//! workflow_host — Host 구현: interp 의 agent/parallel/pipeline 을 칸반 노드 발행으로 매핑.
//!
//! 사용자 확정 모델:
//! - agent  → 단일 리프 노드.
//! - parallel → 동시: 안의 노드들은 서로 blockedBy 없음(형제).
//! - pipeline → 순차: 같은 item 의 stage 노드 체인(blockedBy 연결).
//! - phase  → 순차 컨테이너(직전 phase 에 blockedBy).
//! - 무한뎁스: group/phase 컨테이너 노드 + stack 깊이. **그룹(컨테이너)끼리만 blockedBy** —
//!   자식까지 N×M 파편화하지 않는다(부모 컨테이너가 게이트; done 은 자식 집계 = subProgress).
//!
//! 실행은 주입된 exec 에 위임(스케줄러/스텁) — 이 모듈은 *발행 매핑*만 책임.
use crate::interp::{to_string, Host, Val};
use std::collections::BTreeMap;

/// 발행되는 칸반 노드 이벤트(→ JSON line → main.js → soksak-plugin-kanban node.add/edit).
/// JSON: {"ev":"add"|"status", ...} (camelCase: blockedBy). main.js 가 ev 로 분기.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "ev", rename_all = "lowercase")]
pub enum NodeEvent {
    Add {
        id: String,
        parent: Option<String>,
        kind: String, // "phase" | "parallel" | "pipeline" | "agent"
        title: String,
        body: String,
        blocked_by: Vec<String>,
    },
    Status {
        id: String,
        status: String, // "inprogress" | "done"
        result: String,
    },
}

enum Mode {
    Parallel,
    Pipeline,
}

pub struct WorkflowHost<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> {
    pub events: Vec<NodeEvent>,
    emit: Option<Box<dyn FnMut(&NodeEvent)>>, // 실시간 emit(stdout JSON line) — 없으면 buffer 만.
    stack: Vec<String>,         // 부모 컨테이너(phase/group) — 무한뎁스
    modes: Vec<Mode>,           // 현재 그룹 모드
    prev_chain: Option<String>, // pipeline 체인 직전 노드(같은 item)
    prev_phase: Option<String>, // phase 순차 blockedBy
    counter: usize,
    exec: F,
}

impl<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> WorkflowHost<F> {
    pub fn new(exec: F) -> Self {
        WorkflowHost {
            events: vec![],
            emit: None,
            stack: vec![],
            modes: vec![],
            prev_chain: None,
            prev_phase: None,
            counter: 0,
            exec,
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
    fn opt_vec(s: &Option<String>) -> Vec<String> {
        s.iter().cloned().collect()
    }
}

impl<F: FnMut(&str, &BTreeMap<String, Val>) -> Result<Val, String>> Host for WorkflowHost<F> {
    fn agent(&mut self, prompt: &str, opts: &BTreeMap<String, Val>) -> Result<Val, String> {
        let id = self.next_id("task");
        let parent = self.stack.last().cloned();
        let title = opts.get("label").map(to_string).unwrap_or_default();
        let in_pipeline = matches!(self.modes.last(), Some(Mode::Pipeline));
        // pipeline 체인이면 직전 노드에 blockedBy, 그 외(단일/parallel)는 없음.
        let blocked_by = if in_pipeline { Self::opt_vec(&self.prev_chain) } else { vec![] };
        self.emit_node(NodeEvent::Add {
            id: id.clone(),
            parent,
            kind: "agent".into(),
            title,
            body: prompt.into(),
            blocked_by,
        });
        self.emit_node(NodeEvent::Status { id: id.clone(), status: "inprogress".into(), result: String::new() });
        let res = (self.exec)(prompt, opts)?;
        self.emit_node(NodeEvent::Status { id: id.clone(), status: "done".into(), result: to_string(&res) });
        if in_pipeline {
            self.prev_chain = Some(id);
        }
        Ok(res)
    }

    fn phase(&mut self, title: &str) {
        let id = self.next_id("phase");
        let blocked_by = Self::opt_vec(&self.prev_phase); // 직전 phase 에 의존(순차)
        self.emit_node(NodeEvent::Add {
            id: id.clone(),
            parent: None,
            kind: "phase".into(),
            title: title.into(),
            body: String::new(),
            blocked_by,
        });
        self.stack = vec![id.clone()]; // phase 는 최상위 단계 — stack 리셋
        self.prev_phase = Some(id);
        self.prev_chain = None;
    }

    fn log(&mut self, _msg: &str) {}

    fn group_enter(&mut self, kind: &str) {
        let id = self.next_id(kind);
        let parent = self.stack.last().cloned();
        // 컨테이너 노드(게이트). 그룹끼리만 blockedBy — 여기선 부모 컨테이너가 게이트라 blockedBy 비움.
        self.emit_node(NodeEvent::Add {
            id: id.clone(),
            parent,
            kind: kind.into(),
            title: kind.into(),
            body: String::new(),
            blocked_by: vec![],
        });
        self.stack.push(id);
        self.modes.push(if kind == "pipeline" { Mode::Pipeline } else { Mode::Parallel });
        self.prev_chain = None;
    }

    fn group_exit(&mut self) {
        self.stack.pop();
        self.modes.pop();
        self.prev_chain = None;
    }

    fn stage_boundary(&mut self) {
        self.prev_chain = None; // 새 item 의 stage 체인 시작
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type StubFn = fn(&str, &BTreeMap<String, Val>) -> Result<Val, String>;
    fn stub(_p: &str, _o: &BTreeMap<String, Val>) -> Result<Val, String> {
        Ok(Val::Str("ok".into()))
    }
    fn host() -> WorkflowHost<StubFn> {
        WorkflowHost::new(stub)
    }
    /// Add 이벤트만 → (kind, id, parent, blocked_by).
    fn adds(h: &WorkflowHost<StubFn>) -> Vec<(String, String, Option<String>, Vec<String>)> {
        h.events
            .iter()
            .filter_map(|e| match e {
                NodeEvent::Add { kind, id, parent, blocked_by, .. } => {
                    Some((kind.clone(), id.clone(), parent.clone(), blocked_by.clone()))
                }
                _ => None,
            })
            .collect()
    }
    fn agents(h: &WorkflowHost<StubFn>) -> Vec<(String, Option<String>, Vec<String>)> {
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
    fn parallel_siblings_no_blockedby() {
        let mut h = host();
        h.group_enter("parallel");
        h.agent("a", &BTreeMap::new()).unwrap();
        h.agent("b", &BTreeMap::new()).unwrap();
        h.group_exit();
        let cont = &adds(&h)[0];
        assert_eq!(cont.0, "parallel");
        let a = agents(&h);
        assert_eq!(a.len(), 2);
        assert!(a[0].2.is_empty() && a[1].2.is_empty(), "동시: 둘 다 blockedBy 없음");
        assert_eq!(a[0].1, Some(cont.1.clone()), "부모 = parallel 컨테이너");
        assert_eq!(a[1].1, Some(cont.1.clone()));
    }

    #[test]
    fn pipeline_chains_blockedby() {
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
    fn pipeline_items_independent() {
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
        assert!(a[2].2.is_empty(), "item2 의 첫 stage 는 item1 과 독립(blockedBy 없음)");
        assert_eq!(a[3].2, vec![a[2].0.clone()], "item2 stage2 blockedBy item2 stage1");
    }

    #[test]
    fn phase_sequential_blockedby() {
        let mut h = host();
        h.phase("Scope");
        h.phase("Verify");
        h.phase("Synthesize");
        let p: Vec<_> = adds(&h).into_iter().filter(|x| x.0 == "phase").collect();
        assert!(p[0].3.is_empty(), "Scope 첫 phase");
        assert_eq!(p[1].3, vec![p[0].1.clone()], "Verify blockedBy [Scope]");
        assert_eq!(p[2].3, vec![p[1].1.clone()], "Synthesize blockedBy [Verify]");
    }

    #[test]
    fn nested_groups_infinite_depth() {
        // parallel(claims) { parallel(votes) { agent } } — 무한뎁스 부모 체인.
        let mut h = host();
        h.group_enter("parallel"); // G1
        h.group_enter("parallel"); // G2 (G1 자식)
        h.agent("vote", &BTreeMap::new()).unwrap();
        h.group_exit();
        h.group_exit();
        let a = adds(&h);
        let g1 = &a[0];
        let g2 = &a[1];
        let leaf = a.iter().find(|x| x.0 == "agent").unwrap();
        assert_eq!(g1.2, None, "G1 최상위");
        assert_eq!(g2.2, Some(g1.1.clone()), "G2 부모 = G1");
        assert_eq!(leaf.2, Some(g2.1.clone()), "leaf 부모 = G2 (무한뎁스)");
    }
}
