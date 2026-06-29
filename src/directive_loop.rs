//! directive_loop — 한 줄 지시 → 검증된 기능정의 스펙. run_loop 드라이버가 4 기능을 오케스트레이션:
//!   생성기능(초기 주제, broad) → [검증기능(공백 검증+누락제안, grounded) ↔ 결정기능(승격·수렴, broad)] → 렌더기능.
//!   누락은 검증기능이 제안 → 결정기능이 승격. 파일(주제 목록)이 단일 진실. loop-until-dry. 모든 호출 = claude -p.
//!   원칙: (1) 모든 상태 전이에 사유 (2) 파일은 영속·재사용(누적).

use crate::provider::{parse_json_lenient, run_agent_text, AgentRequest};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

pub const BLANK: &str = "공백";
pub const OK: &str = "[o]";
pub const FAIL: &str = "[x]";

/// 한 검증기능 콜이 다루는 공백 주제 수. 0=무한대(한 콜). 단 25-50개는 900s 타임아웃이라 적정값으로.
const BATCH: usize = 12;
/// 검증기능 콜 사이 쿨다운(초). real Anthropic 은 최소.
const COOLDOWN: u64 = 2;

/// COMMON — 생성·검증·결정이 공유하는 개념(1회 정의, 중복 제거). 각 역할 프롬프트에 prepend.
const COMMON: &str = r#"SHARED CONCEPTS:
- A REQUIREMENT = an imperative the result must satisfy ("the system/plan/novel/work must …"): concrete and developable/executable — NOT a background fact, NOT a restatement of the directive. (Form: not "X regulations" but "the system must DO <Y> to satisfy <X>".)
- MAKE-OR-BREAK = its absence would make the result FAIL or be WRONG, not merely less polished. (A nice-to-have, or one methodology's enumerated beat-list, is NOT a requirement.)
- THE BACK-SIDE: the requester is NOT a domain expert — they named the visible SURFACE (the easy 80%) and, even in a DETAILED directive, omit the make-or-break BACK-SIDE (the 20% that decides success) a senior practitioner / law / safety requires for the intent to actually work, be legal, be safe (the administrative, legal, financial, safety, contingency/failure-handling, oversight/who-administers substrate). DRAW IT OUT — adversarially ask of THIS intent: who actually OPERATES it, OVERSEES/administers it, PAYS FOR it, is kept SAFE/legal by it, and RECOVERS it when it fails or ends — and what does each REQUIRE that the requester never said? Don't be seduced by a polished, plausible surface: that polish IS the 80% trap. Then use the per-domain SHAPES below — the KIND to hunt; they COMPLEMENT the questions above (a minimal domain hint), never REPLACE them, and are NOT answers (search the real content; apply ONLY what genuinely fits THIS directive, never force a non-applicable category):
    · SYSTEM → operator/admin console per permission grade & oversight, data model, regulation, security boundaries, monitoring, lifecycle/offboarding.
    · NOVEL → the avenger's corrosion, justice-vs-vengeance, antagonist depth, the delay engine, the payoff, the aftermath, POV/reveal-order, setting/world, reader complicity.
    · PLAN → go/no-go gates, per-step verification, contingency/rollback, failure modes, legal/safety preconditions, responsibility, exit criteria.
    · EVERYDAY (e.g. moving house) → registration, deposit/fee settlement, address changes, defect-check — not just the visible act.
- LEGAL LENS: if the intent operates under law or regulation (it handles regulated goods/persons/money/data, needs official approval or a license, or carries statutory duties), examine it ALSO from the COMPLIANCE perspective — surface the binding legal obligations, approvals, triggers, and deadlines the real, current law actually compels (search it), not just the functional surface. Apply ONLY where the intent genuinely has legal requirements; never force it onto one that has none.
- INVARIANTS — every requirement, whether GENERATED or ADDED: (1) ATOMIC — one subject, not bundled, not over-split; (2) NO DUPLICATE — not a restatement of another; (3) NO FORCING/FABRICATION — a genuine grounded make-or-break, never invented to seem thorough."#;

/// Attempt — 한 라운드의 검증 시도(과정 한 단계). 사유 필수.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Attempt {
    pub round: u32,
    pub status: String, // [o] | [x]
    pub reason: String, // 성공: 어떻게·왜 / 실패: 왜·무엇 보완
    #[serde(default)]
    pub verified_value: String,
}

