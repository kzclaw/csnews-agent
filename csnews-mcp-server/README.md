# CSNEWS MCP Server 配置指南

## 一句话解释

Claude Desktop / Cursor 里直接问"最新爆炸新闻是什么"，AI 会帮你查 CSNEWS 数据库返回结果，不用打开网页。

---

## 前置条件

1. CSNEWS Token（你 viewer 里配置的那个 64 位 hex）
2. Node.js 18+ 已安装（`node --version` 检查）

---

## 第一步：填入你的 Token 和 Worker 地址

打开 `claude_desktop_config.json`，找到这两行：

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

把配置文件复制到正确位置：

```bash
cp claude_desktop_config.json ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

> 如果提示目录不存在，先打开一次 Claude Desktop，它会自动创建目录。

---

## 第三步：安装依赖（首次）

```bash
cd csnews-mcp-server
npm install
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

**Q: 如何更新 Token？**
→ 编辑 `~/Library/Application Support/Claude/claude_desktop_config.json` 后重启 Claude Desktop

**Q: Cursor 怎么配置？**
→ Cursor 的 MCP 配置路径不同，请参考 Cursor 官方文档 MCP 配置部分，指向同样的 `csnews-mcp-server` 路径即可
