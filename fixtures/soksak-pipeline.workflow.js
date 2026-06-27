export const meta = {
  name: "soksak-pipeline",
  description: "아이디어 → ③파생 구체화 → 리서치 → 플랜 → 검증. 단계 간 threading.",
  phases: [{ title: "Spec" }, { title: "Research" }, { title: "Plan" }, { title: "Verify" }],
};

const SPEC_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { spec: { type: "string" }, applied_directive_ids: { type: "array", items: { type: "string" } } },
  required: ["spec", "applied_directive_ids"],
};
const RESEARCH_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { stack: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, why: { type: "string" } }, required: ["name", "why"] } }, key_risks: { type: "array", items: { type: "string" } } },
  required: ["stack", "key_risks"],
};
const PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { phases: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, pseudocode: { type: "string" } }, required: ["name", "pseudocode"] } } },
  required: ["phases"],
};
const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { acceptance_criteria: { type: "array", items: { type: "string" } } },
  required: ["acceptance_criteria"],
};

phase("Spec");
const spec = await agent(`구체화 단계. 아이디어로 빌드 스펙(한국어)을 쓰되, 아래 도메인 지시어를 전부 반영하라(아이디어에 없는 도메인 불변). 적용한 id를 applied_directive_ids에. 아이디어: ${args.IDEA}. 도메인 지시어(JSON): ${JSON.stringify(args.directives)}`, { label: "spec", schema: SPEC_SCHEMA });

phase("Research");
const research = await agent(`지식습득 단계. 이 스펙을 구현할 기술 스택을 확정하고 근거와 핵심 리스크를 제시하라. 스펙: ${spec.spec}`, { label: "research", schema: RESEARCH_SCHEMA });

phase("Plan");
const plan = await agent(`플랜 단계. 스펙과 확정 스택으로 구현 단계(phase)를 슈도코드와 함께 분해하라. 스펙: ${spec.spec}. 스택: ${research.stack}`, { label: "plan", schema: PLAN_SCHEMA });

phase("Verify");
const verify = await agent(`검증 단계. 이 단계 계획에 대한 수용 기준(acceptance criteria)을 작성하라. 계획 단계들: ${plan.phases}`, { label: "verify", schema: VERIFY_SCHEMA });

return { spec, research, plan, verify };
