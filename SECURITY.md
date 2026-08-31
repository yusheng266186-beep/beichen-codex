# Security Policy

## Reporting

请不要在公开 issue 中提交 API key、TOTP seed、session secret、Authorization、用户谈话或截图。将可复现步骤与脱敏的 `X-Request-ID` 通过维护者的私下渠道发送。

## Scope

本策略只覆盖 `beichen-codex` 独立仓库、独立 Pages artifact 与独立 SCF 函数。历史 `beichen` 仓库和历史云函数不属于本项目的更新范围。

## Response

发现凭据暴露时，优先撤销/轮换凭据、冻结受影响函数、保留最小化审计记录，再评估代码修复。不要通过回滚恢复已泄露的值。
