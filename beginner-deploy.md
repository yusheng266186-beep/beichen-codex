# 北辰 v3 独立部署指南

这份 runbook 只针对本仓库的独立 v3 发布。它不会更新历史 GitHub 仓库、历史 Pages 或历史腾讯云函数。创建新资源时请使用清晰的新名称，例如 `beichen-codex-relay`。

## 0. 发布前准备

1. Node.js 18.20+，建议 Node 20 LTS；GitHub CLI 已登录到拥有新仓库权限的账号。
2. 一个可创建腾讯云 SCF Web Function 的账号，以及百度千帆 Token Plan personal 的服务端密钥。
3. 推荐为新函数准备单独的 TOTP seed 和至少 32 字节的随机 `GATE_SESSION_SECRET`。本次已部署实例为了不打断既有操作员的动态码而暂时沿用旧 TOTP seed；这不是长期安全配置，正式扩大范围前必须轮换并重新分发。曾经暴露过的千帆密钥仍应尽快撤销/轮换。
4. 进入仓库目录执行：

   ```bash
   npm ci
   npm run verify
   ```

   `verify` 失败时不要部署，也不要把 `.env`、日志或临时 zip 推到 GitHub。

## 1. 打包 SCF Web Function

函数只需要上传根目录的 `scf-relay.js` 与 `scf_bootstrap`，两个文件必须位于 zip 根目录。`scf_bootstrap` 会选择镜像中可运行的 Node 20/18；不要再依赖 Node 16。

Windows 上建议使用 WSL 或 Python 生成带 Unix 权限位的 zip：

```python
import zipfile

with zipfile.ZipFile("beichen-codex-relay.zip", "w", compression=zipfile.ZIP_DEFLATED) as z:
    for name in ("scf-relay.js", "scf_bootstrap"):
        info = zipfile.ZipInfo(name)
        info.external_attr = 0o755 << 16
        info.create_system = 3
        with open(name, "rb") as f:
            z.writestr(info, f.read())
```

两条硬规则：

- `scf_bootstrap` 必须是 LF 换行，不能出现 `^M`；
- `scf_bootstrap` 必须带 755 可执行位，否则会出现 `bad interpreter` 或启动失败。

## 2. 创建新的腾讯云函数

在 SCF 控制台选择“创建函数 → Web 函数”：

| 设置 | 推荐值 |
| --- | --- |
| 函数名称 | `beichen-codex-relay`（或同样明确的全新名称） |
| 地域 | 与你选择的 Pages 访问策略相符；示例使用 `ap-chengdu` |
| 运行时 | Nodejs20，Nodejs18 亦可 |
| 端口 | `9000` |
| 公网访问 | 开启 HTTPS |
| 执行超时 | 至少 240 秒；报告上游较慢时可提高到平台允许上限 |

上传 zip 后，在**加密环境变量**中填写：

```text
QIANFAN_API_KEY=<仅服务端可见>
QIANFAN_BASE_URL=https://qianfan.baidubce.com/v2/tokenplan/personal
QIANFAN_MODEL=glm-5.2
GATE_TOTP_SECRET=<新函数专用的 Base32 seed；当前兼容部署暂时沿用既有操作员 seed>
GATE_SESSION_SECRET=<新的随机字符串，至少 32 字节>
CORS_ALLOWED_ORIGINS=<Pages 的纯 origin>
PORT=9000
TRUST_PROXY=false
UPSTREAM_TIMEOUT_MS=180000
```

`CORS_ALLOWED_ORIGINS` 只写来源，例如 `https://账号.github.io`，不要写 `/仓库名/` 路径；多个来源用逗号分隔。不要填写普通后付费或 Coding Plan 专属端点，代码只允许 Token Plan personal host/path。

部署后复制**新函数**的 HTTPS origin。它将作为 Pages 仓库变量 `BEICHEN_RELAY_ORIGIN`，不要把密钥或带临时签名的完整 URL写入文档。

## 3. 配置并发布 Pages

1. 在新 GitHub 仓库 **Settings → Variables → Actions** 新建 `BEICHEN_RELAY_ORIGIN`，值为上一步的纯 origin。
2. 在 **Settings → Pages** 选择 **GitHub Actions**。
3. 推送 `main` 或手动运行 `publish-pages` workflow。工作流会先运行测试、语法检查和密钥扫描，再构建 `dist/`。
4. `dist/` 只包含页面、字体、截图组件和配置，不包含 `legacy/`、`archive/`、测试或云函数源码。
5. 发布完成后访问 workflow 输出的 `page_url`，在页面设置中确认版本为 `v3.0.0-codex`。

若 workflow 因变量为空而失败，这是预期保护：先补变量，不要在 `index.html` 中硬编码旧函数地址。

## 4. 冒烟验证

按顺序检查：

1. `GET <新函数>/healthz` 返回 JSON，`version` 为 `v3.0.0-codex`，配置完整时 HTTP 200；`stateStore` 默认为 `memory`。
2. Pages 页面输入当前 TOTP，验证成功后出现序章；刷新不会读取旧版本票据。
3. 夜航和领航各完成至少一轮，确认流式响应、取消、重新发送和返回键行为正常。
4. 生成一张完整星图，确认只在成功回执后减少一次额度；模拟刷新/重复点击不会重复扣除。
5. 打开报告、数据参考、设置，测试键盘 Tab/Escape、短屏滚动、复制和保存图片。
6. 在设置中执行“清除本机记录”，刷新后应回到星门，且 v3 命名空间不再有会话内容。

## 5. 故障排查

| 现象 | 先看什么 |
| --- | --- |
| 验证服务不可用 | `healthz`、函数公网开关、Pages origin 是否与 CORS 完全一致 |
| 预检 403/失败 | `CORS_ALLOWED_ORIGINS` 是否带了路径或尾部空格；确认 `x-client-version` 在允许头中 |
| 上游未配置 | `QIANFAN_API_KEY`、personal endpoint、模型 ID；不要改前端配置来“修”密钥 |
| 流式中断 | 函数超时、上游响应 `text/event-stream`、客户端网络；取消后上游应被销毁 |
| 额度待同步 | 保留页面提示，稍后点击“同步本次额度”；同一 request ID 会幂等重放，不要连续新建报告 |
| 页面仍是旧版 | 检查 workflow SHA、`build-manifest.json`、浏览器硬刷新；不要修改历史仓库来绕过缓存 |

响应中的 `X-Request-ID` 可提供给维护者定位请求。不要上传对话原文、Authorization、TOTP、cookie 或环境变量截图。

## 6. 状态存储与回滚

默认 `MemoryStore` 只适合单实例受控试用；函数重启或多实例扩容会使会话失效。正式公开前应实现 `StateStore` 适配器，使用带 TTL 与原子 CAS/事务的外部 KV，并在健康检查中确认 `stateStore: external`。

回滚时只切换**独立函数版本**与 Pages workflow/commit；先确认状态 schema 向后兼容。已撤销的凭据不能通过回滚恢复，历史函数和仓库始终不在本 runbook 的操作范围内。

## 7. 绝对不要做

- 不要更新或删除历史 `beichen` 仓库、历史 Pages 或历史腾讯云函数；
- 不要把真实 Key、TOTP seed、session secret 写入 Git、Issue、截图、日志或构建产物；
- 不要把 `legacy/` 或 `archive/` 目录直接设为 Pages 根目录；
- 不要把客户端传入的 `max_tokens` 当成报告授权，报告必须经过 `/report/intent`；
- 不要在取消或报错时手工重复点击“点亮”直到额度变化，先查看 request ID 和待同步状态。
