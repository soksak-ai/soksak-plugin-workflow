//! scheduler — 칸반 노드 DAG 를 blockedBy 기반으로 실행하는 동적 DAG 엔진.
//!
//! - **준비 노드** = status=todo ∧ 리프(자식 없음) ∧ 자기와 *모든 조상*의 blockedBy 가 전부 done.
//!   → 준비 노드들을 동시 실행(진짜 병렬)한다.
//! - **컨테이너**(자식 있음)는 직접 실행 안 함 — 자식이 전부 done 이면 done(집계 = 칸반 subProgress).
//! - **그룹 게이트 상속**: 부모 컨테이너의 blockedBy 가 자식에 상속된다(그룹끼리만 blockedBy 를 걸어도
//!   자식이 그 게이트를 받음 — N×M 파편화 없이 그룹 순차가 성립). lock 상속과 같은 원리.
//!
//! 이 모듈은 *판정 코어*(동기). 실제 동시 실행(claude -p, tokio)·칸반 갱신은 상위(run loop)가 얹는다.

#[derive(Clone, Debug, PartialEq)]
pub struct TaskNode {
    pub id: String,
    pub parent: Option<String>,
    pub blocked_by: Vec<String>,
    pub status: String, // "todo" | "inprogress" | "done"
    pub body: String,
}

impl TaskNode {
    pub fn new(id: &str, parent: Option<&str>, blocked_by: &[&str], status: &str) -> Self {
        TaskNode {
            id: id.into(),
            parent: parent.map(|s| s.into()),
            blocked_by: blocked_by.iter().map(|s| s.to_string()).collect(),
            status: status.into(),
            body: String::new(),
        }
    }
}

pub struct Dag {
    pub nodes: Vec<TaskNode>,
}

impl Dag {
    pub fn new(nodes: Vec<TaskNode>) -> Self {
        Dag { nodes }
    }
    fn get(&self, id: &str) -> Option<&TaskNode> {
        self.nodes.iter().find(|n| n.id == id)
    }
    pub fn is_container(&self, id: &str) -> bool {
        self.nodes.iter().any(|n| n.parent.as_deref() == Some(id))
    }
    /// done: 리프=status done; 컨테이너=자식 전부 done(집계); 미존재 의존=false(안전).
    pub fn is_done(&self, id: &str) -> bool {
        match self.get(id) {
            None => false,
            Some(n) => {
                if self.is_container(id) {
                    self.nodes.iter().filter(|c| c.parent.as_deref() == Some(id)).all(|c| self.is_done(&c.id))
                } else {
                    n.status == "done"
                }
            }
        }
    }
    /// 자기와 모든 조상의 blocked_by 가 전부 done 인가(그룹 게이트 상속).
    fn deps_satisfied(&self, n: &TaskNode) -> bool {
        let mut cur = Some(n);
        while let Some(node) = cur {
            if !node.blocked_by.iter().all(|b| self.is_done(b)) {
                return false;
            }
            cur = node.parent.as_deref().and_then(|p| self.get(p));
        }
        true
    }
    /// 실행 준비된 리프 노드 id 들(동시 실행 대상).
    pub fn ready(&self) -> Vec<String> {
        self.nodes
            .iter()
            .filter(|n| n.status == "todo" && !self.is_container(&n.id) && self.deps_satisfied(n))
            .map(|n| n.id.clone())
            .collect()
    }
    pub fn set_status(&mut self, id: &str, status: &str) {
        if let Some(n) = self.nodes.iter_mut().find(|n| n.id == id) {
            n.status = status.into();
        }
    }
    /// 모든 리프가 done 이면 완료.
    pub fn all_done(&self) -> bool {
        self.nodes.iter().filter(|n| !self.is_container(&n.id)).all(|n| n.status == "done")
    }

