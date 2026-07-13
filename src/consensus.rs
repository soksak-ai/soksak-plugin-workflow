//! consensus — 재사용 합의 루프의 순수 핵심. 완전성/정확성은 조각(hunt·audit·per-item·렌즈)이 아니라
//! **하나의 자율 루프**다: 한 집합을 놓고 각 라운드 reviewer 가 [현재 집합 + 변경 히스토리] 를 보고 **더하거나
//! (add) 뺀다(remove)**. 아무도 이견 없을 때(변경 0)까지 반복. 목적 = 3자(사람) 개입 없이 스스로 교정·종료.
//!
//! 세 요소가 없으면 사람을 부르게 된다:
//!   1. remove — 잘못 든 것을 루프가 스스로 걷어냄(add 전용은 자기교정 불가).
//!   2. 변경 히스토리 — "무엇을·왜 add/remove 했나"를 다음 라운드에 주입 → 재론·진동(remove→re-add) 차단.
//!   3. 이견 0 수렴 — add·remove 둘 다 0 = 합의 = 종료.
//!
//! 이 모듈은 순수(reviewer 산출 → 적용 결정)다. 이벤트 발행·badge 편집·다음 라운드 발행은 reconcile 이
//! 이 결과로 수행한다. draft·research·design·plan 네 완전성 지점이 같은 루프를 재사용한다.

use serde_json::Value;

/// 한 라운드 reviewer 산출을 적용한 결과.
#[derive(Debug, PartialEq)]
pub struct ReviewOutcome {
    /// 신규 항목(그대로 발행 — badge=검수전 또는 파생물이면 o).
    pub additions: Vec<Value>,
    /// 자기교정: (targetId, reason) — 대상 항목 badge → x(반박·중복·범위밖). 삭제 아님(이력·감사 보존).
    pub badge_edits: Vec<(String, String)>,
    /// 이 라운드 변경 요약 — 다음 라운드 프롬프트의 {{history}} 로 주입(진동 차단).
    pub history_lines: Vec<String>,
    /// add·remove 둘 다 0 = 이견 없음 = 합의 = 다음 스테이지로.
    pub converged: bool,
}

/// apply_review — 순수. reviewer 의 {additions, removals} + 라운드 번호 → ReviewOutcome.
/// additions = 신규 항목 배열. removals = [{id, reason}] 배열. id 빈 remove 는 무시(방어).
pub fn apply_review(review: &Value, round: u32) -> ReviewOutcome {
    let additions: Vec<Value> = review
        .get("additions")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let removals: Vec<Value> = review
        .get("removals")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    let mut badge_edits = Vec::new();
    let mut history_lines = Vec::new();
    for a in &additions {
        if let Some(t) = a.get("title").and_then(|t| t.as_str()) {
            history_lines.push(format!("R{round} +add: {t}"));
        }
    }
    for r in &removals {
        let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let reason = r.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();
        history_lines.push(format!("R{round} -remove {id}: {reason}"));
        badge_edits.push((id, reason));
    }

    let converged = additions.is_empty() && badge_edits.is_empty();
    ReviewOutcome { additions, badge_edits, history_lines, converged }
}

/// render_history — 누적 히스토리 줄들을 다음 라운드 프롬프트 주입용 블록으로. 비면 빈 문자열.
/// reviewer 는 이걸 보고 "이미 뺀 걸 도로 넣지" 않고, "이미 논의된 걸 재론" 하지 않는다.
pub fn render_history(lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let body = lines.join("\n");
    format!("변경 이력(이미 add/remove 된 것 — 재론·되돌림 금지):\n{body}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn add_and_remove_produces_edits_and_history() {
        let review = json!({
            "additions": [{ "title": "누락: 캐시·세션 전략", "description": "..." }],
            "removals": [{ "id": "fact3", "reason": "지시서가 명시적으로 배제한 범위 — 범위밖" }]
        });
        let out = apply_review(&review, 2);
        assert_eq!(out.additions.len(), 1, "add 1");
        assert_eq!(out.badge_edits, vec![("fact3".to_string(), "지시서가 명시적으로 배제한 범위 — 범위밖".to_string())], "remove → badge 편집(자기교정)");
        assert!(!out.converged, "변경 있으면 미수렴");
        assert!(out.history_lines.iter().any(|l| l.contains("+add")), "add 이력: {:?}", out.history_lines);
        assert!(out.history_lines.iter().any(|l| l.contains("-remove fact3")), "remove 이력(사유 포함): {:?}", out.history_lines);
    }

    #[test]
    fn no_change_is_consensus() {
        let out = apply_review(&json!({ "additions": [], "removals": [] }), 3);
        assert!(out.converged, "add·remove 0 = 이견 없음 = 합의(종료)");
        assert!(out.history_lines.is_empty());
    }

    #[test]
    fn add_only_not_yet_converged() {
        // add 만 있어도 이견 있음 → 미수렴(다음 라운드가 그 add 를 remove 할 수도).
        let out = apply_review(&json!({ "additions": [{ "title": "X" }] }), 1);
        assert!(!out.converged, "add 만 있어도 미수렴");
        assert!(out.badge_edits.is_empty());
    }

    #[test]
    fn remove_only_not_converged() {
        let out = apply_review(&json!({ "removals": [{ "id": "i5", "reason": "umbrella" }] }), 1);
        assert!(!out.converged, "remove 만 있어도 미수렴");
        assert_eq!(out.badge_edits.len(), 1);
    }

    #[test]
    fn empty_id_removal_ignored() {
        let out = apply_review(&json!({ "removals": [{ "id": "", "reason": "x" }, { "id": "i1", "reason": "y" }] }), 1);
        assert_eq!(out.badge_edits, vec![("i1".to_string(), "y".to_string())], "빈 id remove 무시(방어)");
    }

    #[test]
    fn history_renders_or_empty() {
        assert_eq!(render_history(&[]), "", "히스토리 없으면 빈 문자열");
        let r = render_history(&["R1 +add: A".to_string(), "R2 -remove i2: dup".to_string()]);
        assert!(r.contains("변경 이력") && r.contains("R1 +add: A") && r.contains("R2 -remove i2"), "{r}");
    }
}
