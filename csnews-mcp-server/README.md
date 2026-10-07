# CSNEWS MCP Server 配置指南

## 一句话解释

Claude Desktop / Cursor 里直接问"最新爆炸新闻是什么"，AI 会帮你查 CSNEWS 数据库返回结果，不用打开网页。

---

## 前置条件

1. CSNEWS Token（你 viewer 里配置的那个 64 位 hex）
2. Node.js 18+ 已安装（`node --version` 检查）

---

## 第一步：填入你的 Token 和 Worker 地址

在 MCP 配置里填这两个环境变量（完整片段见第二步）：

```json
"CSNEWS_URL": "https://YOUR-WORKER.workers.dev/api/v1",
"CSNEWS_TOKEN": "把你的 Token 粘贴在这里"
```

`CSNEWS_URL` **没有默认值，必须填**：填 Worker 的 `/api/v1` 地址，域名用你自己的 Worker。
留空启动会直接报错退出（exit 1），不会静默连到任何地址。

`CSNEWS_TOKEN` 填 Token，例如：

```json
"CSNEWS_TOKEN": "a1b2c3d4e5f6..."
```

---

## 第二步：安装 Claude Desktop 配置

配置文件是**本机私有文件**，被 `csnews-mcp-server/.gitignore` 排除、不入库，所以新 clone 后的仓库里不会有它。
所以不要去仓库里 `cp`，直接自己新建：

```bash
mkdir -p ~/Library/Application\ Support/Claude
```

然后打开 `~/Library/Application Support/Claude/claude_desktop_config.json`，
把下面的片段粘进去（连同你已有的其他 MCP 配置一起）：

```json
{
  "mcpServers": {
    "csnews": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/csnews-mcp-server/src/index.cjs"
      ],
      "env": {
        "CSNEWS_URL": "https://YOUR-WORKER.workers.dev/api/v1",
        "CSNEWS_TOKEN": "YOUR-64-HEX-TOKEN"
      }
    }
  }
}
```

三处都要自己改：

| 占位符 | 换成 | 怎么拿 |
|---|---|---|
| `/ABSOLUTE/PATH/TO/csnews-mcp-server/src/index.cjs` | 你本机仓库的**绝对路径** | `cd` 到 `csnews-mcp-server` 后执行 `pwd`，拼上 `/src/index.cjs` |
| `YOUR-WORKER.workers.dev` | 你自己的 Worker 域名 | 结尾必须是 `/api/v1`，不能少也不能多 |
| `YOUR-64-HEX-TOKEN` | 你的 64 位 hex Token | viewer 里配置的那个 |

> 路径必须是绝对路径 —— Claude Desktop 启动 MCP server 时的工作目录不是你的仓库目录，相对路径会找不到文件。
>
> 如果 `claude_desktop_config.json` 已经存在（你装过别的 MCP server），只合并 `mcpServers` 下这一个键，别覆盖整个文件。

---

## 第三步：安装依赖（首次）

```bash
cd csnews-mcp-server
pnpm install
```

---

## 第四步：重启 Claude Desktop

关闭 Claude Desktop，重新打开。

打开后按 `⌘K`，输入：
```
最新爆炸级新闻有哪些？
```

Claude 应该会调用 CSNEWS MCP 工具，返回新闻列表。

---

## 9 个可用工具

| 工具 | 用途 | 参数 |
|------|------|------|
| `get_latest_news` | 最新新闻列表，按创建时间倒序 | `limit` / `max_hours` |
| `get_explosive_topics` | 爆炸级话题排行，按分数倒序 | `limit` |
| `get_warnings` | 活跃系统警告 | `severity` / `status` / `limit` |
| `get_trending_velocity` | 趋势速度排名（hot + mature） | `limit` |
| `get_topic_acceleration` | 指定话题加速度历史 | `topic_id`（必填）/ `limit` |
| `get_daily_report` | 每日摘要报告 | 无 |
| `get_explosive_fission_reports` | 裂变子系统生成的衍生报告，按触发时间倒序 | `limit` / `max_hours` / `topic_id` |
| `get_entity_profile` | 实体档案库（人物/机构/地点/时间/概念） | `limit` / `entity_type` / `order_by` |
| `get_knowledge_articles` | 知识引擎累积的洞察条目 | `limit` / `topic_id` / `order_by` |

---

## 常见问题

**Q: Claude 没反应？**
→ 检查 Token 是否正确填入，CSNEWS Worker 是否在线（打开 viewer 看状态）

**Q: 显示"未设置 CSNEWS_TOKEN"？**
→ 确认 `claude_desktop_config.json` 里的 Token 已填好，然后重启 Claude Desktop

**Q: 显示"错误：必须设置环境变量 CSNEWS_URL"？**
→ `CSNEWS_URL` 没有默认值，**必须**填 Worker 的 `/api/v1` 地址（以 `https://` 开头、结尾带 `/api/v1`）。未填时 MCP server **不会启动**：这两行错误写进 stderr，进程以退出码 1 结束，不会静默连到任何地址。同理，`CSNEWS_URL` 与 `CSNEWS_TOKEN` 两行都要在同一个 `env` 块里，改完重启 Claude Desktop

**Q: 如何更新 Token？**
→ 编辑 `~/Library/Application Support/Claude/claude_desktop_config.json` 后重启 Claude Desktop

**Q: Cursor 怎么配置？**
→ Cursor 的 MCP 配置路径不同，请参考 Cursor 官方文档 MCP 配置部分，指向同样的 `csnews-mcp-server` 路径即可
