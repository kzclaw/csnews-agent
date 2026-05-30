# CSNEWS Agent · 主 Worker

> 新闻自生长系统 · Cloudflare Workers AI + Supabase + R2

利用 Cloudflare Workers AI 免费模型 + Supabase 免费层 + R2 免费额度，实现零 Token 成本的智能新闻追踪与自生长系统。

---

## 技术架构

```
ZAKER 热榜
     ↓
┌──────────────────────────────────────┐
│         Cloudflare Worker            │
│  ┌────────────────────────────────┐  │
│  │  规则引擎评分（scoreRule）      │  │
│  │  基准 5.0 + 热词加成，AI路由≥7.0│  │
│  ├────────────────────────────────┤  │
│  │  Workers AI                    │  │
│  │  @cf/baai/bge-m3（向量嵌入）   │  │
│  │  @cf/baai/bge-m3（向量嵌入）   │  │
│  ├────────────────────────────────┤  │
│  │  Supabase RPC                  │  │
│  │  findSimilarNews（向量查重）   │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
     ↓                    ↓
  Supabase（RAG）       R2（去重存储）
```

---

## 核心机制

### 两层分离原则

| 层 | 存储位置 | 触发条件 | 用途 |
|---|---------|---------|------|
| **实时打分层** | Supabase | 每条新闻都要打分 | 话题簇积分 + 升级/裂变 |
| **去重存储层** | R2 | 仅「内容足够不同」才存 | 持久化存储，按相似度过滤 |

### 自生长三级制度

| 等级 | 触发条件 | 清理周期 |
|------|---------|---------|
| 🟢 跟进 | 建簇即得 | 7天无新相似新闻 |
| 🟡 重要 | 积分达到 3/6/9 | 14天无新相似新闻 |
| 🔴 爆炸 | 积分达到 9 | 28天无新相似新闻 |

---

## 技术栈

| 组件 | 服务 | 用途 |
|------|------|------|
| **运行时** | Cloudflare Workers | 边缘计算 |
| **AI** | `@cf/baai/bge-m3` | 1024维向量嵌入 |
| **AI** | `@cf/moonshotai/kimi-k2.5` | 中文分类（备选） |
| **AI** | `@cf/meta/llama-3-8b-instruct` | AI 报告生成（待启用） |
| **数据库** | Supabase PostgreSQL + pgvector | 向量查重 + 话题簇管理 |
| **存储** | R2 `csnews-raw` bucket | 原始新闻 JSON 去重存储 |

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
| AI 评分对比 | 🔜 待做 | KR0：50条误差 < 15% |
| 裂变报告 | ⏸ 暂缓 | fission 需持续积分触发 |

---

## API 接口

| 端点 | 认证 | 说明 |
|------|------|------|
| `/?action=ping` | ✅ | 健康检查 |
| `/?action=zaker-hot` | ✅ | ZAKER 热榜抓取 |
| `/?action=process` | ✅ | 完整流程：评分→嵌入→查重→入库 |
| `/?action=score&title=...` | ✅ | 单条新闻规则引擎评分 |
| `/?action=batch-score` | POST | 批量评分（JSON body）|
| `/?action=embed&text=...` | ✅ | bge-m3 1024维向量输出 |
| `/?action=diag` | ✅ | Supabase 三表联调诊断 |
| `/?action=list` | ✅ | 列出 R2 中的新闻 |
| `/?action=save` | ✅ | 手动存新闻到 R2 |

---

## 快速部署

```bash
# 1. 克隆仓库
git clone https://github.com/kzclaw/csnews-agent.git
cd csnews-agent/csnews-agent

# 2. 配置密钥（必须）
npx wrangler secret put BEARER_TOKEN
npx wrangler secret put SUPABASE_SERVICE_KEY

# 3. 创建 R2 Bucket（Cloudflare Dashboard）
# 登录 dash.cloudflare.com
# Workers & Pages → R2 Object Storage → 创建 Bucket "csnews-raw"

# 4. 部署
npx wrangler deploy
```

---

## 目录结构

```
csnews-agent/
├── src/
│   └── index.ts          # 主 Worker 代码
├── wrangler.toml         # Cloudflare 配置
├── README.md             # 本文件
└── .gitignore
```

> 完整 OKR 文档：
> `tasks/csnews-agent-okr.md`
> Obsidian：`第二大脑/📂 项目/CSNEWS AGENT/`

---

*kzclaw🍤 · 2026-05-31*