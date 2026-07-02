//! generate_skeleton — 아이디어 → workflow-doc(LLM 저작) 파이프라인의 **순수 프롬프트 조립**.
//! LLM 호출·검증 게이트(parse_json_lenient + doc_exec::validate)는 main.rs(run_generate_skeleton)가 한다.
//! (JS 저작 시절의 strip_js_fence 는 doc 단일화(M5e)로 제거 — 관용 JSON 파싱이 그 방어를 대체.)

use crate::derive_directive::DomainDirective;

/// build_user_prompt — user 층 프롬프트: 사용자 아이디어(DIRECTIVE) + ③파생 도메인 지시어(있으면).
/// 도메인 지시어는 gen.js 저작 LLM 에 "이 도메인 make-or-break 힌트"로 제공(강제 아님 — 참고).
pub fn build_user_prompt(idea: &str, directives: &[DomainDirective]) -> String {
    let mut s = String::new();
    s.push_str("# 사용자 아이디어 (DIRECTIVE)\n");
    s.push_str(idea.trim());
    s.push('\n');
    if !directives.is_empty() {
        s.push_str("\n# ③파생 도메인 지시어 (참고 — 이 도메인의 make-or-break 힌트, 강제 아님)\n");
        for d in directives {
            s.push_str(&format!("- [{}] {} — {}\n", d.domain, d.directive, d.rationale));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(domain: &str, directive: &str, rationale: &str) -> DomainDirective {
        DomainDirective { id: "x".into(), directive: directive.into(), rationale: rationale.into(), domain: domain.into() }
    }

    #[test]
    fn build_user_prompt_includes_idea() {
        let p = build_user_prompt("  약국 재고 SaaS  ", &[]);
        assert!(p.contains("약국 재고 SaaS"), "아이디어 포함");
        assert!(p.contains("DIRECTIVE"), "DIRECTIVE 헤더");
        assert!(!p.contains("③파생"), "지시어 없으면 파생 섹션 없음");
    }

    #[test]
    fn build_user_prompt_lists_directives() {
        let ds = [
            dir("SYSTEM", "운영자 콘솔을 권한 등급별로", "권한 오남용 make-or-break"),
            dir("LEGAL", "마약류 재고 불일치 시 기한 내 신고", "마약류관리법 의무"),
        ];
        let p = build_user_prompt("약국 SaaS", &ds);
        assert!(p.contains("③파생"), "지시어 섹션 헤더");
        assert!(p.contains("[SYSTEM] 운영자 콘솔을 권한 등급별로 — 권한 오남용 make-or-break"));
        assert!(p.contains("[LEGAL] 마약류 재고 불일치 시 기한 내 신고 — 마약류관리법 의무"));
    }


}
