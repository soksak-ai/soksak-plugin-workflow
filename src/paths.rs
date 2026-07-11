//! 번들 경로 해석 — 사이드카 자기 트리(references/·workflows/) 발견. main.rs·wf_service 공용.

/// 번들 정본 workflow-doc 경로 — workflows/<name>.doc.json. 이름은 영숫자/-/_ 만.
pub fn bundled_workflow_path(name: &str) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("--workflow 이름 부적합: {name:?} (영숫자/-/_ 만)"));
    }
    let root = sidecar_root().ok_or("--workflow: 플러그인 루트 해석 실패(references/draft-skill.md 기준)")?;
    let p = root.join("workflows").join(format!("{name}.doc.json"));
    if !p.is_file() {
        return Err(format!("번들 워크플로 없음: {}", p.display()));
    }
    Ok(p.display().to_string())
}

/// sidecar_root — 이 바이너리가 속한 사이드카 루트(self-contained references/·workflows/ 소재).
/// current_exe 의 조상 중 `references/draft-skill.md` 를 가진 첫 디렉토리.
pub fn sidecar_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent();
    while let Some(d) = dir {
        if d.join("references/draft-skill.md").is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}
