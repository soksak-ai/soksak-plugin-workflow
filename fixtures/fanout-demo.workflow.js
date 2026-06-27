export const meta = {
  name: "fanout-demo",
  description: "fan-out e2e — scope 각도별로 detail 을 병렬 생성 후 종합.",
  phases: [{ title: "Scope" }, { title: "Expand" }, { title: "Synth" }],
};
const ANGLES_SCHEMA = { type:"object", additionalProperties:false, properties:{ angles:{ type:"array", items:{ type:"object", additionalProperties:false, properties:{ label:{type:"string"}, focus:{type:"string"} }, required:["label","focus"] } } }, required:["angles"] };
const DETAIL_SCHEMA = { type:"object", additionalProperties:false, properties:{ label:{type:"string"}, detail:{type:"string"} }, required:["label","detail"] };
const SYNTH_SCHEMA = { type:"object", additionalProperties:false, properties:{ summary:{type:"string"} }, required:["summary"] };
phase("Scope");
const scope = await agent(`Break this idea into exactly 3 angles, each {label, focus}. Idea: ${args.IDEA}`, { label:"scope", schema: ANGLES_SCHEMA });
phase("Expand");
const details = await parallel(scope.angles.map(angle => () => agent(`Write one detailed sentence for this angle. Echo the label into label. Label: ${angle.label}. Focus: ${angle.focus}. Idea: ${args.IDEA}`, { label:"detail", schema: DETAIL_SCHEMA })));
phase("Synth");
const synth = await agent(`Combine these per-angle details into a 2-sentence summary. Details JSON: ${JSON.stringify(details)}`, { label:"synth", schema: SYNTH_SCHEMA });
return { scope, details, synth };
