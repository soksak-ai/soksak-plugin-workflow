# soksak-plugin-workflow — 표준 테스트 타깃(docs/TESTING.md).
# test-unit = 결정적(LLM 0·앱 불요): rust 크레이트 유닛(reconcile tick 63케이스 + serve 와이어).
# main.js·reconcile.test.mjs 는 소멸했다 — 로직은 Rust 사이드카 서비스(serve)가 소유한다.
# 실 LLM e2e 는 e2e/run-e2e.zsh(인증 env 필요) — test-unit 아님.

.PHONY: test-unit
test-unit:
	cargo test