/// Topic — 검증 단위(주제). status 는 history 마지막 attempt 에서 도출.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Topic {
    pub id: String,
    pub subject: String, // 주제
    #[serde(default = "mk_or_break")]
    pub severity: String, // make_or_break | optional
    pub status: String,   // 공백 | [o] | [x]
    #[serde(default)]
    pub verified_value: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub version: u32, // 값 바뀐 횟수(교정마다 +1)
    #[serde(default)]
    pub verify_count: u32, // 검증기능이 이 주제를 검증한 횟수 — 하버스가 셈(LLM 아님). history 의 검증외 이벤트 제외.
    #[serde(default)]
    pub history: Vec<Attempt>,
}
fn mk_or_break() -> String {
    "make_or_break".into()
}

/// Ledger — 주제 목록(파일 = 단일 진실).
pub struct Ledger {
    pub path: PathBuf,
    pub topics: Vec<Topic>,
}
impl Ledger {
    pub fn load(path: PathBuf) -> Ledger {
        let topics = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Topic>>(&b).ok())
            .unwrap_or_default();
        Ledger { path, topics }
    }
    pub fn save(&self) -> Result<(), String> {
        let j = serde_json::to_string_pretty(&self.topics).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, j).map_err(|e| format!("ledger write {}: {e}", self.path.display()))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoundLog {
    pub round: u32,
    pub verified: usize,
    pub failed: usize,
    pub promoted: usize,
    pub decision: String,
    pub reason: String,
}

/// Outcome — 루프 산출.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub directive: String,
    pub spec: String,
    pub topics: Vec<Topic>,
    pub log: Vec<RoundLog>,
    pub converged: bool,
    pub aborted: bool,
    pub abort_reason: String,
    pub rounds: u32,
}

pub struct LoopConfig {
    pub agent_env: Vec<(String, String)>,
    pub verifier_model: String, // 집중 검증 — 가벼운 모델(glm-5.1=sonnet) 권장
    pub exec_model: String,     // broad 추론(생성·승격·결정·렌더) — glm-5.2=opus
    pub max_rounds: u32,
}

// === 에이전트 산출 파싱 구조 ===

#[derive(Deserialize)]
struct GenTopic {
    id: String,
    subject: String,
    #[serde(default = "mk_or_break")]
    severity: String,
}
#[derive(Deserialize)]
struct GenResult {
    topics: Vec<GenTopic>,
}

#[derive(Deserialize)]
struct Verification {
    id: String,
    status: String, // [o] | [x]
    #[serde(default)]
    reason: String,
    #[serde(default)]
    verified_value: String,
    #[serde(default)]
    sources: Vec<String>,
}
#[derive(Deserialize)]
struct Addition {
    subject: String,
    #[serde(default = "mk_or_break")]
    severity: String,
    #[serde(default)]
    reason: String,
}
#[derive(Deserialize)]
struct VerifyResult {
    #[serde(default)]
    verifications: Vec<Verification>,
    #[serde(default)]
    additions: Vec<Addition>,
}

#[derive(Deserialize)]
struct Promote {
    id: String,
    subject: String,
    #[serde(default = "mk_or_break")]
    severity: String,
}
#[derive(Deserialize)]
struct Refine {
    id: String,
    new_subject: String,
    #[serde(default)]
    reason: String,
}
#[derive(Deserialize)]
struct JudgeResult {
    #[serde(default)]
    promote: Vec<Promote>,
    #[serde(default)]
    refine: Vec<Refine>,
    decision: String, // continue | converge | abort
    #[serde(default)]
    reason: String,
}

