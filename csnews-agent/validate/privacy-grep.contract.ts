// ============================================================
// CSNEWS Agent · 隐私 grep 契约 (戴大虾 2026-06-17 00:42 拍板)
// ============================================================
//用途：扫所有入仓文件注释 + 代码 + 配置, 命中以下隐私字眼即 fail
//禁止字眼: 戴 / 大虾 / 舒柯 / 拍 / KR\d+ / kr\d+ / kwokzit\.info
//文件范围: git ls-files 全部入仓文件 (排除 node_modules / dist / coverage / .wrangler / .git)
//模式: word boundary 严格匹配, 避免误报 (如 "戴维斯" 不会误中 "戴")
//失败处理: 任何命中 → test fail, 输出 file:line:matched_content → Mavis 立刻清
//关联: 5 重安全网第 4 项 (privacy 自检) + OKR 文档 changelog "戴大虾批评吸收"
//详见：tasks/csnews-agent-okr.md v0.36.10 · KR34 教训段

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const BANNED_PATTERNS = [
  { name: '戴 (真名)', regex: /(?<![\w-])戴(?![\w-])/g },
  { name: '大虾 (花名)', regex: /(?<![\w-])大虾(?![\w-])/g },
  { name: '舒柯 (真名)', regex: /(?<![\w-])舒柯(?![\w-])/g },
  { name: '拍 (拍板, 排除前后汉字的专名 "土拍" "流拍" "拍卖" "拍照")', regex: /(?<![\u4e00-\u9fff])拍(?![\u4e00-\u9fff])/g },
  { name: 'KR + 数字 ≥1 (内部 KR 编号, 排除 KR0 placeholder)', regex: /(?<![\w-])KR[1-9]\d*(?![\w-])/g },
  { name: 'kr + 数字 ≥1 (内部 kr 编号, 排除 kr0 placeholder)', regex: /(?<![\w-])kr[1-9]\d*(?![\w-])/g },
  { name: 'Phase ≥1 (内部 Phase 编号, 排除 Phase0 placeholder)', regex: /(?<![\w-])Phase[1-9]\d*(?![\w-])/g },
  { name: 'T 编号 1xx+ (排除 T000 placeholder)', regex: /(?<![\w-])T[1-9]\d{2}(?![\w-])/g },
  { name: 'M 编号 1-5 (内部里程碑)', regex: /(?<![\w-])M[1-5](?![\w-])/g },
  { name: 'Foundation ≥1 (排除 Foundation 0 placeholder)', regex: /Foundation[ \t]+[1-9]\d*/g },
  { name: 'kwokzit.info (内部域名)', regex: /kwokzit\.info/g },
];

const EXCLUDED_PATHS = [
  'node_modules/',
  'dist/',
  'coverage/',
  '.wrangler/',
  '.git/',
  '.specify/',
  'csnews-agent/dist/',
  'csnews-agent/coverage/',
  'csnews-agent/.wrangler/',
  'validate/',  // 隐私测试自己的代码, 含规则描述
  // README + AGENTS.md + docs 是公开文档, 但仍不能含隐私 (rule 通用)
];

function getTrackedFiles(): string[] {
  try {
    const out = execSync('git ls-files', { encoding: 'utf-8', cwd: process.cwd() });
    return out.trim().split('\n').filter(f => {
      // 排除 EXCLUDED_PATHS
      if (EXCLUDED_PATHS.some(p => f.startsWith(p))) return false;
      // 排除二进制 / lock
      if (f.endsWith('.lock') || f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.gif')) return false;
      // 排除 .bak 历史备份
      if (f.endsWith('.bak')) return false;
      return true;
    });
  } catch (e) {
    throw new Error(`git ls-files failed: ${e}`);
  }
}

function scanFileForBanned(filePath: string): { pattern: string; line: number; content: string }[] {
  const fs = require('fs');
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    // 二进制文件跳过 (虽已过滤但保险)
    return [];
  }
  const hits: { pattern: string; line: number; content: string }[] = [];
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    for (const { name, regex } of BANNED_PATTERNS) {
      const matches = line.match(regex);
      if (matches) {
        // 每行每个 pattern 只报一次 (避免一行 100 个 match 刷屏)
        hits.push({ pattern: name, line: idx + 1, content: line.trim().slice(0, 200) });
      }
    }
  });
  return hits;
}

