//! soksak-plugin — workflow-doc@0.0.1(언어중립 JSON 워크플로 문서) 실행 런타임.
//! 문서를 stage 별로 실행하고(doc_exec), agent 는 claude -p 로 위임한다(provider).
//! 발행 wire = NodeEvent(emit_host), generate 산출 = DraftDoc(draft_doc, validator 인증).
//! 레거시 interp(ESTree)/skeleton 경로는 backup/legacy-interp/ 에 보존(M5e).

pub mod consensus;
pub mod derive_directive;
pub mod directive_loop;
pub mod doc_exec;
pub mod draft_doc;
pub mod domain_lib;
pub mod exec_one;
pub mod generate_skeleton;
pub mod host;
pub mod lang;
pub mod provider;
pub mod paths;
pub mod reconcile;
pub mod wf_service;
pub mod emit_host;
