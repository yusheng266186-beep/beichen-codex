# 北辰 · v3 Codex 独立发布

> 譬彼北辰，居其所而众星共之。——《论语·为政》

北辰是一款面向高中生的选科探索与自我整理网页。它先从真实经历、学科手感、热爱、学习方式和现实约束出发，再把谈心线索整理成一张可核对的「北辰星图」。星图提供方向、组合和专业调研线索，但不替学生作决定，也不是心理测评或招生承诺。

**当前版本：`v3.0.0-codex`**

- 在线页面：[GitHub Pages](https://yusheng266186-beep.github.io/beichen-codex/)
- 源码仓库：[yusheng266186-beep/beichen-codex](https://github.com/yusheng266186-beep/beichen-codex)
- 中转服务：独立的腾讯云 SCF Web Function `beichen-codex-relay`（Nodejs20.19）
- 健康检查：[新函数 `/healthz`](https://1459223409-ljunx7cpn8.ap-chengdu.tencentscf.com/healthz)
- 发布方式：GitHub Actions 构建白名单目录并部署 Pages

以上页面和函数均属于本次独立 v3 发布；历史 `beichen` 仓库、旧 Pages 和
`beichen-qianfan-mini` 函数不在本项目的更新范围内。

<!-- project-navigation:start -->
## 项目概览

| 项目 | 说明 |
| --- | --- |
| 分类 | 选科与升学探索 |
| 平台 | 浏览器 / AI 中转 |
| 当前定位 | 独立发布线 |

面向高中生的选科探索网页，提供夜航 / 领航两种谈心方式与星图报告。

[在线体验](https://yusheng266186-beep.github.io/beichen-codex/) · [版本与下载](https://github.com/yusheng266186-beep/beichen-codex/releases) · [使用与开发](#本地开发) · [项目总导航](https://github.com/yusheng266186-beep/yusheng266186-beep)

本库独立维护 v3 页面和中转服务；[北辰主线](https://github.com/yusheng266186-beep/beichen) 与本库有各自的发布记录。历史调试过程见已归档的 [beichen-v3-debug](https://github.com/yusheng266186-beep/beichen-v3-debug)。

**阅读导航：** [本地开发](#本地开发) · [隐私、未成年人和事实边界](#隐私未成年人和事实边界) · [这次大版本解决了什么](#这次大版本解决了什么) · [架构](#架构) · [目录](#目录)

<!-- project-navigation:end -->

## 这次大版本解决了什么

### 产品与内容

- **夜航 / 领航双模式**：夜航用开放式对话慢慢建立画像；领航提供四个低压力选项与学科手感组件。
- **五幕谈心**：初见、底色、热爱、远方、星图。每轮先回应，再自然推进一个问题；报告后进入问答模式，不再强行提问。
- **星图固定结构**：方向轴、星值、五张星卡、首选/备选 3+1+2 组合、专业方向解析和寄语。
- **不确定性可见**：资料不足、方位冲突、缺省省份/年份、成绩/位次和专业硬门槛都会在报告中明确标出。
- **事实边界**：数据参考页显示适用省份、统计年份、整理日期和官方核验入口；覆盖率是量级参考，不是当年招生计划。
- **安全支持分流**：检测到明显的自伤风险表达时显示固定支持提示，鼓励联系可信任成年人和当地紧急服务；模型不承担危机处置。

### 交互、视觉与流畅性

- 暖纸色、墨色、朱红/靛蓝和五幕进度线形成统一视觉语言；标题使用衬线，控件和数字使用系统无衬线。
- 流式输出按 `requestAnimationFrame` 批量更新，等待阶段显示可理解的固定状态；不把模型链式思考内容展示或持久化。
- 每个请求拥有 `epoch + AbortController + frame` 生命周期；取消、重开、过期验证和旧响应不能写入新会话。
- 报告生成前先取得一次性 intent，完整报告才记账；网络重试通过 `sid + requestId` 幂等回放，不重复扣额度。
- 适配软键盘、刘海安全区、短屏和横屏；支持键盘焦点圈、`aria-live`、`inert`、`prefers-reduced-motion` 和 forced-colors。
- 报告长卡保留可见滚动条；PNG 导出按 1,200 万像素上限自适应，失败时提供文字复制路径。

## 架构

```text
浏览器（GitHub Pages）
  ├─ 版本化本机存储：beichen_codex_*（明确同意后可选 7 天记录）
  ├─ 当前标签页票据：bc_codex_*（关闭标签页即失效）
  ├─ POST /verify
  ├─ POST /report/intent
  ├─ POST /chat/completions（SSE）
  └─ POST /run/complete（幂等额度回执）
             │ 精确 CORS + 安全响应头
             ▼
独立腾讯云 SCF Web Function（建议名称：beichen-codex-relay）
  ├─ TOTP 一次性消费与 HMAC v2 会话票据
  ├─ 报告 intent、轮次预留/结算、requestId 回执
  ├─ 上游白名单、请求/响应大小、超时、SSE 心跳与断连终止
  └─ 仅从加密环境变量读取千帆凭据
             ▼
百度千帆 Token Plan personal endpoint（服务端固定模型与思考预算）
```

### 状态与扩容说明

`scf-relay.js` 默认使用进程内 `MemoryStore`，适合本地测试和单实例受控试用。它实现了同一 `sid` 内的串行临界区，但**不能**跨实例或重启保留会话。代码提供 `StateStore` 契约和 `setStateStore(adapter)` 注入点；正式扩容前必须接入支持 TTL、CAS/事务的外部 KV/数据库，并让 `withLock(sid, callback)` 原子读改写完整状态。健康检查会返回 `stateStore: memory|external`，不会假装内存状态是持久化服务。

外部适配器的 `get`、`set` 可以返回 Promise；`withLock` 仍必须在同一 `sid` 上完成原子读改写，不能只在应用层拼接 JSON。

## 服务端接口契约

| 路径 | 方法 | 作用 | 关键约束 |
| --- | --- | --- | --- |
| `/verify` | POST | 消费 6 位 TOTP 并签发会话票据 | JSON；服务端限流；TOTP 窗口 ±1；同一窗口一次性消费 |
| `/report/intent` | POST | 为一组规范化消息签发短时报告意图 | `evidenceHash` 必须是 64 位 SHA-256；同一会话最多一个进行中意图 |
| `/chat/completions` | POST | 代理日常或报告 SSE | 必须有 user 消息；system 只能在最前；报告必须带 intent；报告预算由服务端固定 |
| `/run/complete` | POST | 对完整报告记一次额度并轮换票据 | `X-Request-ID` 8–96 字符；同一 `sid + requestId + intent` 可安全重放 |
| `/healthz` | GET | 配置状态与版本探针 | 不返回密钥；配置不完整时 503 |
| `/readyz` | GET | 部署平台就绪探针 | 与 `/healthz` 同一安全边界 |

所有非空 query 路径均拒绝；CORS 只放行 `CORS_ALLOWED_ORIGINS` 精确匹配的来源。响应不缓存，返回 `X-Request-ID` 供排障使用。日志不得记录原话、token、TOTP 或模型密钥。

## 本地开发

要求 Node.js 18.20+（发布工作流使用 Node 20）。

```bash
npm ci
npm run check          # relay、runtime-config、内联 HTML 脚本语法
npm test               # parse / index contract / relay HTTP contract
npm run secret-scan    # 源码、归档和构建前密钥模式扫描
npm run build:pages    # 生成 dist/；默认保留 relay 占位符
npm run verify         # 上面四项一次跑完并构建 Pages
```

本地查看页面：

```bash
node -e "require('http').createServer((q,s)=>require('fs').createReadStream(q.url==='/'?'index.html':'.'+q.url).on('error',()=>{s.statusCode=404;s.end()}).pipe(s)).listen(8766)"
```

页面首次打开会要求独立中转地址和动态验证码；未配置 `runtime-config.js` 时会明确提示，不会回退到历史函数。

## 发布 GitHub Pages

Pages 工作流只复制以下资源到 `dist/`：`index.html`、`runtime-config.js`、`fonts/`、`vendor/html2canvas.min.js`、`.nojekyll`、`404.html` 和构建清单。`legacy/`、`archive/`、测试、部署文档和云函数源码不会被当作网页入口发布。

1. 在仓库 **Settings → Variables → Actions** 设置 `BEICHEN_RELAY_ORIGIN`，值为独立 SCF 函数的纯 origin（例如 `https://<new-function-id>.ap-chengdu.tencentscf.com`，不要带路径、参数或凭据）。
2. 推送到 `main`；`ci.yml` 先执行语法、测试、密钥扫描和构建，`pages.yml` 再部署。
3. 首次启用 Pages 时选择 **GitHub Actions**。发布完成后以工作流输出的 `page_url` 为准，并把该 origin 原样填入 SCF 的 `CORS_ALLOWED_ORIGINS`。
4. 页面显示的版本、`build-manifest.json` 的 `gitSha`、relay `/healthz` 的版本和 release tag 必须一致。

如果变量为空，Pages 工作流会主动失败，避免发布一个看似正常但永远无法验证的页面。构建脚本支持本地占位符，便于离线检查。

## 创建独立腾讯云函数

请只创建新函数（建议名称 `beichen-codex-relay`），不要更新历史函数或把历史函数切换到这份代码。生产密钥应为新函数单独管理的加密变量；本次交付为兼容既有操作员动态码而暂时沿用了现有 TOTP seed，正式扩大范围前必须轮换并重新分发。根目录提供 `scf-relay.js` 与 `scf_bootstrap`；后者要求 LF 换行和 755 权限，打包前请阅读 [beginner-deploy.md](beginner-deploy.md)。

建议环境变量：

| 变量 | 说明 |
| --- | --- |
| `QIANFAN_API_KEY` | 千帆 Token Plan personal 的服务端密钥 |
| `QIANFAN_BASE_URL` | 默认 `https://qianfan.baidubce.com/v2/tokenplan/personal` |
| `QIANFAN_MODEL` | 默认 `glm-5.2` |
| `GATE_TOTP_SECRET` | Base32 TOTP seed，仅放加密环境变量 |
| `GATE_SESSION_SECRET` | 至少 32 字节随机签名密钥 |
| `CORS_ALLOWED_ORIGINS` | Pages 的 origin，可逗号分隔多个受控来源 |
| `PORT` | `9000` |
| `TRUST_PROXY` | 只有平台明确提供可信代理头时才设为 `true` |
| `UPSTREAM_TIMEOUT_MS` | 默认 180 秒；报告可按平台上限调整 |

不要把任何真实值写进仓库、Issue、截图、日志或前端。发布前先轮换曾经出现在历史材料中的凭据；本项目不尝试修复或修改历史云函数。

## 隐私、未成年人和事实边界

- 首次进入需要明确同意：输入会发送给模型服务；不要填写姓名、电话、住址、学校班级等可识别信息。
- 谈心记录和报告只有在序章勾选“本机保留 7 天”后才写入 Web Storage，带版本命名空间和过期时间；认证票据只留在当前标签页的 sessionStorage（不可用时仅留内存）。“清除本机记录”会同时删除当前版本的会话、画像、同意、模式和票据。
- 云函数只保存完成一次请求所需的短期状态；默认 MemoryStore 重启即失效。上游模型供应商的处理与保留以其当时政策为准。
- 报告中的组合、覆盖率、招生计划和专业门槛都可能随省份与年份变化；正式选科必须核对本省教育考试院、阳光高考和目标高校招生章程。
- 发现自伤或无法保证安全的表达时，页面只提供固定的求助提醒；请立即联系身边可信任的成年人、老师或当地紧急服务。北辰不能替代心理、医疗或危机干预。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html` | 独立 v3 单页：界面、样式、双模式状态机、报告解析与导出 |
| `runtime-config.js` | 发布时注入 relay origin 的无密钥配置 |
| `scf-relay.js` | Node 原生 HTTP/HTTPS 中转、认证、额度与 SSE |
| `scf_bootstrap` | SCF 启动脚本 |
| `fonts/` | 自托管字体资源，避免第三方字体请求 |
| `vendor/` | 自托管 html2canvas |
| `tests/` | 解析、前端契约和真实 HTTP fake-upstream 测试 |
| `scripts/` | 跨平台测试、内联脚本检查、密钥扫描和 Pages 构建 |
| `.github/workflows/` | CI 与 Pages 发布流程 |
| `legacy/` | 仅保留 v1 退役标记，不可执行、不连接旧服务 |
| `archive/` | 历史调试材料，永不进入 Pages 构建目录 |
| `docs/` | 架构、隐私、发布验收和实际部署记录 |

## 版本与回滚

版本源头是 `APP_VERSION`、`runtime-config.js`、`package.json` 和发布 tag。任何行为变更都应：

1. 先补测试契约；
2. 本地运行 `npm run verify`；
3. 检查 `dist/build-manifest.json`、Pages URL 和 relay `/healthz`；
4. 再创建同版本 tag/release。

回滚只回滚独立仓库的 Pages artifact、工作流 commit 和独立函数版本；不要触碰历史仓库或历史函数。已被轮换的凭据不能通过回滚恢复。

## 许可证与免责声明

本仓库是面向个人受控试用的独立迭代。除非另有书面说明，代码与内容不构成招生、职业、心理或医疗建议。星图只帮助整理问题，最终决定由学生、家长和学校在核对官方信息后共同作出。