// === 검증 게이트 (순수함수) ===

/// validate_ledger — 각 주제 status 가 history 마지막 attempt 와 일치하는지.
/// 불일치는 기계적으로 [x] 강등(주장된 [o] 불신) + 사유. 자가치유. 강등된 id 반환.
pub fn validate_ledger(topics: &mut [Topic], round: u32) -> Vec<String> {
    let mut downgraded = vec![];
    for t in topics.iter_mut() {
        if t.status == BLANK {
            continue; // 아직 검증 안 함 — 정상.
        }
        let consistent = matches!(t.history.last(), Some(a) if a.status == t.status);
        if !consistent {
            let reason = format!("status({})↔history 불일치 — 미검증 처리", t.status);
            t.history.push(Attempt { round, status: FAIL.into(), reason, verified_value: String::new() });
            t.status = FAIL.into();
            downgraded.push(t.id.clone());
        }
    }
    downgraded
}

// === 에이전트 호출 ===

/// call_json — 에이전트 호출 + 파싱. 529/timeout/파싱실패는 백오프 재시도(인프라 실패는 [x] 아님).
fn call_json<T: DeserializeOwned>(prompt: String, tools: Vec<String>, model: &str, cfg: &LoopConfig) -> Result<T, String> {
    let mut last = String::new();
    for attempt in 0u64..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(COOLDOWN * attempt)); // 백오프 — 레이트리밋 쿨다운.
            eprintln!("  [재시도 {attempt}/2: {}]", last.chars().take(80).collect::<String>());
        }
        match run_agent_text(&AgentRequest { prompt: prompt.clone(), model, allowed_tools: tools.clone() }, &cfg.agent_env) {
            Ok(text) => match parse_as::<T>(&text) {
                Ok(t) => return Ok(t),
                Err(e) => last = e,
            },
            Err(e) => last = e, // 529/timeout 등 — 재시도.
        }
    }
    Err(format!("call_json 3회 실패: {last}"))
}

/// parse_as — 산출 텍스트에서 T 로 역직렬화. 전체 lenient → 실패 시 top-level 객체 스캔.
fn parse_as<T: DeserializeOwned>(text: &str) -> Result<T, String> {
    if let Ok(v) = parse_json_lenient(text) {
        if let Ok(t) = serde_json::from_value::<T>(v) {
            return Ok(t);
        }
    }
    for obj in top_level_objects(text) {
        if let Ok(t) = serde_json::from_str::<T>(&obj) {
            return Ok(t);
        }
    }
    Err(format!("산출 파싱 실패({}); head={}", std::any::type_name::<T>(), text.chars().take(300).collect::<String>()))
}

