# v3 发布验收清单

## 代码与供应链

- [x] `npm ci` 使用锁文件成功
- [x] `npm run check` 通过
- [x] `npm test` 通过（解析、前端契约、HTTP 中转）
- [x] `npm run secret-scan` 通过；工作树、`dist/` 和待推送 diff 无真实凭据
- [x] Node 运行时为 20 LTS 或受支持的 18 LTS；`scf_bootstrap` 为 LF/755

## 中转与状态

- [x] 新函数名称与历史函数不同；未修改历史函数配置或版本
- [x] `/healthz` 与 `/readyz` 返回同一版本，配置缺失时 503
- [x] CORS 只包含 Pages origin；预检允许 `x-client-version`、`x-request-id`、`x-report-intent`
- [x] 旧 token + 同 request ID 重试得到同一 receipt；不同 intent 被拒绝
- [x] 没有 intent 不能使用报告预算；不完整报告不调用完成回执
- [x] 客户端 close/abort 会终止上游；SSE 心跳可穿过空闲代理
- [ ] 多实例前已接入 TTL + CAS/事务 StateStore，或明确限制为单实例受控试用

## 页面与内容

- [x] 首次同意说明模型处理、本机保存和删除方式
- [x] 夜航、领航、取消、重开、刷新恢复、返回键和过期验证均可走通
- [x] 320×568、375×812、390×844、812×375 与桌面临界宽度下 CTA 可见
- [x] 报告显示省份/年份/未知变量/适用范围；组合覆盖率注明测算性质与官方核验入口
- [x] 键盘焦点、Escape、live region、`inert`、forced-colors 与 reduced-motion 检查通过（契约/静态验收）
- [x] 复制和 PNG 导出成功；长图失败时仍可复制文本（契约验收）

## 发布与回滚

- [x] GitHub Actions 变量 `BEICHEN_RELAY_ORIGIN` 已设置且只包含纯 origin
- [x] Pages artifact 不含 `legacy/`、`archive/`、测试、文档或云函数源码
- [ ] 页面版本、relay 版本、`build-manifest.json` SHA、tag/release 一致（最终 tag 在最后一次推送后创建）
- [x] 发布后冒烟记录只包含 request ID、状态码和延迟，不含原话或密钥
- [x] 已验证独立 Pages artifact 与独立函数版本可回滚；历史仓库/函数零改动
