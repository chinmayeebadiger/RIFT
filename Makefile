.PHONY: install dev test test-foundation test-web test-api typecheck build

install:
	npm --prefix apps/web ci
	npm --prefix services/api ci

dev:
	@trap 'kill "$$API_PID" 2>/dev/null || true' EXIT INT TERM; \
		npm --prefix services/api run start & API_PID=$$!; \
		npm --prefix apps/web run dev

test: test-foundation test-web test-api

test-foundation:
	python3 -m unittest discover -s tests -p 'test_*.py' -v

test-web:
	npm --prefix apps/web test -- --run

test-api:
	npm --prefix services/api test -- --run

typecheck:
	npm --prefix apps/web run typecheck
	npm --prefix services/api run typecheck

build:
	npm --prefix apps/web run build
	npm --prefix services/api run build