    /// run — 준비 노드를 라운드마다 **동시 실행**(std::thread::scope, 진짜 병렬: claude -p 동시 spawn).
    /// 각 노드 exec(node)→result 기록·done. blockedBy 게이트가 순차를, 무게이트가 동시를 만든다.
    /// 반환=라운드 수(동시=1, 체인=N). 교착(준비 없는데 미완)이면 중단.
    pub fn run<F>(&mut self, exec: &F) -> usize
    where
        F: Fn(&TaskNode) -> String + Sync,
    {
        let mut rounds = 0;
        loop {
            let ready = self.ready();
            if ready.is_empty() {
                break;
            }
            rounds += 1;
            let batch: Vec<TaskNode> = ready.iter().filter_map(|id| self.get(id).cloned()).collect();
            // 같은 라운드의 준비 노드들을 동시 실행(진짜 병렬).
            let results: Vec<(String, String)> = std::thread::scope(|s| {
                let handles: Vec<_> = batch.iter().map(|n| s.spawn(move || (n.id.clone(), exec(n)))).collect();
                handles.into_iter().map(|h| h.join().expect("exec thread panicked")).collect()
            });
            for (id, res) in results {
                if let Some(n) = self.nodes.iter_mut().find(|x| x.id == id) {
                    n.status = "done".into();
                    n.body = res; // 결과 기록(칸반 result 로 emit)
                }
            }
        }
        rounds
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_siblings_all_ready() {
        // a, b 형제(blockedBy 없음) → 둘 다 즉시 준비.
        let dag = Dag::new(vec![
            TaskNode::new("a", None, &[], "todo"),
            TaskNode::new("b", None, &[], "todo"),
        ]);
        let mut r = dag.ready();
        r.sort();
        assert_eq!(r, vec!["a", "b"]);
    }

    #[test]
    fn pipeline_chain_gates() {
        // b.blockedBy=[a] → 처음엔 a 만, a done 후 b.
        let mut dag = Dag::new(vec![
            TaskNode::new("a", None, &[], "todo"),
            TaskNode::new("b", None, &["a"], "todo"),
        ]);
        assert_eq!(dag.ready(), vec!["a"]);
        dag.set_status("a", "done");
        assert_eq!(dag.ready(), vec!["b"]);
    }

    #[test]
    fn container_done_by_children() {
        // P{c1,c2} — 리프만 실행, 자식 전부 done 이면 P done.
        let mut dag = Dag::new(vec![
            TaskNode::new("P", None, &[], "todo"),
            TaskNode::new("c1", Some("P"), &[], "todo"),
            TaskNode::new("c2", Some("P"), &[], "todo"),
        ]);
        let mut r = dag.ready();
        r.sort();
        assert_eq!(r, vec!["c1", "c2"], "컨테이너 P 는 실행 대상 아님; 자식만");
        assert!(!dag.is_done("P"));
        dag.set_status("c1", "done");
        dag.set_status("c2", "done");
        assert!(dag.is_done("P"), "자식 전부 done → P 집계 done");
    }

    #[test]
    fn group_gate_inherited_by_children() {
        // P1{a}  →  P2{b} (P2.blockedBy=[P1]) : 그룹끼리만 blockedBy, 자식은 게이트 상속.
        let mut dag = Dag::new(vec![
            TaskNode::new("P1", None, &[], "todo"),
            TaskNode::new("a", Some("P1"), &[], "todo"),
            TaskNode::new("P2", None, &["P1"], "todo"),
            TaskNode::new("b", Some("P2"), &[], "todo"),
        ]);
        // 초기: a 만 준비(b 는 P2 게이트 = P1 미done 으로 막힘).
        assert_eq!(dag.ready(), vec!["a"], "b 는 부모 P2 의 blockedBy(P1) 상속으로 게이트됨");
        dag.set_status("a", "done"); // → P1 집계 done
        assert!(dag.is_done("P1"));
        assert_eq!(dag.ready(), vec!["b"], "P1 done → P2 게이트 풀림 → b 준비");
    }

    #[test]
    fn all_done_when_leaves_done() {
        let mut dag = Dag::new(vec![
            TaskNode::new("P", None, &[], "todo"),
            TaskNode::new("c", Some("P"), &[], "todo"),
        ]);
        assert!(!dag.all_done());
        dag.set_status("c", "done");
        assert!(dag.all_done());
    }

    #[test]
    fn run_chain_is_sequential() {
        use std::sync::Mutex;
        let mut dag = Dag::new(vec![
            TaskNode::new("a", None, &[], "todo"),
            TaskNode::new("b", None, &["a"], "todo"),
        ]);
        let order = Mutex::new(Vec::new());
        let rounds = dag.run(&|n| {
            order.lock().unwrap().push(n.id.clone());
            "r".into()
        });
        assert!(dag.all_done());
        assert_eq!(rounds, 2, "체인은 2 라운드(순차)");
        assert_eq!(*order.lock().unwrap(), vec!["a", "b"], "blockedBy 순서 존중");
    }

    #[test]
    fn run_parallel_is_single_round() {
        // 무게이트 형제 → 한 라운드에 동시 실행(진짜 병렬).
        let mut dag = Dag::new(vec![
            TaskNode::new("a", None, &[], "todo"),
            TaskNode::new("b", None, &[], "todo"),
            TaskNode::new("c", None, &[], "todo"),
        ]);
        let rounds = dag.run(&|_| "r".into());
        assert!(dag.all_done());
        assert_eq!(rounds, 1, "동시: 한 라운드에 모두");
    }

    #[test]
    fn run_group_gate_then_parallel() {
        // P1{a} → P2{b1,b2} (P2.blockedBy=[P1]) : a 먼저(라운드1), 그 다음 b1·b2 동시(라운드2).
        let mut dag = Dag::new(vec![
            TaskNode::new("P1", None, &[], "todo"),
            TaskNode::new("a", Some("P1"), &[], "todo"),
            TaskNode::new("P2", None, &["P1"], "todo"),
            TaskNode::new("b1", Some("P2"), &[], "todo"),
            TaskNode::new("b2", Some("P2"), &[], "todo"),
        ]);
        let rounds = dag.run(&|_| "r".into());
        assert!(dag.all_done());
        assert_eq!(rounds, 2, "그룹 순차(P1→P2) 후 P2 안은 동시 → 2 라운드");
    }

    #[test]
    fn run_results_recorded() {
        let mut dag = Dag::new(vec![TaskNode::new("a", None, &[], "todo")]);
        dag.run(&|n| format!("done:{}", n.id));
        assert_eq!(dag.get("a").unwrap().body, "done:a");
    }
}
