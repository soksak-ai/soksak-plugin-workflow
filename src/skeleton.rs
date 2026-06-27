//! skeleton — 추출기 워크플로 골격(workflow.json) 의 serde 모델.
//! 공개 계약 = workflow-skeleton@1. 런타임이 읽어 실행한다. 미지 필드는 무시(전향 호환).

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
pub struct Skeleton {
    pub meta: Meta,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub directives: Vec<Directive>,
    #[serde(default)]
    pub schemas: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Meta {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Directive {
    pub index: usize,
    pub text: String,
    #[serde(default)]
    pub placeholders: Vec<String>,
    // "static" 필드(예약어)는 런타임 미사용 — serde 가 무시(미매핑).
}

#[derive(Debug, Clone, Deserialize)]
pub struct Step {
    pub index: usize,
    pub kind: String,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "directiveRef")]
    pub directive_ref: Option<usize>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub stages: Option<usize>,
    #[serde(default)]
    pub axis: Option<String>,
    #[serde(default, rename = "itemParam")]
    pub item_param: Option<String>,
    #[serde(default)]
    pub agents: Option<Vec<Agent>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Agent {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default, rename = "directiveRef")]
    pub directive_ref: Option<usize>,
}

impl Skeleton {
    pub fn from_json(raw: &[u8]) -> Result<Skeleton, String> {
        serde_json::from_slice(raw).map_err(|e| format!("parse skeleton: {e}"))
    }

    /// directive 텍스트 조회.
    pub fn directive_text(&self, idx: Option<usize>) -> Option<&str> {
        idx.and_then(|i| self.directives.get(i)).map(|d| d.text.as_str())
    }

    /// schema 본문 조회.
    pub fn schema_body(&self, name: &Option<String>) -> Option<&Value> {
        name.as_ref().and_then(|n| self.schemas.get(n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn loads_minimal_skeleton() {
        let raw = serde_json::to_vec(&json!({
            "ir": "workflow-skeleton@1",
            "meta": { "name": "demo" },
            "steps": [
                { "index": 0, "kind": "phase", "phase": "A", "title": "A" },
                { "index": 1, "kind": "agent", "label": "scope", "schema": "SCOPE_SCHEMA", "directiveRef": 0, "phase": "A" }
            ],
            "directives": [{ "index": 0, "text": "Decompose ${QUESTION}", "static": false, "placeholders": ["QUESTION"] }],
            "schemas": { "SCOPE_SCHEMA": { "type": "object", "properties": { "angles": { "type": "array" } } } }
        }))
        .unwrap();
        let skel = Skeleton::from_json(&raw).unwrap();
        assert_eq!(skel.meta.name, "demo");
        assert_eq!(skel.steps.len(), 2);
        let agent = &skel.steps[1];
        assert_eq!(agent.kind, "agent");
        assert_eq!(agent.directive_ref, Some(0));
        assert_eq!(skel.directive_text(agent.directive_ref), Some("Decompose ${QUESTION}"));
        assert!(skel.schema_body(&agent.schema).is_some());
    }
}
