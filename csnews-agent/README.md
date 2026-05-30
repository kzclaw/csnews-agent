# CSNEWS Agent Worker

> **News Self Growth System** · Powered by Cloudflare Workers AI + Supabase + R2

A zero-token-cost intelligent news tracking and self-growth system, using Cloudflare Workers AI free models + Supabase free tier + R2 free storage.

---

## badges

```
🧠 AI         @cf/baai/bge-m3 (vector embedding)
🤖 Model      @cf/moonshotai/kimi-k2.5 (classification)
📊 Storage    Supabase PostgreSQL + pgvector
🗄️  Cache      Cloudflare R2 (deduplication layer)
⏰ Schedule    Every 2 hours via cron
```

---

## Features

| Feature | Status | Description |
|---------|--------|-------------|
| **ZAKER API** | ✅ Active | Hot news every 2h via cron |
| **Rule Scoring** | ✅ Active | Base 5.0 + hotword modifiers, AI route at ≥7.0 |
| **bge-m3 Embedding** | ✅ Active | 1024-dim vector for first 6 news per batch |
| **Vector Deduplication** | ✅ Active | Similarity threshold 0.88, R2 dedup at <0.75 |
| **Topic Clustering** | ✅ Active | createTopic + joinTopicMembers on new簇 |
| **R2 Storage** | ✅ Active | Raw news JSON stored after dedup |
| **AI Scoring** | 🔜 Todo | Compare with kzclaw, target <15% error |
| **Fission Reports** | ⏸ Paused | Requires continuous积分 triggering |

---

## Quick Start

### One-Click Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?btm-token=)](https://deploy.workers.cloudflare.com/?btm-token=)
<!-- Replace bt-tm-token with your workers token or use wrangler CLI below -->

### Manual Deploy

```bash
# 1. Clone
git clone https://github.com/kzclaw/csnews-agent.git
cd csnews-agent/csnews-agent

# 2. Configure secrets
npx wrangler secret put BEARER_TOKEN
npx wrangler secret put SUPABASE_SERVICE_KEY
# SUPABASE_URL (project ID) - added automatically after GitHub integration

# 3. Create R2 bucket (Cloudflare Dashboard)
# Workers & Pages → R2 Object Storage → Create Bucket "csnews-raw"

# 4. Deploy
npx wrangler deploy
```

---

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `/?action=ping` | ✅ | Health check |
| `/?action=zaker-hot` | ✅ | Fetch ZAKER hot → R2 dedup |
| `/?action=process` | ✅ | Full pipeline: score → embed → dedup → store |
| `/?action=score&title=...` | ✅ | Single news rule scoring |
| `/?action=batch-score` | POST | Batch scoring (JSON body) |
| `/?action=embed&text=...` | ✅ | bge-m3 1024-dim vector output |
| `/?action=diag` | ✅ | Supabase 3-table join diagnostic |
| `/?action=list` | ✅ | List R2 stored news |
| `/?action=save` | ✅ | Manual save to R2 |

**Base URL**: `https://csnews-agent.<your-subdomain>.workers.dev/api/v1/`

---

## Architecture

```
ZAKER /hot
    ↓
┌─────────────────────────────┐
│   Cloudflare Worker         │
│  ┌───────────────────────┐  │
│  │  Rule Engine Scoring  │  │
│  │  (scoreRule, AI route)│  │
│  ├───────────────────────┤  │
│  │  Workers AI           │  │
│  │  @cf/baai/bge-m3     │  │
│  ├───────────────────────┤  │
│  │  Supabase RPC         │  │
│  │  findSimilarNews      │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
    ↓               ↓
 Supabase RAG    R2 Storage
 (vector cache)  (dedup layer)
```

**Self-Growth Mechanism**:

| Level | Trigger | Cleanup |
|-------|---------|---------|
| 🟢 Follow | Cluster created | 7 days no new news |
| 🟡 Important | Score ≥ 3/6/9 | 14 days no new news |
| 🔴 Explosive | Score ≥ 9 | 28 days no new news |

---

## Scoring Rules

```
Base: 5.0

Modifiers:
  🔥 superHot (+2.0)   紧急/突发/重磅
  🔥 hot   (+1.2)     一般热词
  🔢 number (+0.5)     含数字
  📏 length (+0.3)     标题 20~35 字
  ❗ emoji  (+0.3)     含感叹/问号
  🔗 multi  (+0.5)     ≥3 热词同时出现

Max: 7.6 (capped at 10)
AI Route Threshold: R ≥ 7.0
```

---

## Tech Stack

| Component | Service | Purpose |
|-----------|---------|---------|
| **Runtime** | Cloudflare Workers | Edge computing |
| **AI** | Workers AI `@cf/baai/bge-m3` | 1024-dim vector embedding |
| **AI** | Workers AI `@cf/moonshotai/kimi-k2.5` | Chinese classification (备选) |
| **AI** | Workers AI `@cf/meta/llama-3-8b-instruct` | Report generation (待启用) |
| **Database** | Supabase PostgreSQL + pgvector | Vector similarity search + topic management |
| **Storage** | Cloudflare R2 `csnews-raw` | Raw news JSON dedup storage |

---

## Project Structure

```
csnews-agent/
├── src/
│   └── index.ts          # Main Worker (all endpoints + logic)
├── wrangler.toml         # Cloudflare config (no credentials)
├── README.md             # This file
└── .gitignore
```

---

## Security

- All secrets via `wrangler secret put` — never in code
- `SUPABASE_SERVICE_KEY` is Service Role key — write-only at RLS level
- `BEARER_TOKEN` required for all API calls
- `SUPABASE_URL` stored as project ID only (拼接为完整URL在代码中)

---

## License

MIT · `kzclaw/csnews-agent`

*kzclaw🍤 · 2026-05-31*