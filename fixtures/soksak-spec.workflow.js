export const meta = { name: 'soksak-spec', description: 'idea+③파생 → 스펙', phases: [{ title: 'Spec' }] }
const SPEC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['spec', 'applied'],
  properties: { spec: { type: 'string' }, applied: { type: 'array', items: { type: 'string' } } },
}
phase('Spec')
const directiveText = (args.directives || []).map(d => '- ' + d.id + ': ' + d.directive).join('\n')
const spec = await agent(
  `빌드 스펙(한국어)을 쓰되, 아래 도메인 지시어를 전부 반영하고 적용한 id 를 applied 에.\n아이디어: ${args.IDEA}\n도메인 지시어:\n${directiveText}`,
  { label: 'spec', schema: SPEC_SCHEMA }
)
return { spec }
