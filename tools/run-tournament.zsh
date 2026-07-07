#!/usr/bin/env zsh
# 방법론 대회 러너(M3) — 동결 입력(stage.jsonl 요건 + research.jsonl fact)으로 design 방법론들을 실측.
#   tools/run-tournament.zsh <out-dir>
# 산출: <out>/mc2.jsonl(M-C 2회째 — 재현 안정성), <out>/ma-{domain,interface,criteria}.jsonl(병렬),
#       <out>/mb-{interface,domain,criteria}.jsonl(체인 — 앞 산출을 ground 에 누적).
# 529 는 사이드카 30s×10 + 본 러너 5분×8 텀 재실행. 방법론=doc 데이터(§10) — 러너는 실행 순서만 소유.
set -uo pipefail
HERE="${0:A:h}/.."
OUT="${1:?out dir}"
BIN="$HERE/target/release/soksak-sidecar-workflow"
IDEA="$HERE/e2e/idea.txt"
ST="$HERE/e2e/out/stage.jsonl"
RS="$HERE/e2e/out/research.jsonl"
mkdir -p "$OUT"
export SOKSAK_SIDECAR_WORKFLOW_RUNS="$OUT/runs"

run_stage() { # <doc> <stage> <out.jsonl> [extra-facts...]
  local doc=$1 stage=$2 out=$3; shift 3
  local n=0
  until node "$HERE/tools/assemble-ledger.mjs" design "$ST" "$IDEA" "$RS" "$@" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);i.skeleton=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));i.stage=process.argv[2];process.stdout.write(JSON.stringify(i))});' "$doc" "$stage" \
      | "$BIN" exec-stage --lang ko --model glm-5.2 > "$out"; do
    n=$((n+1)); [ $n -ge 8 ] && echo "FAIL: $stage 8회 소진" && return 1
    echo "── 529 — 5분 후 재시도($n/8): $stage"; sleep 300
  done
  echo "OK: $stage → $out ($(grep -c '"ev":"add"' $out 2>/dev/null || echo 0) adds)"
}

echo "═══ M-C 2회째(재현 안정성) ═══"
run_stage "$HERE/workflows/research.doc.json" design "$OUT/mc2.jsonl" || exit 1

echo "═══ M-A 병렬 분해(독립 3턴 — 동일 입력) ═══"
for s in domain interface criteria; do
  run_stage "$HERE/e2e/methodologies/design-parallel.doc.json" "design-$s" "$OUT/ma-$s.jsonl" || exit 1
done

echo "═══ M-B 선별 체인(앞 산출을 ground 에 누적) ═══"
run_stage "$HERE/e2e/methodologies/design-chain.doc.json" design-interface "$OUT/mb-interface.jsonl" || exit 1
run_stage "$HERE/e2e/methodologies/design-chain.doc.json" design-domain "$OUT/mb-domain.jsonl" "$OUT/mb-interface.jsonl" || exit 1
run_stage "$HERE/e2e/methodologies/design-chain.doc.json" design-criteria "$OUT/mb-criteria.jsonl" "$OUT/mb-interface.jsonl" "$OUT/mb-domain.jsonl" || exit 1
echo "═══ 대회 실측 완료 ═══"
