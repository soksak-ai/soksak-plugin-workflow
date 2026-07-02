# draft 역할 워크플로 저작 지시 (soksak — workflow-doc@0.0.1)

너는 soksak 의 draft 역할 워크플로를 **workflow-doc@0.0.1 JSON 문서**로 저작한다. 산출물 = soksak-workflow doc 실행기가 검증(validate)하고 stage 별로 실행하는 **완전한 JSON 문서 1개**. 사용자 아이디어 → 백로그 요건 덩어리 → 칸반 노드 발행. 코드가 아니다 — 문서가 프로그램이다(op 의미론은 system 의 workflow-doc 스킬).

**출력 계약**: 순수 JSON 만 출력한다 — 마크다운 펜스·설명·주석 없이 `{` 로 시작해 `}` 로 끝난다. 산출은 즉시 스키마 검증(fail-loud)되며, 위반 하나라도 있으면 저작 실패로 거부된다(플레이스홀더 미해석·참조 오타·id 중복 전부).

## 골격 (canonical — 이 구조 그대로, `<…>` 슬롯만 채운다)

```json
{
  "spec": "workflow-doc@0.0.1",
  "meta": {
    "name": "draft",
    "description": "DRAFT 워크플로 — 아이디어(directive)를 백로그 덩어리로 구체화. exec-stage 가 stage(generate/hunt/classify/audit) 별로 호출. generate=요건 발굴·평탄 발행, 항목 검증=exec-one, 누락=hunt, 분류=classify(완성 집합), 완결 인증=audit."
  },
  "args": {
    "directive": {
      "from": [
        "directive",
        "DIRECTIVE",
        "IDEA"
      ],
      "default": "<여기에 정련된 DIRECTIVE — 아래 「저작 자유도」>"
    },
    "parentDraftId": {
      "from": [
        "parentDraftId"
      ],
      "default": null
    }
  },
  "values": {
    "PENDING": "검수전",
    "COMMON": "<COMMON 원문 — 아래 「원문 블록」 그대로>",
    "VERIFY_TMPL": {
      "concat": [
        {
          "$": "values.COMMON"
        },
        "<VERIFY 역할 본문 — 아래 「원문 블록」 그대로>"
      ]
    },
    "GEN_SCHEMA": "<원문 블록>",
    "CLASSIFY_SCHEMA": "<원문 블록>",
    "VERIFY_SCHEMA": "<원문 블록>",
    "HUNT_SCHEMA": "<원문 블록>",
    "AUDIT_SCHEMA": "<원문 블록>"
  },
  "prompts": {
    "gen": "<원문 블록>",
    "hunt": "<원문 블록>",
    "classify": "<원문 블록>",
    "audit": "<원문 블록>"
  },
  "stages": {
    "": [
      {
        "op": "publish",
        "node": {
          "id": "chunk",
          "kind": "chunk",
          "isDraft": true,
          "parentDraftId": {
            "$": "args.parentDraftId",
            "or": ""
          },
          "title": {
            "$": "args.title",
            "or": "구체화 덩어리"
          },
          "description": {
            "$": "args.directive"
          }
        }
      },
      {
        "op": "publish",
        "node": {
          "id": "gen",
          "kind": "task",
          "stage": "generate",
          "parent": "chunk",
          "title": "요건 도출"
        }
      }
    ],
    "generate": [
      {
        "op": "agent",
        "prompt": "gen",
        "schema": "GEN_SCHEMA",
        "label": "요건 도출",
        "bind": "tree"
      },
      {
        "op": "forEach",
        "in": "tree.requirements",
        "when": "item.title",
        "collect": "itemIds",
        "do": [
          {
            "op": "publish",
            "node": {
              "id": {
                "auto": "i"
              },
              "kind": "item",
              "parent": {
                "$": "args.chunkRef",
                "or": "chunk"
              },
              "title": {
                "$": "item.title"
              },
              "description": {
                "$": "item.description",
                "or": ""
              },
              "origin": {
                "$": "item.origin"
              },
              "badge": {
                "$": "values.PENDING"
              },
              "schema": "VERIFY_SCHEMA",
              "promptRole": "verify",
              "vars": {
                "title": {
                  "$": "item.title"
                },
                "description": {
                  "$": "item.description",
                  "or": ""
                }
              },
              "varRefs": {
                "directive": "directive"
              },
              "registerPromptsOnce": {
                "verify": {
                  "$": "values.VERIFY_TMPL"
                },
                "directive": {
                  "$": "args.directive"
                }
              }
            }
          }
        ]
      },
      {
        "op": "publish",
        "node": {
          "id": "hunt",
          "kind": "task",
          "stage": "hunt",
          "parent": {
            "$": "args.chunkRef",
            "or": "chunk"
          },
          "title": "누락 탐색",
          "blockedBy": [
            {
              "$": "itemIds"
            }
          ]
        }
      },
      {
        "op": "publish",
        "node": {
          "id": "classify",
          "kind": "task",
          "stage": "classify",
          "parent": {
            "$": "args.chunkRef",
            "or": "chunk"
          },
          "title": "분류",
          "blockedBy": [
            {
              "$": "itemIds"
            },
            "hunt"
          ]
        }
      },
      {
        "op": "publish",
        "node": {
          "id": "audit",
          "kind": "task",
          "stage": "audit",
          "parent": {
            "$": "args.chunkRef",
            "or": "chunk"
          },
          "title": "부모 감사",
          "blockedBy": [
            {
              "$": "itemIds"
            },
            "hunt",
            "classify"
          ]
        }
      },
      {
        "op": "return",
        "value": {
          "chunkTitle": {
            "$": "tree.title",
            "or": ""
          },
          "titleOrigin": {
            "$": "tree.titleOrigin",
            "or": "agent"
          }
        }
      }
    ],
    "hunt": [
      {
        "op": "agent",
        "prompt": "hunt",
        "schema": "HUNT_SCHEMA",
        "label": "누락 탐색",
        "bind": "r"
      },
      {
        "op": "forEach",
        "in": "r.additions",
        "when": "item.title",
        "do": [
          {
            "op": "publish",
            "node": {
              "id": {
                "auto": "add"
              },
              "kind": "item",
              "parent": {
                "$": "args.chunkRef",
                "or": "chunk"
              },
              "title": {
                "$": "item.title"
              },
              "description": {
                "$": "item.description",
                "or": ""
              },
              "origin": {
                "$": "item.origin"
              },
              "badge": {
                "$": "values.PENDING"
              },
              "schema": "VERIFY_SCHEMA",
              "promptRole": "verify",
              "vars": {
                "title": {
                  "$": "item.title"
                },
                "description": {
                  "$": "item.description",
                  "or": ""
                }
              },
              "varRefs": {
                "directive": "directive"
              },
              "registerPromptsOnce": {
                "verify": {
                  "$": "values.VERIFY_TMPL"
                },
                "directive": {
                  "$": "args.directive"
                }
              }
            }
          }
        ]
      },
      {
        "op": "return",
        "value": {}
      }
    ],
    "classify": [
      {
        "op": "agent",
        "prompt": "classify",
        "schema": "CLASSIFY_SCHEMA",
        "label": "분류",
        "bind": "r"
      },
      {
        "op": "return",
        "value": {
          "dimension": {
            "$": "r.dimension",
            "or": ""
          },
          "assignments": {
            "$": "r.assignments",
            "or": []
          }
        }
      }
    ],
    "audit": [
      {
        "op": "agent",
        "prompt": "audit",
        "schema": "AUDIT_SCHEMA",
        "label": "부모 감사",
        "bind": "r"
      },
      {
        "op": "return",
        "value": {
          "verdict": {
            "$": "r.verdict",
            "or": "(감사 결과 없음)"
          },
          "complete": {
            "$": "r.complete",
            "or": false
          }
        }
      }
    ]
  }
}
```

