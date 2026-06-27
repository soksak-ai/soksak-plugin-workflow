export const meta = {
  name: "domain-spec",
  description: "③파생 도메인 지시어를 반영한 빌드 스펙.",
  phases: [{ title: "Spec" }],
};

const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    spec: { type: "string" },
    applied_directive_ids: { type: "array", items: { type: "string" } },
  },
  required: ["spec", "applied_directive_ids"],
};

phase("Spec");
const spec = await agent(
  `You are a product spec writer. Write a concise build spec (Korean) for the idea. You MUST incorporate EVERY domain directive listed below — these encode domain invariants that are NOT stated in the plain idea. List the directive ids you applied in applied_directive_ids. Idea: ${args.IDEA}. Mandatory domain directives (JSON): ${JSON.stringify(args.directives)}`,
  { label: "spec", schema: SPEC_SCHEMA },
);

return { spec };
