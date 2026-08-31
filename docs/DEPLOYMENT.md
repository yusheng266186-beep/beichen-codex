# v3 独立部署记录

## 已发布资源

| 资源 | 值 |
| --- | --- |
| GitHub 仓库 | `yusheng266186-beep/beichen-codex` |
| Pages | `https://yusheng266186-beep.github.io/beichen-codex/` |
| SCF 函数 | `beichen-codex-relay` |
| SCF 地域 | `ap-chengdu` |
| SCF 运行时 | `Nodejs20.19` |
| 函数 URL | `https://1459223409-ljunx7cpn8.ap-chengdu.tencentscf.com` |
| 版本 | `v3.0.0-codex` |

## 验证记录

- 新函数创建后状态为 `Active`；旧函数 `beichen-qianfan-mini` 仍保持原有运行时、触发器和修改时间。
- 新函数 `/healthz` 返回 HTTP 200、`ok: true`、`version: v3.0.0-codex`、`stateStore: memory`。
- Pages origin 的 CORS 预检返回 204，并允许页面实际使用的请求头；非白名单 origin 返回 403。
- `/verify`、`/report/intent` 的线上冒烟只验证结构和边界，不生成报告、不消耗报告额度。

## 配置边界

密钥、TOTP seed 和会话签名密钥只写入新函数的加密环境变量，不进入 GitHub、Pages artifact、README、日志或截图。新函数默认是单实例 `MemoryStore`，公开扩容前必须接入带 TTL 与原子事务的外部 `StateStore`。

## 回滚

回滚只针对本仓库的 Pages workflow/commit 和 `beichen-codex-relay` 的函数版本。不要对历史 `beichen` 仓库、旧 Pages 或 `beichen-qianfan-mini` 调用更新、删除或触发器修改接口。
