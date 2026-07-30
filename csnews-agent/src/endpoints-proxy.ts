// ============================================================
// endpoints-proxy.ts · v0.37
// Reader 浮窗 Readability 模式 Worker 端
//
// 用途: 点标题 → Worker fetch 原始 URL → Mozilla Readability
//       提取正文 → viewer modal 浮窗显示
//
// 业务契约:
//   - action=proxy: URL 参数 → fetch → Readability 提取 → text/html
//   - 鉴权: Bearer Token (index.ts 入口统一 authRequest)
//   - 反爬: 单 IP 60 req/min (复用 checkRateLimit)
//   - 超时: 10s 硬截止 (避免 Worker 30s CPU 超时)
//   - 非 HTML: 415 Unsupported Media Type + JSON error
//   - fetch 失败: 502 Bad Gateway + { error, reason }
//   - 无效 URL: 400 Bad Request + { error, reason }
// ============================================================

import { Env, jsonResponse } from './shared';
import { checkRateLimit, rateLimitResponse } from './utils';
import { RATE_LIMIT_PER_MIN, rateKeyForIp } from './content-validation';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export async function handleProxyAction(
  request: Request,
  env: Env,
  url: URL,
  cors: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // 1. 输入校验: url 参数必填
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'missing_url', reason: 'url 参数必填' }, cors, { status: 400 });
  }

  // 2. URL 格式校验
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      throw new Error('只支持 http/https');
    }
  } catch {
    return jsonResponse({ error: 'invalid_url', reason: 'url 格式非法' }, cors, { status: 400 });
  }

  // 3. 反爬限流 (单 IP 60 req/min, 复用 content 端点 KV key 格式)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { exceeded } = await checkRateLimit(env, ctx, rateKeyForIp(ip), RATE_LIMIT_PER_MIN);
  if (exceeded) return rateLimitResponse(cors, RATE_LIMIT_PER_MIN);

  // 4. fetch 原始 URL (10s 超时保护)
  let html: string;
  let fetchOk = false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(parsedTarget.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; CSNEWS-ReaderBot/1.0; +https://csnews.example.com/bot)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      return jsonResponse(
        {
          error: 'fetch_failed',
          reason: `目标站点返回 HTTP ${resp.status}`,
        },
        cors,
        { status: 502 }
      );
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return jsonResponse(
        {
          error: 'unsupported_content_type',
          reason: `目标不是 HTML 页面 (${contentType || '无 Content-Type'}), 无法提取正文`,
        },
        cors,
        { status: 415 }
      );
    }

    html = await resp.text();
    fetchOk = true;
  } catch (e: unknown) {
    const reason =
      e instanceof Error && (e.name === 'AbortError' || e.message?.includes('aborted'))
        ? '请求超时 (10s)'
        : `fetch 失败: ${e instanceof Error ? e.message : String(e)}`;
    return jsonResponse({ error: 'fetch_failed', reason }, cors, { status: 502 });
  }

  if (!fetchOk || !html) {
    return jsonResponse({ error: 'fetch_failed', reason: '目标页面内容为空' }, cors, {
      status: 502,
    });
  }

  // 5. Readability 提取正文
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document, { charThreshold: 10 });
    const article = reader.parse();

    if (!article || !article.content) {
      return jsonResponse({ error: 'extraction_failed', reason: '无法从页面提取正文内容' }, cors, {
        status: 502,
      });
    }

    // 6. 返回 text/html (viewer 直接 innerHTML 渲染)
    const htmlResponse = buildArticleHtml(article, parsedTarget.toString());
    return new Response(htmlResponse, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors },
    });
  } catch (e: unknown) {
    return jsonResponse(
      {
        error: 'extraction_failed',
        reason: `Readability 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      },
      cors,
      { status: 502 }
    );
  }
}

/**
 * 构建 article HTML 响应
 * 样式内联,viewer 直接 innerHTML 渲染
 */
function buildArticleHtml(
  article: {
    title?: string | null;
    content?: string | null;
    textContent?: string | null;
    siteName?: string | null;
  },
  sourceUrl: string
): string {
  const title = article.title || '正文';
  const rawContent = article.content || article.textContent || '<p>正文内容提取失败</p>';
  const siteName = article.siteName || new URL(sourceUrl).hostname;
  // Sanitize article HTML: strip event handlers and javascript: URLs to prevent XSS
  const content = sanitizeHtml(rawContent);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtmlAttr(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 15px; line-height: 1.75; color: #1a1a1a;
    background: #fafafa; padding: 20px 24px 40px; max-width: 720px; margin: 0 auto;
    -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 22px; font-weight: 700; line-height: 1.3; margin-bottom: 16px; color: #111; }
  .meta { font-size: 13px; color: #666; margin-bottom: 24px; border-bottom: 1px solid #eee; padding-bottom: 12px; }
  .meta a { color: #888; text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  article { color: #222; }
  article p { margin-bottom: 16px; }
  article h2, article h3, article h4 { margin: 24px 0 12px; font-weight: 600; }
  article h2 { font-size: 18px; }
  article h3 { font-size: 16px; }
  article img { max-width: 100%; height: auto; display: block; margin: 16px auto; border-radius: 4px; }
  article a { color: #0055cc; text-decoration: none; }
  article a:hover { text-decoration: underline; }
  article blockquote { border-left: 3px solid #ddd; padding-left: 16px; margin: 16px 0; color: #555; }
  article pre, article code { background: #f5f5f5; border-radius: 4px; font-size: 13px; }
  article pre { padding: 16px; overflow-x: auto; margin: 16px 0; }
  article code { padding: 2px 5px; }
  article pre code { padding: 0; background: none; }
  article ul, article ol { padding-left: 24px; margin-bottom: 16px; }
  article li { margin-bottom: 6px; }
  article table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  article th, article td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  article th { background: #f5f5f5; font-weight: 600; }
  article figure { margin: 16px 0; }
  article figcaption { font-size: 13px; color: #666; text-align: center; margin-top: 6px; }
  article hr { border: none; border-top: 1px solid #eee; margin: 24px 0; }
</style>
</head>
<body>
<h1>${escapeHtmlAttr(title)}</h1>
<div class="meta">
  来源: <a href="${escapeHtmlAttr(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(siteName)}</a>
</div>
<article>${content}</article>
</body>
</html>`;
}

/**
 * Strip known XSS vectors from HTML content.
 * Removes event handler attributes (on*) and javascript: URLs in links.
 */
function sanitizeHtml(html: string): string {
  return html
    // Remove event handler attributes (onerror, onclick, onload, etc.)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Remove javascript: URLs in href/src attributes
    .replace(/(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1=""')
    // Remove <base> tags (can redirect relative URLs)
    .replace(/<base\b[^>]*>/gi, '');
}

function escapeHtmlAttr(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