**stages 는 위 구조 그대로다** — op 를 추가/삭제/재배열하지 마라. blockedBy 사슬(hunt=전 항목 → classify=+hunt → audit=+classify)이 절차 순서다: generate(평탄 발굴) → verify(항목별 exec-one, 스케줄러 몫) → hunt(누락 보강) → classify(완성 집합 분류) → audit(전체 감사).

## 저작 자유도 (네가 채우는 것)

- `args.directive.default`: 사용자 아이디어를 **정련해** 임베드 — 표면 문구 복사가 아니라 실제 의도를 담은 지시어로. ③파생 도메인 지시어(user 프롬프트에 제공되면)는 강제가 아니라 힌트다: 이 도메인에 진짜 해당하는 것만 지시어 정련에 흡수하라.
- `meta.description`: 이 드래프트의 한 줄 서술(담백하게).
- 그 외 전부(values 원문·prompts 원문·stages)는 아래 원문 블록을 **byte 그대로** 넣는다 — 표현을 다듬지 마라. 템플릿·프롬프트가 byte 동일해야 콘텐츠 주소화(sha256 dedup)가 전 드래프트에 걸쳐 1행으로 수렴한다.

## 정규화(콘텐츠 주소화) — 왜 이 구조인가

item 노드에 완성 프롬프트(COMMON+본문 ~8.7KB)를 통째 박지 않는다. 3수준 분리: (1) VERIFY_TMPL = {{title}}/{{description}}/{{directive}} 마커 템플릿(전역 공유 1행 — values.COMMON 과 concat 으로 조성, 문서 내 중복 0), (2) directive = 청크당 1행(첫 항목의 registerPromptsOnce 로 등록, varRefs 로 참조), (3) title/description = 항목당 작은 vars. 소비 시점(kanban prompt.resolve)에 치환된다 — VERIFY_TMPL 안의 {{…}} 마커는 **그대로 남긴다**(지금 렌더되는 게 아니다).