describe('Privacy grep · 戴大虾 2026-06-17 00:42 hard rule', () => {
  it('所有入仓文件不能含 戴 / 大虾 / 舒柯 / 拍 / KR\\d+ / kr\\d+', () => {
    const files = getTrackedFiles();
    const allHits: { file: string; pattern: string; line: number; content: string }[] = [];

    for (const file of files) {
      const hits = scanFileForBanned(file);
      for (const hit of hits) {
        allHits.push({ file, ...hit });
      }
    }

    if (allHits.length > 0) {
      // 输出前 30 个命中 (避免刷屏), 戴大虾/Mavis 看清楚再修
      const report = allHits.slice(0, 30).map(h =>
        `  ${h.file}:${h.line}  [${h.pattern}]  ${h.content}`
      ).join('\n');
      const more = allHits.length > 30 ? `\n  ... 还有 ${allHits.length - 30} 处` : '';
      throw new Error(
        `🚨 隐私 grep 失败: ${allHits.length} 处命中 (戴大虾 00:42 hard rule)\n` +
        `前 30 处:\n${report}${more}\n\n` +
        `修法: (a) 代码注释清掉 (b) git filter-branch 改历史 (c) 临时 GitHub repo private\n` +
        `详见 OKR KR34 changelog 教训段`
      );
    }

    expect(allHits.length).toBe(0);
  });

  it('git log --grep 不能含 戴 / 大虾 / 舒柯 / 拍 / KR\\d+ / kwokzit.info', () => {
    // 历史 commit message 不能有隐私字眼 (戴大虾 00:42 rule #2)
    // 排除历史遗留: 只看最近 50 个 commit (未来 commit 必须 0 命中)
    // commit message 不扫 kwokzit (commit 可能描述 kwokzit 规则本身, 自指悖论)
    //
    // 戴舒柯 v0.36.10.6 拍板 (2026-06-17 02:38) — privacy 不可以再有新增命中
    // KNOWN_FALSE_POSITIVES 是历史 commit 已知命中, 作为特殊情况接受 (force push 会 break 戴大虾 1:40 commit 21aacaa + 5h 拍板链, 不修)
    // 未来 commit 必须 0 命中 (历史 baseline 之外)
    const KNOWN_FALSE_POSITIVES: Record<string, string> = {
      'd0e7bff': '5h 拍板链写"拍板"字 (戴大虾 5h 拍板链里写), 当时隐私 regex 还没加"拍"模式',
      '21aacaa': '戴大虾 1:40 commit "Update 20260617_kr34_record_trend_with_member.sql" 含 kr34 (测试 supabase GitHub Integration 触发)',
    };
    const searchPatterns = ['戴', '大虾', '舒柯', '拍'];
    const numPatterns = ['KR[1-9]\\d*', 'kr[1-9]\\d*', 'Phase[1-9]\\d*', 'T[1-9]\\d{2}', 'M[1-5]', 'Foundation[ \\t]+[1-9]\\d*'];

    try {
      const log = execSync('git log --oneline -50 --no-merges', { encoding: 'utf-8', cwd: process.cwd() });
      const commits = log.trim().split('\n');
      const offenders: { commit: string; match: string; reason: string }[] = [];

      for (const commitLine of commits) {
        // 提取 commit hash (第一个 token)
        const hash = commitLine.split(' ')[0];
        // 跳过 KNOWN_FALSE_POSITIVES (历史特殊情况, 戴舒柯 02:38 拍板接受)
        if (KNOWN_FALSE_POSITIVES[hash]) continue;
        // 读 commit message (commit hash 后的所有内容)
        const msg = commitLine.slice(hash.length).trim();
        for (const p of searchPatterns) {
          // word boundary 匹配
          const re = new RegExp(`(?<![\\w-])${p}(?![\\w-])`);
          if (re.test(msg)) {
            offenders.push({ commit: hash, match: `pattern="${p}" in "${msg.slice(0, 80)}"`, reason: '新增命中' });
          }
        }
        for (const p of numPatterns) {
          const re = new RegExp(p);
          if (re.test(msg)) {
            offenders.push({ commit: hash, match: `pattern="${p}" in "${msg.slice(0, 80)}"`, reason: '新增命中' });
          }
        }
      }

      if (offenders.length > 0) {
        const report = offenders.map(o => `  ${o.commit}: ${o.match} (${o.reason})`).join('\n');
        const fpReport = Object.entries(KNOWN_FALSE_POSITIVES)
          .map(([h, r]) => `  ${h} (特殊情况, 戴舒柯 02:38 接受): ${r}`)
          .join('\n');
        throw new Error(
          `🚨 Commit history 隐私 grep 失败: ${offenders.length} 处新增命中 (历史特殊情况已排除)\n` +
          `${report}\n\n` +
          `已知特殊情况 (force push 会 break 戴大虾 1:40 commit + 5h 拍板链, 戴舒柯 02:38 拍板接受):\n` +
          `${fpReport}\n\n` +
          `修法: 改 commit message 后 amend (最新 commit) / rebase -i + reword (历史 commit)`
        );
      }

      expect(offenders.length).toBe(0);
    } catch (e: any) {
      if (e.message && e.message.includes('🚨')) throw e;
      throw e;
    }
  });
});
