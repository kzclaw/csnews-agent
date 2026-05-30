# CSNEWS Agent

> 新闻自生长系统 · News Self Growth on Cloudflare Workers + Supabase

利用 Cloudflare Workers AI 免费模型 + Supabase 免费层 + R2 免费额度，实现零 Token 成本的智能新闻裂变搜索与趋势预测系统。

---

## 技术栈

| 组件 | 服务 | 用途 |
|------|------|------|
| **运行时** | Cloudflare Workers | 边缘计算 + Workers AI |
| **AI** | `@cf/baai/bge-m3` | 1024维向量嵌入 |
| **AI** | `@cf/moonshotai/kimi-k2.5` | 中文分类（70%准确率）|
| **数据库** | Supabase PostgreSQL + pgvector | 向量存储 + 话题簇管理 |
| **存储** | Cloudflare R2 | 原始新闻 JSON + 报告 Markdown |
| **数据源** | ZAKER API | 中文新闻源 |

---

## 架构

```
news-scan (Cron) → Workers AI 评分/分类 → Supabase 入库
fission-research (Cron) → Workers AI 裂变搜索 → R2 存储报告
WeCom 推送摘要
```

---

## 项目状态

**H1 通过**：Workers AI 中文分类 70% · OKR v0.8

**当前进度**：M0 阶段，embedding + 向量查重已上线运行

---

## 目录结构

```
csnews-agent/
├── src/                  # 主 Worker 代码
├── wrangler.toml         # Cloudflare 配置
├── README.md             # Worker 详细文档
└── supabase/
    └── migrations/        # 数据库 Schema
```

---

## 相关文档

- **Worker 部署文档**：`csnews-agent/README.md`
- **完整 OKR**：`~/.kzopenclaw/kz/workspace/tasks/csnews-agent-okr.md`
- **Obsidian**：`第二大脑/📂 项目/CSNEWS AGENT/`

---

*kzclaw🍤 · 2026-05-31*