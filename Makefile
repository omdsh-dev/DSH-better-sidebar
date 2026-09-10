# dsh-better-sidebar 命令面薄封装：目标仅转发 package.json scripts（唯一事实源），
# 新增/改名 script 不需要动这里；本文件只补目标发现（help）与 CI 门禁聚合
# （check / mount / mount-aggregate / registry）。

.DEFAULT_GOAL := help

help: ## 列出所有可用目标
	@awk -F':.*## ' '/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## 安装依赖（pnpm install）
	pnpm install

build: ## 构建（清 lib/ → tsc → tsdown）
	pnpm build

typecheck: ## 类型检查（tsc --noEmit）
	pnpm typecheck

lint: ## 代码检查（eslint .，flat config 最小规则集）
	pnpm lint

test: ## 单元测试（vitest run）
	pnpm test

check: ## 聚合校验门禁：typecheck → lint → build → test → check:consumer-types（对齐 CI）
	pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm check:consumer-types

clean: ## 清理构建产物与测试报告（lib/、*.tgz、playwright-report/、test-results/）
	rm -rf lib playwright-report test-results
	rm -f *.tgz

pack: ## 打 npm tarball（pnpm pack）
	pnpm pack

mount: ## 真机挂载冒烟：build + pack → Playwright Chromium → pnpm test:mount
	pnpm build && pnpm pack && pnpm exec playwright install chromium && pnpm test:mount

mount-aggregate: ## 聚合双挂载回归：build + pack → pnpm test:mount:aggregate
	pnpm build && pnpm pack && pnpm test:mount:aggregate

registry: ## 组装 plugin-registry 暂存（registry/，不入库）：build → node scripts/package-registry.mjs
	pnpm build && node scripts/package-registry.mjs

.PHONY: help install build typecheck lint test check clean pack mount mount-aggregate registry
