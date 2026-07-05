# soksak-plugin-workflow — 표준 테스트 타깃(docs/TESTING.md).
# test-unit = 결정적(LLM 0·앱 불요): rust 크레이트 유닛 + node reconcile 유닛.
# 실 LLM e2e 는 e2e/run-e2e.zsh(인증 env 필요) — test-unit 아님.

.PHONY: test-unit
test-unit:
	cargo test
	node reconcile.test.mjs