## 원문 블록 (values·prompts 에 byte 그대로)

### values.COMMON
```text
SHARED CONCEPTS:
- A REQUIREMENT = an imperative the result must satisfy ("the system/plan/novel/work must …"): concrete and developable/executable — NOT a background fact, NOT a restatement of the directive. (Form: not "X regulations" but "the system must DO <Y> to satisfy <X>".)
- MAKE-OR-BREAK = its absence would make the result FAIL or be WRONG, not merely less polished. A genuine one is a DECISION two competent practitioners could resolve DIFFERENTLY — NOT a nice-to-have, NOT one methodology's enumerated beat-list, NOT the HOW / implementation-detail of another requirement (that is covered by its parent, not a separate requirement).
- EXPERT STANCE: read THIS directive as the SENIOR PRACTITIONER of its real domain (a pharmacist / compliance officer for a drug system, a novelist for a novel, an expedition leader for a climb). An expert never stops at the CATEGORY — "comply with the narcotics law" / "protect personal data" is NOT a requirement; it HIDES the concrete obligations the law compels, each its own make-or-break ("on a stock discrepancy, file the incident report to the authority within the statutory deadline"; "verify the vendor is a licensed wholesaler at registration"). Name the SPECIFIC trigger / deadline / check whoever builds, writes, or executes it must satisfy — a distinct requirement an expert knows, never an implementation beat. (Likewise outside law: a novel — not "a satisfying ending" but the specific turn that earns it; a plan — not "be safe" but the specific abort threshold.) A broad "support / comply with X" topic HIDES the gap, it does not cover it.
- THE BACK-SIDE: the requester is NOT a domain expert — they named the visible SURFACE (the easy 80%) and, even in a DETAILED directive, omit the make-or-break BACK-SIDE (the 20% that decides success) a senior practitioner / law / safety requires for the intent to actually work, be legal, be safe (the administrative, legal, financial, safety, contingency/failure-handling, oversight/who-administers substrate). DRAW IT OUT — adversarially ask of THIS intent: who actually OPERATES it, OVERSEES/administers it, PAYS FOR it, is kept SAFE/legal by it, and RECOVERS it when it fails or ends — and what does each REQUIRE that the requester never said? Don't be seduced by a polished, plausible surface: that polish IS the 80% trap. Then use the per-domain SHAPES below — the KIND to hunt; they COMPLEMENT the questions above (a minimal domain hint), never REPLACE them, and are NOT answers (search the real content; apply ONLY what genuinely fits THIS directive, never force a non-applicable category):
    · SYSTEM → operator/admin console per permission grade & oversight, data model, regulation (the SPECIFIC reporting/incident triggers, deadlines, and qualifications the governing law compels — kinds to hunt, not answers), security boundaries, monitoring, lifecycle/offboarding.
    · NOVEL → the avenger's corrosion, justice-vs-vengeance, antagonist depth, the delay engine, the payoff, the aftermath, POV/reveal-order, setting/world, reader complicity.
    · PLAN → go/no-go gates, per-step verification, contingency/rollback, failure modes, legal/safety preconditions (the SPECIFIC approvals, clearances, and qualifications required before an act may proceed — kinds to hunt, not answers), responsibility, exit criteria.
    · EVERYDAY (e.g. moving house) → registration, deposit/fee settlement, address changes, defect-check — not just the visible act.
- LEGAL LENS: wherever the intent's success turns on real-world LAW, RULE, or LEGITIMACY — to be COMPLIANT (a statutory duty it must satisfy), to be PERMITTED (an approval / license / qualification that gates an act or a participation), or to be ACCURATE (a work that portrays or relies on real law) — surface the binding obligations, approvals, triggers, and deadlines the real, current law actually compels, not just the functional surface (ground them by GROUNDING below). This is NOT only for regulated systems: a plan may need a clearance, a novel may need its law right. Apply ONLY where the intent genuinely turns on law; never force it onto one that does not.
- GROUNDING (when to SEARCH vs REASON — the one rule for any fact you rely on): the real test is "could you be WRONG from memory?" — info beyond your knowledge cutoff (a recent event, the CURRENT status of a law/program/standard), OR the SPECIFICS of a named statute/article/standard/figure/framework you could misremember, OR genuine uncertainty → WebSearch (put the current year in queries; NEVER assert such specifics from memory). A general principle or common design/craft choice you RELIABLY know → reason it; do NOT search what you reliably know (wasteful), and never re-search the settled.
- COMMON-SENSE DEFAULT: where the directive leaves a gap or ambiguity, resolve it with the SIMPLEST answer common reasoning reaches — what most competent people would call obvious. Do NOT invent an unusual, elaborate, or restrictive mechanism (a quantity cap, an enforcement, a control) the directive never asked for; a plain reading beats a clever one. The unusual must come from the directive — never from you.
- INVARIANTS — every requirement, whether GENERATED or ADDED: (1) ATOMIC — one subject, not bundled, not over-split; (2) NO DUPLICATE — not a restatement of another, judged by MEANING not wording (a narrower / re-angled / renamed / split version of an existing one is NOT new); (3) NO FORCING/FABRICATION — a genuine grounded make-or-break, never invented to seem thorough.
```

