# Anthropic-Compatible `defer_loading` 验证器

[![验证工作流](https://github.com/Cloud370/anthropic-defer-loading-validator/actions/workflows/validate.yml/badge.svg)](https://github.com/Cloud370/anthropic-defer-loading-validator/actions/workflows/validate.yml)

这是一个**公开、可复现、以结论为导向**的 Node.js 验证器，用来检查某个 Anthropic-compatible 接口是否真的实现了 `defer_loading` 保护 prompt cache 的语义，而不只是“字段能过”。

当前默认 profile 是：**DeepSeek 官方 Anthropic 接口**。

## 它验证什么

验证器会做 3 件事：

1. `defer_search_probe`
发送一条真正接近 Anthropic tool-search 路径的请求，检查接口是否接受相关请求面。

2. `inline control pair`
对同一个 inline tools 请求发送两次，中间默认间隔 5 秒，确认 provider 自己的 prompt cache 是否存在且可命中。

3. `fresh inline vs fresh defer_only`
构造两组全新前缀：
- `fresh_inline`
- `fresh_defer_only`

如果 `defer_loading` 真正生效，那么 `fresh_defer_only` 的首轮 processed tokens 应该明显小于 `fresh_inline`。

## 当前默认结论口径

工作流 summary 会直接给出：

- 控制组 prompt cache 是否命中
- `defer_loading` 请求是否被接受
- 真正的 defer search 请求面是否被接受
- `fresh defer` 是否比 `fresh inline` 更小
- 最终判定：`supported / unsupported / ambiguous`

## 仓库结构

```text
.
├── validate_defer_loading.mjs   # 主验证脚本
├── validator_lib.mjs            # 公共逻辑
├── validator.test.mjs           # 单元测试
├── profiles/
│   └── deepseek.json            # 默认 provider profile
└── .github/workflows/
    └── validate.yml             # GitHub Actions
```

## 本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 跑测试

```bash
npm test
```

### 3. 跑默认 DeepSeek profile

```bash
export DEEPSEEK_API_KEY="<YOUR_KEY>"
node validate_defer_loading.mjs
```

### 4. 覆盖参数

```bash
export DEEPSEEK_API_KEY="<YOUR_KEY>"
node validate_defer_loading.mjs \
  --profile ./profiles/deepseek.json \
  --tool-count 8 \
  --interval-ms 5000 \
  --target-topic "project orbit delayed orders"
```

## GitHub Action

工作流支持：

- `workflow_dispatch`
- `push`
- `schedule`

运行后会产出：

1. `validation.last.json`
2. `validation.summary.md`
3. GitHub Job Summary 中的直观结论

## 当前样例结果（默认 DeepSeek profile）

以下是本仓库当前默认 profile 的一组验证样例：

- `defer_search_probe`: **400**，请求面未被接受
- `inline_control_first`: `processed=958`, `cache_read=0`
- `inline_control_second`: `processed=62`, `cache_read=896`
- `fresh_inline`: `processed=960`, `cache_read=0`
- `fresh_defer_only`: `processed=960`, `cache_read=0`
- `verdict`: **unsupported**

这意味着：

1. 控制组确认 DeepSeek 官方接口存在可观测的 prompt cache。
2. 但在 fresh 对照中，`defer_loading: true` 没有让首轮 processed tokens 变小。
3. 因此，当前接口未体现 Anthropic 文档定义的 `defer_loading` 保护顶部 prompt cache 的语义。

## Secret 配置

当前默认 profile 需要：

- `DEEPSEEK_API_KEY`

如果你要扩展到别的厂商：

1. 新增一个 `profiles/<vendor>.json`
2. 在该 profile 里指定认证方式和环境变量名
3. 在 GitHub 仓库里新增对应 secret

## Profile 设计

`profiles/*.json` 负责描述 provider 差异，例如：

- `endpoint`
- `model`
- `auth.type`
- `auth.env`
- 固定 headers
- 是否启用 `defer_search_probe`
- 是否保留 top-level `cache_control`

这样仓库名和脚本结构尽量保持通用，不被单一厂商绑定。

## 许可证

MIT
