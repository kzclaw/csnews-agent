# CSNEWS Agent

> News Self Growth · Powered by Cloudflare Workers AI + Supabase + R2

利用 Cloudflare Workers AI 免费模型 + Supabase 免费层 + R2 免费额度，实现零 Token 成本的智能新闻追踪与自生长系统。

---

## 项目架构

```
ZAKER API（新闻源）
       ↓
 Cloudflare Worker（边缘计算）
   ├── 规则引擎评分（scoreRule）
   ├── Workers AI bge-m3（向量嵌入）
   └── Supabase RPC（向量查重 + 话题簇积分）
       ↓
   ├── news_hotspots（新闻记录）
   ├── topics（话题簇）
   └── news_topic_members（关联表）
       ↓
 Cloudflare R2（去重存储层）
```

---

## 核心机制

### 两层分离原则

| 层 | 存储位置 | 触发条件 | 用途 |
|---|---------|---------|------|
| **实时打分层** | Supabase | 每条新闻都要打分 | 话题簇积分 + 升级/裂变 |
| **去重存储层** | R2 | 仅「内容足够不同」才存 | 持久化存储，按相似度过滤 |

### News Self Growth 三级制度

| 等级 | 升级条件 | 清理周期 |
|------|---------|---------|
| **跟进** | 建簇即得 | 7天无新相似新闻 |
| **重要** | 积分达到 3/6/9 | 14天无新相似新闻 |
| **爆炸** | 积分达到 9 | 28天无新相似新闻 |

**积分规则**：相似新闻入库 → 话题簇 +1 分 → 积分触发升级/裂变

---

## 技术栈

| 组件 | 服务 | 用途 |
|------|------|------|
| **Workers AI** | `@cf/baai/bge-m3` | 1024维向量嵌入 |
| **Workers AI** | `@cf/moonshotai/kimi-k2.5` | 中文分类（备选） |
| **Workers AI** | `@cf/meta/llama-3-8b-instruct` | AI 报告生成（待启用） |
| **Supabase** | PostgreSQL + pgvector | 向量查重 + 话题簇管理 |
| **R2** | csnews-raw bucket | 原始新闻 JSON 存储 |

---

## 项目状态

| 模块 | 状态 | 说明 |
|------|------|------|
| ZAKER API 接入 | ✅ 完成 | 每2h cron 拉取10条 |
| 规则引擎评分 | ✅ 完成 | 基准5.0 + 热词加成 |
| bge-m3 向量嵌入 | ✅ 完成 | 前6条 embedding |
| 向量查重 | ✅ 完成 | 相似度阈值 0.88 |
| Supabase 写入 | ✅ 完成 | topics + news_hotspots + news_topic_members |
| R2 去重存储 | ✅ 完成 | 相似度 < 0.75 才存 R2 |
| AI 评分对比 | 🔄 待做 | KR0：50条误差 < 15% |
| 裂变报告 | ⏸ 暂缓 | fission 需持续积分触发 |

---

## 目录结构

```
csnews-agent/
├── src/
│   └── index.ts          # 主 Worker 代码
├── wrangler.toml         # Cloudflare 配置
├── README.md             # 本文件，技术文档
└── .gitignore            # 排除 secrets / .wrangler/
```

> 完整 OKR 见：
> `~/.kzopenclaw/kz/workspace/tasks/csnews-agent-okr.md`
> Obsidian：`第二大脑/📂 项目/CSNEWS AGENT/`

---

*kzclaw🍤 | 2026-05-30*