export const meta = {
  name: "mini-spec",
  description: "Tiny e2e — idea를 빌드 각도와 한 줄 계획으로.",
  phases: [{ title: "Scope" }, { title: "Plan" }],
};

const ANGLES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { angles: { type: "array", items: { type: "string" } } },
  required: ["angles"],
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { plan: { type: "string" } },
  required: ["plan"],
};

phase("Scope");
const scope = await agent(`Break this product idea into exactly 3 short build angles. Idea: ${IDEA}`, {
  label: "scope",
  schema: ANGLES_SCHEMA,
});

phase("Plan");
const plan = await agent(`Write a single-sentence build plan for this idea. Idea: ${IDEA}`, {
  label: "plan",
  schema: PLAN_SCHEMA,
});

return { scope, plan };
