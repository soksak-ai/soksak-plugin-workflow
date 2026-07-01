//! generate_skeleton — 아이디어 → gen.js(워크플로 JS 저작) → skeleton 파이프라인의 **순수 조립 로직**.
//! LLM 호출·파일 IO·node subprocess 는 main.rs(run_generate_skeleton)가 한다 — 여기는 프롬프트 조립 +
//! 펜스 strip 등 테스트 가능한 순수부만. 실행 워크플로는 gen.js(이 산출); draft.js 는 backup 비교물.

use crate::derive_directive::DomainDirective;

/// strip_js_fence — LLM 이 gen.js 를 코드펜스로 감쌌을 때 방어적으로 벗긴다.
/// ```js / ```javascript / ``` 등 첫 펜스 줄(언어 태그 포함)과 닫는 ``` 제거. 펜스 없으면 원문(trim).
/// draft-skill.md 계약은 "순수 JS 본문만"이나 모델이 펜스를 붙일 수 있어 방어적으로 처리.
pub fn strip_js_fence(raw: &str) -> String {
    let t = raw.trim();
    // 1) 코드펜스가 있으면(앞뒤 prose 무관) 첫 ``` … ``` 안 본문을 추출.
    if let Some(open) = t.find("```") {
        let after_open = &t[open + 3..];
        // 여는 펜스 줄의 언어 태그(js/javascript 등)를 버리고 다음 줄부터 본문.
        let after_lang = match after_open.find('\n') {
            Some(nl) => &after_open[nl + 1..],
            None => after_open,
        };
        // 닫는 펜스(다음 ```)까지가 본문. 없으면 끝까지(잘림 방지).
        let body = match after_lang.find("```") {
            Some(end) => &after_lang[..end],
            None => after_lang,
        };
        return body.trim().to_string();
    }
    // 2) 펜스 없이 코드 앞에 prose(설명)를 붙인 경우 — 파일은 `export const meta` 로 시작(계약).
    //    **줄 시작(또는 문서 시작)의 export 만 앵커** — LLM 이 prose 에서 인용한 `export const meta`(줄 중간,
    //    백틱/별표 뒤)에 속지 않게. 그 지점부터 슬라이스(선행 prose 제거). 없으면 원문 trim.
    let anchor = "export const meta";
    let mut from = 0;
    while let Some(rel) = t[from..].find(anchor) {
        let idx = from + rel;
        if idx == 0 || t.as_bytes()[idx - 1] == b'\n' {
            return t[idx..].trim().to_string();
        }
        from = idx + anchor.len();
    }
    t.to_string()
}

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

/// build_system_prompt — system 층: 범용 Workflow 저작 스킬(SKILL/api/patterns) + soksak draft 역할 지시어.
/// 재료 순서 = SKILL.md → api-reference.md → patterns.md → draft-skill.md. `---` 로 구분.
pub fn build_system_prompt(skill_md: &str, api_ref: &str, patterns: &str, draft_skill: &str) -> String {
    [skill_md, api_ref, patterns, draft_skill]
        .iter()
        .map(|s| s.trim())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(domain: &str, directive: &str, rationale: &str) -> DomainDirective {
        DomainDirective { id: "x".into(), directive: directive.into(), rationale: rationale.into(), domain: domain.into() }
    }

    #[test]
    fn strip_js_fence_no_fence_returns_trimmed() {
        assert_eq!(strip_js_fence("  export const meta = {}  "), "export const meta = {}");
    }

    #[test]
    fn strip_js_fence_strips_js_and_javascript_and_bare() {
        let body = "export const meta = { name: 'x' }\nphase('A')";
        for open in ["```js", "```javascript", "```", "```JS"] {
            let wrapped = format!("{open}\n{body}\n```");
            assert_eq!(strip_js_fence(&wrapped), body, "fence {open:?} 벗김 실패");
        }
    }

    #[test]
    fn strip_js_fence_with_prose_around_fence() {
        // 모델이 펜스 앞뒤로 설명을 붙여도 첫 펜스 안 본문만 추출(find-anywhere).
        let wrapped = "여기 코드입니다:\n```js\nconst a = 1\n```\n이상입니다.";
        assert_eq!(strip_js_fence(wrapped), "const a = 1");
    }

    #[test]
    fn strip_js_fence_leading_prose_no_fence_export_anchor() {
        // 펜스 없이 코드 앞에 설명(한국어 등)이 붙으면 export const meta 부터 슬라이스(선행 prose 제거).
        let raw = "이 워크플로는 다음과 같습니다:\n\nexport const meta = { name: 'x' }\nphase('A')";
        assert_eq!(strip_js_fence(raw), "export const meta = { name: 'x' }\nphase('A')");
    }

    #[test]
    fn strip_js_fence_ignores_prose_quoted_export_anchor() {
        // LLM 이 prose 에서 `export const meta`(줄 중간, 백틱 뒤)를 인용해도 — 실제 코드(줄 시작 export)를 앵커.
        let raw = "파일은 반드시 `export const meta` 로 시작해야 합니다.\n\nexport const meta = { name: 'x' }\nphase('A')";
        assert_eq!(strip_js_fence(raw), "export const meta = { name: 'x' }\nphase('A')");
    }

    #[test]
    fn strip_js_fence_unclosed_fence_takes_rest() {
        // 닫는 ``` 누락 시 여는 펜스 뒤 전부(잘림 방지).
        assert_eq!(strip_js_fence("```js\nconst a = 1"), "const a = 1");
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

    #[test]
    fn build_system_prompt_joins_all_four_in_order() {
        let sys = build_system_prompt("SKILL_BODY", "API_BODY", "PATTERNS_BODY", "DRAFT_SKILL_BODY");
        for part in ["SKILL_BODY", "API_BODY", "PATTERNS_BODY", "DRAFT_SKILL_BODY"] {
            assert!(sys.contains(part), "{part} 누락");
        }
        // 순서: 스킬이 draft 역할 지시어보다 앞.
        assert!(sys.find("SKILL_BODY").unwrap() < sys.find("DRAFT_SKILL_BODY").unwrap(), "SKILL 이 draft-skill 앞");
        assert!(sys.contains("---"), "재료 구분자");
    }
}
