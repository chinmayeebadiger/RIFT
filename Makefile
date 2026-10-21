.PHONY: install dev test test-foundation test-web test-api test-security test-demo demo-regression typecheck build scan scan-dependencies scan-image

install:
	npm --prefix apps/web ci
	npm --prefix services/api ci
	npm --prefix demo ci

dev:
	@trap 'kill "$$API_PID" 2>/dev/null || true' EXIT INT TERM; \
		npm --prefix services/api run start & API_PID=$$!; \
		npm --prefix apps/web run dev

test: test-foundation test-web test-api test-security test-demo demo-regression

test-foundation:
	python3 -m unittest discover -s tests -p 'test_*.py' -v

test-web:
	npm --prefix apps/web test -- --run

test-api:
	npm --prefix services/api test -- --run

test-security:
	npm --prefix services/api test -- --run src/investigation/command-executor.security.test.ts

test-demo:
	npm --prefix demo test -- --run src/domain/shop.test.ts src/server.test.ts

demo-regression:
	npm --prefix demo test -- --run src/domain/shop.regression.test.ts

typecheck:
	npm --prefix apps/web run typecheck
	npm --prefix services/api run typecheck
	npm --prefix demo run typecheck

build:
	npm --prefix apps/web run build
	npm --prefix services/api run build
	npm --prefix demo run build

scan: scan-dependencies scan-image

scan-dependencies:
	npm --prefix apps/web audit --offline --audit-level=high
	npm --prefix services/api audit --offline --audit-level=high
	npm --prefix demo audit --offline --audit-level=high
	npm --prefix packages/core audit --offline --audit-level=high

scan-image:
	python3 scripts/check_reproducibility.py
