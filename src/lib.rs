//! soksak-plugin — 워크플로 골격(추출기 추출) 실행 런타임.
//! 골격을 읽어 steps 를 실행하고, agent 는 claude -p(인증 프로필 GLM) 로 위임한다.
//! 레거시(server2 upstream:// 계약) 포팅 아님 — 골격을 단일 진실로 해석·실행한다.

pub mod derive_directive;
pub mod domain_lib;
pub mod exec;
pub mod interp;
pub mod provider;
pub mod skeleton;
