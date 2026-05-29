# CSNEWS Agent

> News Self Growth on Cloudflare Workers + Supabase

利用 Cloudflare Workers AI + Supabase 免费能力构建零 token 成本的智能新闻裂变搜索与趋势预测系统。

## 技术栈

- **Cloudflare Workers** — 边缘计算 + Workers AI（@cf/meta/llama-3.3-70b-instruct-faster)
- **Supabase** — PostgreSQL + pgvector 向量存储 + Edge Functions
- **Cloudflare R2** — 原始新闻 JSON + 报告 Markdown 存储
- **ZAKER API** — 中文新闻源

## 架构

```
news-scan (Cron) → Workers AI 评分/分类 → Supabase 入库
fission-research (Cron) → Workers AI 裂变搜索 → R2 存储报告
WeCom 推送摘要
```

## 项目状态

H1 验证中（Workers AI 中文质量测试）