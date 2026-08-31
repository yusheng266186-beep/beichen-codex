# v3 架构决策记录

## 边界

本目录属于 `beichen-codex` 独立发布，不共享历史仓库的 Git 状态、Pages 入口、Web Storage 键或云函数。历史素材只作阅读与演进记录；Pages 构建脚本用白名单复制资源，不能把归档目录误发布。新函数的运行状态与签名密钥独立注入；为保持现有操作员动态码兼容，部署时可能暂时复用同一 TOTP seed，正式公开前应按安全流程单独轮换。

## 请求生命周期

1. `/verify` 校验 TOTP，创建 `sid/jti/seq` 状态并签发 HMAC v2 票据。
2. 日常聊天先验证当前 `jti/seq/runs`，再预留一个会话轮次；上游失败或客户端断开只释放预留，不增加已用轮次。
3. 报告先用规范化消息的 SHA-256 申请短时 intent；中转重新计算摘要，拒绝缺失/错绑 intent 的报告请求。
4. 上游完整返回后，前端只接受 `_complete === true` 的报告；`/run/complete` 以 `sid + requestId + intent` 原子记账并返回可重放 receipt。
5. 前端把认证票据放在当前标签页的 sessionStorage（不可用时仅留内存），把结构化文本的 7 天持久化作为明确可选项；恢复时重新通过渲染器转义，过期或用户清除后不恢复。

## 失败语义

| 阶段 | 失败结果 | 是否计费 |
| --- | --- | --- |
| TOTP | 明确错误并留在星门 | 否 |
| intent | 显示可重试状态，不发送报告 | 否 |
| 日常上游 | 保留用户原话，允许一次安全重试 | 否（会话轮次预留释放） |
| 报告断流/不完整 | 显示“不完整”，可重新点亮 | 否 |
| 报告完整但回执丢失 | 保存待同步 receipt，按同一 request ID 重试 | 最多一次 |
| 取消/重新测试 | 终止当前上下文，旧回调不能写新 epoch | 否 |

## StateStore 契约

生产适配器需要实现：

```js
get(sid) -> state | null (or Promise)
set(sid, state) -> state (or Promise)
withLock(sid, async callback) -> callback result (atomic)
```

`withLock` 必须在外部存储中完成原子读-改-写，并保留 `exp`、`jti`、`seq`、`runs`、`turns`、`pendingTurns`、`intents`、`reportSuccesses` 与 `completions`。每个集合都要有 TTL/上限清理；不能把 JSON 字符串拼接当作 CAS。注入方式为进程启动前设置 `globalThis.__BEICHEN_STATE_STORE`，或调用导出的 `setStateStore(adapter)`。请求不能动态注入适配器。

## 版本策略

`APP_VERSION` 是 relay 的服务契约版本；`runtime-config.js` 与页面 CSP 由同一构建脚本注入 origin；`build-manifest.json` 记录 Git SHA。修改任一接口、报告字段、存储 schema 或额度逻辑时，必须更新测试、README 和 release tag。
