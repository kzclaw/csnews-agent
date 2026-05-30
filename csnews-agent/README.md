# CSNEWS Agent · 主 Worker

> Cloudflare Workers + Workers AI + Supabase + R2
> News Self Growth 系统后端

---

## 技术架构

```
ZAKER /hot → Worker（评分/分类/嵌入）→ Supabase（RAG 向量查重） + R2（去重存储）
                     ↓
              Workers AI bge-m3（向量嵌入）
              Workers AI llama-3-8b-instruct（AI 报告，暂缓）
```

### 核心接口

| Endpoint | Method | Auth | 说明 |
|----------|--------|------|------|
| `/?action=ping` | GET | ✅ | 健康检查 |
| `/?action=zaker-hot` | GET | ✅ | ZAKER 热榜 → 规则引擎 → R2 |
| `/?action=process` | GET | ✅ | 完整流程（评分/分类/嵌入/查重/入库）|
| `/?action=score&title=...` | GET | ✅ | 单条规则引擎评分 |
| `/?action=batch-score` | POST | ✅ | 批量评分（JSON body）|
| `/?action=fission&seed=...` | GET | ✅ | AI 裂变报告生成（R≥7.0 触发）|
| `/?action=embed&text=...` | GET | ✅ | bge-m3 1024维向量 |
| `/?action=diag` | GET | ✅ | Supabase 三表联调诊断 |
| `/?action=list` | GET | ✅ | 列出 R2 中的新闻 |
| `/?action=save` | GET | ✅ | 手动存新闻到 R2 |

**认证**：`Authorization: Bearer <BEARER_TOKEN>`

---

## 评分规则（scoreRule）

基准分 **5.0**，加分项：

| 条件 | 加分 |
|------|------|
| 超热词（紧急/突发/重磅）| +2.0 |
| 一般热词 | +1.2 |
| 含数字 | +0.5 |
| 标题长度 20~35 字 | +0.3 |
| 含感叹号/问号 | +0.3 |
| 3个及以上热词 | +0.5 |
| 2个热词 | +0.3 |

**最大值**：7.6（封顶10）
**AI 路由阈值**：`AI_ROUTE_R_THRESHOLD = 7.0`（R≥7.0 才触发 Workers AI）

---

## 环境变量

| 变量 | 说明 | 配置方式 |
|------|------|---------|
| `BEARER_TOKEN` | API 认证密钥 | `npx wrangler secret put BEARER_TOKEN` |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key | `npx wrangler secret put SUPABASE_SERVICE_KEY` |

---

## 部署

```bash
# 配置密钥
npx wrangler secret put BEARER_TOKEN
npx wrangler secret put SUPABASE_SERVICE_KEY

# 部署
npx wrangler deploy
```

---

## 快速测试

```bash
# ping
curl "https://REDACTED-INTERNAL-DOMAIN/api/v1/?action=ping" \
  -H "Authorization: Bearer <token>"

# process（完整流程）
curl "https://REDACTED-INTERNAL-DOMAIN/api/v1/?action=process" \
  -H "Authorization: Bearer <token>"

# 评分
curl "https://REDACTED-INTERNAL-DOMAIN/api/v1/?action=score&title=紧急！日本发生强烈地震" \
  -H "Authorization: Bearer <token>"
```

---

*kzclaw🍤 | 2026-05-30*