fn top_level_objects(s: &str) -> Vec<String> {
    let bytes = s.as_bytes();
    let mut out = vec![];
    let mut depth = 0i32;
    let mut start: Option<usize> = None;
    let mut in_str = false;
    let mut esc = false;
    for (i, &b) in bytes.iter().enumerate() {
        let c = b as char;
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(st) = start.take() {
                        out.push(s[st..=i].to_string());
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// ledger_view — 에이전트 프롬프트용 원장 요약(history 전량 대신 핵심).
fn ledger_view(topics: &[Topic]) -> String {
    let mut s = String::new();
    for t in topics {
        let last = t.history.last().map(|a| a.reason.as_str()).unwrap_or("");
        s.push_str(&format!(
            "- id={} | status={} | sev={} | 주제: {}{}{}\n",
            t.id,
            t.status,
            t.severity,
            t.subject,
            if t.verified_value.is_empty() { String::new() } else { format!(" | 값: {}", t.verified_value) },
            if last.is_empty() { String::new() } else { format!(" | 최근: {}", last.chars().take(80).collect::<String>()) },
        ));
    }
    s
}

// === 기능: 생성·검증·결정·렌더 ===

/// 생성기능 — 지시 → 초기 주제(공백) 분해. broad seed, 비슷한 건 한 주제로. 도구 off.
fn exec_generate(directive: &str, cfg: &LoopConfig) -> Result<Vec<Topic>, String> {
    let prompt = format!(
        r#"{COMMON}

YOUR ROLE — GENERATOR: turn the directive into the full set of REQUIREMENTS (per SHARED CONCEPTS).

**GENERATION IS GENEROUS — cast WIDE.** Include EVERY plausible make-or-break (content, structural/craft, operational, regulated, the back-side). Generosity is SAFE here: the verifier grounds each and rejects ([x]) any that does not hold — so it is better to slightly OVER-include than to miss one. No cap, no stinginess; this set must be COMPLETE (a novel: POV/reveal-order AND setting/world, not only theme; a system: the data model, the operator back-side, regulation). Tightness belongs to the verifier's later ADDITIONS — NOT here. Obey the INVARIANTS.

Directive: "{directive}"

Return ONLY JSON, no prose:
{{"topics":[{{"id":"<short-kebab-slug>","subject":"<one imperative requirement>","severity":"make_or_break"|"optional"}}]}}"#,
        COMMON = COMMON,
        directive = directive
    );
    let r: GenResult = call_json(prompt, vec![], &cfg.exec_model, cfg)?;
    Ok(r
        .topics
        .into_iter()
        .map(|g| Topic {
            id: g.id,
            subject: g.subject,
            severity: g.severity,
            status: BLANK.into(),
            verified_value: String::new(),
            sources: vec![],
            version: 0,
            verify_count: 0,
            history: vec![],
        })
        .collect())
}

/// 검증기능 — 공백 주제 전체를 grounded·domain-aware 로 검증 + 누락 추가요청. WebSearch on.
fn exec_verify(directive: &str, batch: &[Topic], all: &[Topic], cfg: &LoopConfig) -> Result<VerifyResult, String> {
    let to_verify = batch
        .iter()
        .map(|t| format!("- id={} | severity={} | 주제: {}", t.id, t.severity, t.subject))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        r#"{COMMON}

YOUR ROLE — VERIFIER (hostile). Verify each requirement by the RIGHT method — search is NOT mandatory (see A). For EXTERNAL FACTS use WebSearch and NEVER assert them from memory; reason out design/self-evident requirements.

(A) VERIFY each requirement listed below (touch no others):
{to_verify}
For each, pick the verification METHOD by the real test — **could you be WRONG from memory?** (not the category; search is NOT mandatory):
- You COULD be wrong: info beyond your knowledge cutoff (a recent event, the CURRENT/latest status of a law/program/standard — which may have changed since you were trained), OR the SPECIFICS of a named fact/standard/methodology/framework you could misremember (a statute/article, figure, named system, e.g. what "Save the Cat" or a regulation actually prescribes), OR you are genuinely UNSURE → **WebSearch** (DO put the current year in the query for fresh results; do NOT assert such specifics from memory). verified_value = fact + source.
- You RELIABLY know it: a general principle or common design/engineering/craft choice (optimistic locking, transactional consistency, RBAC, a story needs a climax) → **verify by REASONING** (necessary AND sound for the intent?). Do NOT web-search what you reliably know — it's wasteful. verified_value = why it is required/sound.
Then: verified → "{OK}" + verified_value(WHAT + WHY) + sources(only if searched) + reason. Wrong/unnecessary → "{FAIL}" + reason.
"{FAIL}" ≠ a failed search: if a NEEDED WebSearch ERRORS/empty (529), OMIT that topic (retry) — do NOT "{FAIL}". Terse; search ONLY the fact-hinged ones, reason out the rest.

(B) CERTIFY THE WHOLE, not the parts. A part-by-part "{OK}" does NOT mean the result works — certify the ASSEMBLED set delivers the goal. The generator is an LLM; DISTRUST the list. Run ALL FOUR checks below before you may converge; request what each surfaces (→ additions). Do NOT converge until all four are checked and clean:
  - GOAL-REACH: DO state, in your reasoning, what the result must ACHIEVE for the requester beneath the surface, then check the ledger actually reaches it. Do NOT treat a "{OK}" substrate as proof the goal is reachable — if the core outcome rests on an impossible or unverified premise, VERIFY the premise (search if external) and request the feasibility precondition. Never assume the premise holds.
  - CONTRADICTION: DO mentally BUILD/EXECUTE the whole toward that goal. Where two requirements conflict so a builder is BLOCKED until one is overruled, request the requirement that RESOLVES which wins.
  - SEAM: where the JOIN between two requirements is owned by neither and a builder must GUESS a make-or-break decision (two competent builders would split), request the rule that OWNS the join.
  - DEPTH: for any regulated or named requirement, request the binding obligation/trigger it IMPLIES but never states (the law/standard the named thing actually compels).
Do NOT request nice-to-haves. Do NOT re-request what the ledger already covers — judge by MEANING, not wording: a narrower / re-angled / renamed / split version of an existing requirement is NOT new; drop it. Do NOT rationalize ("looks complete" / "probably enough").
Do NOT DECOMPOSE a requirement into its implementation beats. A sub-mechanism a competent builder would naturally build AS PART OF an existing requirement (the HOW of it) is ALREADY covered — it belongs to that topic, NOT a new one. Request ONLY a make-or-break that omitting makes the result WRONG AND that two competent builders would resolve DIFFERENTLY (a real decision/divergence), never the HOW of a topic already present. A cascade of ever-finer sub-requirements off one theme (record → that record's tamper-proofing → that record's retention → …) is the over-enumeration smell: STOP and fold them into the parent.
Each request grounded + ATOMIC (INVARIANTS). Do NOT manufacture or stretch a gap to seem thorough — ZERO additions is the correct, expected answer for a complete ledger, not a failure; a forced requirement is worse than none. Converge — request NOTHING — ONLY after GOAL-REACH, CONTRADICTION, SEAM, DEPTH are all checked and clean. Over-enumeration is failure; premature convergence is betrayal.

Full ledger (context — do NOT verify these; judge whether they SUFFICE):
{ledger}

Directive: "{directive}"

Do any needed searches first (only the fact-hinged ones). FINAL message = ONLY this JSON (no prose/fence):
{{"verifications":[{{"id":"...","status":"{OK}"|"{FAIL}","reason":"...","verified_value":"...","sources":["..."]}}],"additions":[{{"subject":"...","severity":"make_or_break"|"optional","reason":"..."}}]}}"#,
        COMMON = COMMON,
        OK = OK,
        FAIL = FAIL,
        to_verify = to_verify,
        ledger = ledger_view(all),
        directive = directive
    );
    call_json(prompt, vec!["WebSearch".into(), "WebFetch".into()], &cfg.verifier_model, cfg)
}

/// 결정기능 — 추가요청 승격 + [x] 보완/종료 + 결정. 도구 off.
fn exec_decide(directive: &str, topics: &[Topic], additions: &[Addition], cfg: &LoopConfig) -> Result<JudgeResult, String> {
    let adds = additions
        .iter()
        .enumerate()
        .map(|(i, a)| format!("{}. [{}] {} — {}", i, a.severity, a.subject, a.reason))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        r#"{COMMON}

YOUR ROLE — JUDGE (orchestrator, BROAD view: you see all topics; the verifier saw a batch).
- promote: which addition requests become NEW topics — apply the INVARIANTS (ATOMIC; DEDUPE against the ledger; make-or-break only). Assign a short kebab id.
- refine: for "{FAIL}" topics that are SUPPLEMENTABLE, give a clearer subject (it returns to blank and is re-verified; use the failure reason).
- decision: "converge" if every make_or_break is "{OK}" and no new promotions; "abort" if the directive is nonsensical (meaningless/self-contradictory/impossible premise) OR a make_or_break is fundamentally unverifiable and fatal (a negative-but-verified conclusion is NOT abort); else "continue".

Directive: "{directive}"
Ledger:
{ledger}
Addition requests:
{adds}

Return ONLY JSON, no prose:
{{"promote":[{{"id":"<slug>","subject":"...","severity":"make_or_break"|"optional"}}],"refine":[{{"id":"<existing-id>","new_subject":"...","reason":"..."}}],"decision":"continue"|"converge"|"abort","reason":"..."}}"#,
        COMMON = COMMON,
        FAIL = FAIL,
        OK = OK,
        directive = directive,
        ledger = ledger_view(topics),
        adds = if adds.is_empty() { "(none)".into() } else { adds }
    );
    call_json(prompt, vec![], &cfg.exec_model, cfg)
}

/// 렌더기능 — [o] 주제들 → 기능정의 스펙(마크다운). 도구 off.
fn exec_render(directive: &str, topics: &[Topic], cfg: &LoopConfig) -> Result<String, String> {
    let prompt = format!(
        r#"You are the orchestrator. The ledger's "{OK}" topics are the VERIFIED requirements. Render the final one-direction functional-definition spec as markdown. Use plain, correct labels — no buzzwords:
- Objective: ONE sentence — what "done well" means for whoever the result serves, at the OUTCOME level (surface absent).
- The verified requirements, organized (group what belongs together). Tie each to the Objective.
- Order of Work: foundations first.
- Flag any remaining "{FAIL}" topics as "검증 불가 — 가정 X 로 진행".

Directive: "{directive}"
Ledger:
{ledger}

Output ONLY the spec markdown."#,
        OK = OK,
        FAIL = FAIL,
        directive = directive,
        ledger = ledger_view(topics)
    );
    run_agent_text(&AgentRequest { prompt, model: &cfg.exec_model, allowed_tools: vec![] }, &cfg.agent_env)
}

// === 적용 함수 ===

fn apply_verifications(topics: &mut [Topic], vs: &[Verification], round: u32) {
    for v in vs {
        if let Some(t) = topics.iter_mut().find(|t| t.id == v.id) {
            if t.status == OK {
                continue; // [o]는 안 건드림.
            }
            t.verify_count += 1; // 하버스(util)가 검증 횟수를 정확히 셈 — LLM 아님.
            let status = if v.status == OK { OK } else { FAIL };
            // 교정: 이미 값이 있었는데 다른 값으로 [o] → version++.
            if status == OK && !t.verified_value.is_empty() && t.verified_value != v.verified_value {
                t.version += 1;
            }
            t.history.push(Attempt {
                round,
                status: status.into(),
                reason: v.reason.clone(),
                verified_value: v.verified_value.clone(),
            });
            t.status = status.into();
            if status == OK {
                t.verified_value = v.verified_value.clone();
                if !v.sources.is_empty() {
                    t.sources = v.sources.clone();
                }
            }
        }
    }
}

fn apply_promotions(topics: &mut Vec<Topic>, promote: &[Promote]) -> usize {
    let mut n = 0;
    for p in promote {
        if topics.iter().any(|t| t.id == p.id) {
            continue; // 중복 id 방지.
        }
        topics.push(Topic {
            id: p.id.clone(),
            subject: p.subject.clone(),
            severity: p.severity.clone(),
            status: BLANK.into(),
            verified_value: String::new(),
            sources: vec![],
            version: 0,
            verify_count: 0,
            history: vec![],
        });
        n += 1;
    }
    n
}

fn apply_refines(topics: &mut [Topic], refine: &[Refine], round: u32) {
    for r in refine {
        if let Some(t) = topics.iter_mut().find(|t| t.id == r.id && t.status == FAIL) {
            t.subject = r.new_subject.clone();
            t.history.push(Attempt {
                round,
                status: BLANK.into(),
                reason: format!("결정기능 보완 → 재검증: {}", r.reason),
                verified_value: String::new(),
            });
            t.status = BLANK.into();
        }
    }
}

/// run_loop — 생성기능 → [검증기능(공백 전체) → validate → 결정기능(승격·보완·결정)] → 수렴/abort.
pub fn run_loop(directive: &str, ledger: &mut Ledger, cfg: &LoopConfig) -> Result<Outcome, String> {
    if ledger.topics.is_empty() {
        ledger.topics = exec_generate(directive, cfg)?;
        ledger.save()?;
    }
    let mut log = vec![];
    let mut converged = false;
    let mut aborted = false;
    let mut abort_reason = String::new();
    let mut rounds = 0;

    for round in 1..=cfg.max_rounds {
        rounds = round;
        // 검증기능: 공백 주제를 BATCH 씩 검증(버스트 검색 회피 + 콜 사이 쿨다운). [o]는 건너뜀.
        // 한 배치가 인프라(529)로 실패하면 그 주제는 공백 유지 → 다음 라운드 재시도([x] 아님).
        let blank_ids: Vec<String> = ledger.topics.iter().filter(|t| t.status == BLANK).map(|t| t.id.clone()).collect();
        let mut additions: Vec<Addition> = vec![];
        // BATCH=0 → 공백 전체를 한 콜(chunks(0) 패닉 방지). 아니면 BATCH 씩.
        let chunk_size = if BATCH == 0 { blank_ids.len().max(1) } else { BATCH };
        // 공백이 있으면 BATCH 씩 (A)검증+(B)누락사냥. 공백이 0이어도 (B) 누락사냥은 매 라운드 1회 돈다
        // (빈 배치 → (A)는 무동작, (B)만 전체 원장 검사). 누적의 핵심: 수렴된 [o] 집합도 보강된 검증기능·바뀐
        // 세계가 새 make-or-break(모순·이음매·깊이)를 잡게 — 이게 없으면 재개해도 (B)가 안 돌아 즉시 수렴.
        let chunks: Vec<Vec<String>> = if blank_ids.is_empty() {
            vec![vec![]]
        } else {
            blank_ids.chunks(chunk_size).map(|c| c.to_vec()).collect()
        };
        for (bi, chunk) in chunks.iter().enumerate() {
            if bi > 0 {
                std::thread::sleep(Duration::from_secs(COOLDOWN));
            }
            let batch: Vec<Topic> = ledger.topics.iter().filter(|t| chunk.contains(&t.id)).cloned().collect();
            let all = ledger.topics.clone();
            match exec_verify(directive, &batch, &all, cfg) {
                Ok(vr) => {
                    apply_verifications(&mut ledger.topics, &vr.verifications, round);
                    additions.extend(vr.additions);
                    ledger.save()?;
                }
                Err(e) => eprintln!("  [batch 검증 실패(공백 유지·재시도): {}]", e.chars().take(100).collect::<String>()),
            }
        }
        validate_ledger(&mut ledger.topics, round);
        ledger.save()?;

        // 결정기능: 승격 + 보완 + 결정.
        let jr = exec_decide(directive, &ledger.topics, &additions, cfg)?;
        apply_refines(&mut ledger.topics, &jr.refine, round);
        let promoted = apply_promotions(&mut ledger.topics, &jr.promote);
        ledger.save()?;

        let verified = ledger.topics.iter().filter(|t| t.status == OK).count();
        let failed = ledger.topics.iter().filter(|t| t.status == FAIL).count();
        log.push(RoundLog {
            round,
            verified,
            failed,
            promoted,
            decision: jr.decision.clone(),
            reason: jr.reason.chars().take(200).collect(),
        });

        match jr.decision.as_str() {
            "abort" => {
                aborted = true;
                abort_reason = jr.reason.clone();
                break;
            }
            "converge" => {
                converged = true;
                break;
            }
            _ => {}
        }
        // 자연 수렴: 공백 0 ∧ 새 승격 0.
        let still_blank = ledger.topics.iter().any(|t| t.status == BLANK);
        if !still_blank && promoted == 0 {
            converged = true;
            break;
        }
    }

    let spec = if aborted {
        String::new()
    } else {
        exec_render(directive, &ledger.topics, cfg).unwrap_or_default()
    };
    ledger.save()?;

    Ok(Outcome {
        directive: directive.into(),
        spec,
        topics: ledger.topics.clone(),
        log,
        converged,
        aborted,
        abort_reason,
        rounds,
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, status: &str, last: Option<(&str, &str)>) -> Topic {
        let history = match last {
            Some((s, r)) => vec![Attempt { round: 1, status: s.into(), reason: r.into(), verified_value: String::new() }],
            None => vec![],
        };
        Topic {
            id: id.into(),
            subject: "s".into(),
            severity: "make_or_break".into(),
            status: status.into(),
            verified_value: String::new(),
            sources: vec![],
            version: 0,
            verify_count: 0,
            history,
        }
    }

    #[test]
    fn validate_consistent_ok() {
        let mut v = vec![t("a", OK, Some((OK, "확인")))];
        assert!(validate_ledger(&mut v, 2).is_empty());
        assert_eq!(v[0].status, OK);
    }

    #[test]
    fn validate_downgrades_mismatch() {
        // status=[o] 인데 history 마지막이 [x] → 강등.
        let mut v = vec![t("a", OK, Some((FAIL, "실패")))];
        let d = validate_ledger(&mut v, 3);
        assert_eq!(d, vec!["a".to_string()]);
        assert_eq!(v[0].status, FAIL);
        assert_eq!(v[0].history.last().unwrap().status, FAIL);
    }

    #[test]
    fn validate_blank_untouched() {
        let mut v = vec![t("a", BLANK, None)];
        assert!(validate_ledger(&mut v, 1).is_empty());
        assert_eq!(v[0].status, BLANK);
    }

    #[test]
    fn apply_verification_sets_status_and_value() {
        let mut v = vec![t("a", BLANK, None)];
        apply_verifications(
            &mut v,
            &[Verification { id: "a".into(), status: OK.into(), reason: "ok".into(), verified_value: "X".into(), sources: vec!["u".into()] }],
            1,
        );
        assert_eq!(v[0].status, OK);
        assert_eq!(v[0].verified_value, "X");
        assert_eq!(v[0].history.len(), 1);
    }

    #[test]
    fn correction_bumps_version() {
        let mut v = vec![t("a", OK, Some((OK, "v1")))];
        v[0].verified_value = "old".into();
        // [o]는 안 건드린다 → 교정은 [x] 거쳐 공백→재검증 경로. 직접 재검증 시뮬:
        v[0].status = BLANK.into();
        apply_verifications(
            &mut v,
            &[Verification { id: "a".into(), status: OK.into(), reason: "정정".into(), verified_value: "new".into(), sources: vec![] }],
            2,
        );
        assert_eq!(v[0].version, 1);
        assert_eq!(v[0].verified_value, "new");
    }

    #[test]
    fn promotions_dedupe() {
        let mut v = vec![t("a", OK, Some((OK, "x")))];
        let n = apply_promotions(&mut v, &[Promote { id: "a".into(), subject: "dup".into(), severity: "optional".into() }, Promote { id: "b".into(), subject: "new".into(), severity: "make_or_break".into() }]);
        assert_eq!(n, 1); // a 중복 → b 만.
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn refine_returns_to_blank() {
        let mut v = vec![t("a", FAIL, Some((FAIL, "fail")))];
        apply_refines(&mut v, &[Refine { id: "a".into(), new_subject: "better".into(), reason: "보완".into() }], 2);
        assert_eq!(v[0].status, BLANK);
        assert_eq!(v[0].subject, "better");
    }
}
