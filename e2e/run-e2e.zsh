#!/usr/bin/env zsh
# soksak-plugin-workflow e2e 러너 — 단일·재현 가능(임시 스크립트 금지).
#
#   e2e/run-e2e.zsh [make-target ...]      기본 타깃: e2e
#   예) run-e2e.zsh e2e            gen.js 재생성 + skeleton + emit 스모크
#       run-e2e.zsh exec-stage    generate stage 실측(DraftDoc)
#       run-e2e.zsh e2e exec-stage
#       run-e2e.zsh test          결정적(LLM 0)
#
# 인증: 인터랙티브 zsh 의 claude 진입점(래퍼 포함)이 주입하는 ANTHROPIC_* env 를 캡처해 make 에 주입한다.
# 래퍼 이름이 다르면 SOKSAK_CLAUDE_WRAPPER 로 지정한다.
# 토큰은 절대 stdout 에 나오지 않는다 — claude 를 섀도우해 env 만 600 권한 tmp 파일로 덤프 후 source.
# 값은 파일에만 있고 화면/로그로 안 나간다. MODEL/SLUG 등은 make 변수로 덮어쓴다(예: MODEL=<모델명> run-e2e.zsh).
set -uo pipefail
HERE="${0:A:h}"

# 1) claude 래퍼는 인터랙티브 zsh(.zshrc)에서만 정의된다 → zsh -ic 로 로드해 env 캡처.
#    비인터랙티브 서브셸/스크립트/백그라운드에서도 확실히 잡는 유일한 방법(rc source 는 interactive 가드에 막힘).
#    claude 를 섀도우해 래퍼가 주입하는 ANTHROPIC_* 만 600 권한 tmp 파일로 덤프(값 미출력).
TMPD="${CLAUDE_JOB_DIR:-${TMPDIR:-/tmp}}/soksak-e2e"; mkdir -p "$TMPD"
W="${SOKSAK_CLAUDE_WRAPPER:-claude}"
EF="$TMPD/auth.env"; : > "$EF"; chmod 600 "$EF"
zsh -ic 'claude(){ command env | grep -E "^(ANTHROPIC_[A-Z_]+|CLAUDE_ACCOUNT_NAME|CLAUDE_CODE_OAUTH_TOKEN)=" > "'"$EF"'"; }; '"$W"' --version >/dev/null 2>&1 || '"$W"' >/dev/null 2>&1 </dev/null' >/dev/null 2>&1 || true
grep -qE '^(ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=' "$EF" || { print -u2 "run-e2e: 인증 env 캡처 실패 — 인터랙티브 zsh 의 claude 진입점($W)이 ANTHROPIC_AUTH_TOKEN 또는 CLAUDE_CODE_OAUTH_TOKEN 을 주입하는지 확인"; exit 1; }
set -a; source "$EF"; set +a

# 3) cargo PATH 보장 + make 타깃 실행.
export PATH="$HOME/.cargo/bin:$PATH"
print "[run-e2e] env 주입 완료(토큰 미출력) · 타깃: ${*:-e2e}"
exec make -C "$HERE" "${@:-e2e}"