### values.VERIFY_TMPL 의 concat 두 번째 원소(역할 본문 — {{title}}/{{description}}/{{directive}} 마커 보존)
```text


YOUR ROLE — VERIFIER (hostile). Verify ONE requirement — judge whether it is a real, grounded make-or-break. Do NOT propose new ones (a separate step).

REQUIREMENT:
- {{title}} — {{description}}

Pick the method by GROUNDING (SHARED CONCEPTS): could you be WRONG from memory → WebSearch the specific (verified_value = fact + source); reliably know it → verify by REASONING (necessary AND sound? verified_value = why required/sound).
Then judge the OUTCOME — YOU decide the severity (field "oxf"):
- holds AND is a real requirement → oxf "o" + origin + verified_value + sources + reason.
- NOT a real requirement (wrong / unnecessary / out-of-scope / a duty the directive disclaims) → "x" + reason — a minor, LEGITIMATE off, NOT a failure (the result still stands without it; the node is KEPT, badge x, not removed).
- CRITICAL break — the directive is self-contradictory or rests on an impossible premise, OR this core make-or-break is fundamentally unverifiable AND fatal so the whole result cannot stand → "f" + reason. Reserve "f" for genuine show-stoppers; a negative-but-verified conclusion is "o", not fatal. (Chunk-level f≥1 → discard is decided later by the audit, not here.)
Set ORIGIN to how it is BACKED, record that backing in verified_value: "user" (directive states/implies it → its own words) / "agent" (you reasoned it → the knowledge basis, WHY required/sound) / "search" (grounded externally → fact + quoted passage, sources = URLs).
"x" ≠ a failed search: if a NEEDED WebSearch ERRORS/empty (529), retry — do NOT "x".

Directive: "{{directive}}"

Do any needed search first (only if fact-hinged). FINAL message = ONLY this JSON.
```

### values.GEN_SCHEMA
```json
{
  "type": "object",
  "required": [
    "title",
    "requirements"
  ],
  "properties": {
    "title": {
      "type": "string"
    },
    "titleOrigin": {
      "type": "string",
      "enum": [
        "user",
        "agent"
      ]
    },
    "requirements": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "title",
          "description",
          "origin"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "origin": {
            "type": "string",
            "enum": [
              "user",
              "agent"
            ]
          }
        }
      }
    }
  }
}
```

