# CSNEWS Agent

Cloudflare Workers AI + Supabase + R2 的 News Self-Growth 复刻版。

零 token 成本，使用 Cloudflare Workers AI 免费模型 + Supabase 免费层 + R2 免费额度。

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
# - 登录 https://dash.cloudflare.com
# - Workers & Pages → R2 Object Storage → 创建 Bucket
# - 命名任意，绑定到 Worker 时记录绑定名

# 4. 配置 wrangler.toml（仅修改 binding 名）
# 绑定名称可自定义，保持与代码中一致即可

# 5. 部署
npx wrangler deploy
```

---

## 环境变量（必须配置）

| 变量名 | 用途 | 配置方式 |
|--------|------|---------|
| `BEARER_TOKEN` | Worker 访问认证密钥 | `npx wrangler secret put BEARER_TOKEN` |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key（拥有数据库写权限） | `npx wrangler secret put SUPABASE_SERVICE_KEY` |

**获取方式**：
- `BEARER_TOKEN`：任意字符串，建议 32+ 字符，用于所有 API 调用的认证
- `SUPABASE_SERVICE_KEY`：Supabase Dashboard → Project Settings → API → `service_role` 密钥

---

## R2 Bucket 配置

**步骤**：
1. Cloudflare Dashboard → Workers & Pages → R2 Object Storage → 创建 Bucket
2. 在 `wrangler.toml` 中配置绑定（bucket 名由 Cloudflare 侧管理，不写在配置里）
3. 代码中通过 `env.<BINDING_NAME>` 访问

---

## API Endpoints

| Endpoint | Method | 说明 |
|----------|--------|------|
| `/?action=ping` | GET | 健康检查 |
| `/?action=model-test` | GET | Workers AI 模型测试 |
| `/?action=ai-test` | GET | AI 裂变报告测试 |
| `/?action=score&title=...` | GET | 单条新闻评分 + 分类（规则引擎） |
| `/?action=batch-score` | POST | 批量评分（JSON body） |
| `/?action=fission&seed=...` | GET | 裂变搜索查询生成 |
| `/?action=save&title=...` | GET | 保存新闻到 R2 |
| `/?action=list` | GET | 列出 R2 中的新闻 |

**认证**：所有请求需要 Header `Authorization: Bearer <BEARER_TOKEN>`

---

## 安全说明

所有密钥通过 `wrangler secret put` 管理，不在任何代码文件中明文存储。

---

*kzclaw🍤 | 2026-05-29*