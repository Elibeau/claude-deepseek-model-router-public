# Claude DeepSeek Model Router

一个本地 Anthropic-compatible Gateway 中转器，用来把 Claude Desktop / Cowork 的第三方推理请求转发到 DeepSeek，并解决以下几个实际问题：

- Claude Desktop 新版要求 `inferenceModels` 必须是合法的 Claude route，不能直接写 `deepseek-*`
- DeepSeek Pro 和 Flash 需要稳定区分，不能依赖上游做模糊映射
- Cowork 第三方模型通常没有独立的 Effort 控件，所以这里在路由层固定注入 `thinking.enabled` 和 `output_config.effort=high`
- DeepSeek 的 Anthropic-compatible API 对 `document`、`image`、`mcp_tool_use` 等内容块支持不完整，需要做兼容转换

## 功能

- 把 `claude-opus-4-7` 映射到 `deepseek-v4-pro`
- 把 `claude-sonnet-4-6` 映射到 `deepseek-v4-flash`
- 两个模型都固定启用 `high` 思考模式
- 兼容普通 `tools` / `tool_use` / `tool_result`
- 改写部分不兼容的 `tool_choice`
- 把不支持的内容块降级为文本占位
- 可选提取 PDF 文本后再发送给 DeepSeek
- 提供后台启动、停止、重启、日志查看脚本

## 目录说明

- `src/router-core.js`：核心路由与协议转换
- `src/worker.js`：Cloudflare Workers 入口
- `server.mjs`：本地 Node 服务入口
- `routerctl.sh`：本地服务管理脚本
- `router.config.example.json`：本地运行配置示例
- `claude-desktop-config.example.json`：Claude Desktop 配置示例
- `wrangler.toml.example`：Cloudflare Workers 配置示例
- `scripts/smoke-test.mjs`：本地冒烟测试脚本

## 使用方式

### 1. 安装依赖
安装后会新建`node_modules`目录，自动下载一些依赖，例如`pdf-parse`。
```bash
npm install
```

### 2. 准备本地配置

```bash
cp router.config.example.json router.config.json
```

编辑 `router.config.json`，至少改这两项：

- `gatewayApiKey`：Claude Desktop 访问本地 Router 用的 key
- `upstream.apiKey`：DeepSeek 的真实 API key

### 3. 启动本地服务

```bash
./routerctl.sh start
```

常用命令：

```bash
./routerctl.sh start
./routerctl.sh stop
./routerctl.sh restart
./routerctl.sh logs
./routerctl.sh logs -f
```

也可以用 npm scripts：

```bash
npm start
npm run stop
npm run restart
npm run logs
```

### 4. 配置 Claude Desktop / Cowork

本地模式下，在第三方推理里填写：

- Gateway base URL：`http://127.0.0.1:8787`
- Gateway API key：与你的 `router.config.json` 里的 `gatewayApiKey` 一致
- Gateway auth scheme：`bearer`

模型列表填：

```json
[
  { "name": "claude-opus-4-7", "supports1m": true },
  { "name": "claude-sonnet-4-6", "supports1m": true }
]
```

如果你直接维护 Claude Desktop 的 JSON 配置，可以参考 `claude-desktop-config.example.json`。

### 5. 验证

```bash
npm run smoke
```

它会对当前配置中的所有模型发一次测试请求。

## 当前模型映射

```text
claude-opus-4-7   -> deepseek-v4-pro   + effort=high
claude-sonnet-4-6 -> deepseek-v4-flash + effort=high
```

如果你想改成别的强度，直接修改 `router.config.json` 里的：

```json
"output_config": { "effort": "high" }
```

DeepSeek 当前常用的是 `high` 和 `max`。如果配置 `xhigh`，建议在路由层直接改成 `max`。

## 工具与文件兼容说明

Router 默认会启用这些兼容处理：

```json
{
  "compatibility": {
    "rewriteForcedToolChoice": true,
    "normalizeUnsupportedContentBlocks": true,
    "dropMcpServers": true,
    "extractPdfDocuments": true,
    "maxExtractedDocumentChars": 120000
  }
}
```

效果：

- 把部分强制工具调用改写成更稳的形式
- 尝试把 `mcp_tool_use` / `mcp_tool_result` 转成普通工具调用
- 把不支持的内容块降级为文本
- 如果本地装了 `pdf-parse`，会优先提取 PDF 文本

限制：

- 这不是 Claude 原生文件理解能力的等价替代
- 图片、PDF、MCP、容器类能力仍受 DeepSeek 兼容层能力限制
- 真正强依赖 Claude 原生文件/视觉/容器能力的任务，仍建议使用官方 Claude 模型

## HTTPS 与远程部署

Claude Desktop 某些场景下更适合连 HTTPS Gateway。这个项目也提供了 `src/worker.js` 和 `wrangler.toml.example`，可以部署到 Cloudflare Workers。

本地只用于测试时，可以先用：

```bash
http://127.0.0.1:8787
```

如果需要远程 HTTPS，可以把 Router 挂到你自己的 HTTPS 反向代理或 Cloudflare Workers 后面。
