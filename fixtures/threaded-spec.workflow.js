export const meta = {
  name: "threaded-spec",
  description: "Threading e2e — scope 출력을 plan 이 받는다.",
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
  properties: { chosen_angle: { type: "string" }, plan: { type: "string" } },
  required: ["chosen_angle", "plan"],
};

phase("Scope");
const scope = await agent(`Break this product idea into exactly 3 distinct build angles (short strings). Idea: ${args.IDEA}`, {
  label: "scope",
  schema: ANGLES_SCHEMA,
});

phase("Plan");
const plan = await agent(
  `From these candidate angles, pick the single best one and copy it verbatim into chosen_angle, then write a one-sentence build plan. Angles: ${scope.angles}. Idea: ${args.IDEA}`,
  { label: "plan", schema: PLAN_SCHEMA },
);

return { scope, plan };