### values.CLASSIFY_SCHEMA
```json
{
  "type": "object",
  "required": [
    "dimension",
    "assignments"
  ],
  "properties": {
    "dimension": {
      "type": "string"
    },
    "assignments": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "id",
          "category"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "category": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

### values.VERIFY_SCHEMA
```json
{
  "type": "object",
  "required": [
    "oxf",
    "origin"
  ],
  "properties": {
    "oxf": {
      "type": "string",
      "enum": [
        "o",
        "x",
        "f"
      ]
    },
    "origin": {
      "type": "string",
      "enum": [
        "user",
        "agent",
        "search"
      ]
    },
    "verified_value": {
      "type": "string"
    },
    "sources": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "reason": {
      "type": "string"
    }
  }
}
```

### values.HUNT_SCHEMA
```json
{
  "type": "object",
  "required": [
    "additions"
  ],
  "properties": {
    "additions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "title",
          "description",
          "origin"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "origin": {
            "type": "string",
            "enum": [
              "agent",
              "search"
            ]
          },
          "reason": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

### values.AUDIT_SCHEMA
```json
{
  "type": "object",
  "required": [
    "complete",
    "verdict"
  ],
  "properties": {
    "complete": {
      "type": "boolean"
    },
    "gaps": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "contradictions": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "sufficiency": {
      "type": "string"
    },
    "verdict": {
      "type": "string"
    }
  }
}
```

### prompts.gen ({{COMMON}}/{{directive}} 는 실행 시 렌더)
```text
{{COMMON}}

YOUR ROLE — GENERATOR: turn the directive into a BACKLOG CHUNK (덩어리) — a title for the whole + the full FLAT set of REQUIREMENTS. **You do NOT classify.** Categorization is a LATER review step (classify), run after the set is complete; here you only DISCOVER.

1) CHUNK TITLE: if the directive states or clearly implies a name for the whole, EXTRACT it (titleOrigin "user"); else GENERATE a short faithful title from its real intent (titleOrigin "agent"). One short noun phrase in the directive's language — the name a practitioner files this backlog under.
2) REQUIREMENTS — **INTERPRET, do NOT echo.** Read the directive's real intent; never pass surface phrasing through verbatim. A terse directive bundles several DISTINCT requirements in one run-on clause — split each into its OWN atomic item (title = the imperative requirement in 입력 언어, description = one line of what it must do / why make-or-break). ATOMIC: split bundled DISTINCT requirements; never split ONE requirement into its implementation beats.
   **GENERATION IS GENEROUS — cast WIDE.** Include EVERY plausible make-or-break (content, structural/craft, operational, regulated, the back-side). Generosity is SAFE: the per-item verifier grounds each and rejects (x) any that does not hold — better to slightly OVER-include than to miss one. No cap, no stinginess; this set must be COMPLETE. Obey the INVARIANTS. origin = "user" if the directive states/implies it, "agent" if you derive it as a make-or-break the directive never stated. You cannot search here. There is NO optional tier — a nice-to-have is NOT a requirement.
   **DO NOT group, do NOT invent a category dimension, do NOT prune to fit a frame.** Pre-classifying prunes topics outside the frame and breaks completeness — emit requirements[] FLAT. The classify step (after hunt completes the set) invents the dimension and assigns categories then.

Directive: "{{directive}}"
```

### prompts.hunt ({{ledger}} = 원장 빌트인 렌더)
```text
{{COMMON}}

YOUR ROLE — VERIFIER (hostile). CERTIFY THE WHOLE, not the parts. A part-by-part "o" does NOT mean the result works — certify the ASSEMBLED set delivers the goal. The generator is an LLM; DISTRUST the list. Run ALL FIVE checks; request what each surfaces (→ additions, each a new requirement: title + description + category):
  - GOAL-REACH: state, in your reasoning, what the result must ACHIEVE for the requester beneath the surface, then check the ledger reaches it. If the core outcome rests on an impossible/unverified premise, VERIFY it (search if external) and request the feasibility precondition. Never assume the premise holds.
  - CONTRADICTION: mentally BUILD the whole toward that goal. Where two requirements conflict so a builder is BLOCKED until one is overruled, request the requirement that RESOLVES which wins.
  - SEAM: where the JOIN between two requirements is owned by neither and a builder must GUESS a make-or-break decision, request the rule that OWNS the join.
  - DEPTH: apply EXPERT STANCE + LEGAL LENS to every named/regulated requirement — does it state the SPECIFIC obligation/trigger the law compels, or stop at the category? If only the category, request the specific one.
  - DOMAIN-FAILURE: as the senior practitioner, put the result as-built into ACTUAL use over time — beyond logical reach, what FAILS in PRACTICE that a part-by-part check misses? Request the make-or-break that prevents it. Stay inside the directive's stated scope.
Do NOT request nice-to-haves. Do NOT re-request what the ledger covers (NO DUPLICATE — by MEANING). Additions are FLAT requirements (title + description + origin) — do NOT categorize; the classify step (which runs AFTER you) invents the dimension over the COMPLETE set. ZERO additions is the correct, expected answer for a complete ledger — a forced requirement is worse than none. Over-enumeration is failure.

Full ledger (propose ONLY missing make-or-breaks; do NOT re-verify these):
{{ledger}}

Directive: "{{directive}}"

Do any needed search first. FINAL message = ONLY this JSON.
```

### prompts.classify
```text
{{COMMON}}

YOUR ROLE — CLASSIFIER (검토·분류). 생성·누락탐색이 끝났다 — 아래 원장이 **완성된 전체 요건**이다. 새 요건을 만들지 마라(그건 hunt 몫). 전체를 senior practitioner 로서 읽고, 이 도메인에 맞는 분류 차원 하나를 INVENT 한 뒤, 모든 요건을 정확히 한 카테고리로 배정한다.
  - DIMENSION: 이 도메인에 맞는 차원 하나를 발명(a system: 기능 영역; a novel: 막/장; a plan: 국면; a climb: 구간 — 고정 분류법 금지, directive 와 실제 요건들에서 도출). **집합이 이미 완성됐으니(hunt 후) 프레임 밖 토픽이 잘릴 위험이 없다 — 그래서 생성이 아니라 여기서 분류한다.**
  - ASSIGN: 원장의 모든 항목을 그 차원의 카테고리로. assignments[] 각 원소 = {id(원장 줄 맨 앞 [id]), category}. 모든 id 를 정확히 한 번씩, 정확히 한 카테고리로. category 는 짧은 명사구(입력 언어). 카테고리 수는 집합이 정하게 — 억지로 늘리거나 줄이지 마라.

완성된 전체 원장(각 줄 맨 앞 [id] 로 배정):
{{ledger}}

Directive: "{{directive}}"

FINAL message = ONLY this JSON.
```

### prompts.audit
```text
{{COMMON}}

YOUR ROLE — AUDITOR (the backlog chunk's parent certification). The per-item badges are already set. Your job is NOT to re-judge items one by one — CERTIFY THE WHOLE ASSEMBLED SET (부품 아닌 전체): does this set, taken together, deliver the directive's goal completely and coherently? Judge three axes, give ONE verdict:
  - 누락 (gaps): any make-or-break MISSING that the goal cannot stand without? List each (empty if none).
  - 모순 (contradictions): any two requirements conflict so a builder is blocked until one is overruled? List each (empty if none).
  - 충분 (sufficiency): assembled, does the set REACH the goal — not just cover the surface? State plainly whether it suffices and why.
Set complete=true ONLY if no goal-breaking gaps, no unresolved contradictions, and the set genuinely suffices. verdict = one paragraph: what the assembled draft achieves and the single most important thing still missing or wrong (or "완결" if none). Do NOT pad. Stay inside the directive's stated scope.

Full ledger (CERTIFY this whole):
{{ledger}}

Directive: "{{directive}}"

Do any needed search first. FINAL message = ONLY this JSON.
```

## 지시

위 골격에 원문 블록을 그대로 넣고, 사용자 아이디어(아래 user 프롬프트)를 정련해 `args.directive.default` 에 임베드한 **workflow-doc@0.0.1 JSON 문서 하나**를 출력하라. 절차는 5개(generate → verify → hunt → classify → audit), generate 는 분류하지 않는다(평탄 — 분류는 classify). 순수 JSON 만.
