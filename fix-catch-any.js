#!/usr/bin/env node
/**
 * Batch convert catch(e: any) → catch(e: unknown) across csnews-agent/src
 *
 * For each catch block, also transforms the common error-access patterns:
 *   e?.message || 'fallback' → (e instanceof Error ? e.message : String(e)) || 'fallback'
 *   e?.message || String(e)  → (e instanceof Error ? e.message : String(e))
 *   e?.message || e          → (e instanceof Error ? e.message : String(e))
 *   e?.message               → (e instanceof Error ? e.message : String(e))
 *   e.message                → (e instanceof Error ? e.message : String(e))
 */
const fs = require('fs');
const path = require('path');
const glob = require('util').promisify(require('child_process').exec);

const SRC = path.resolve(__dirname, 'csnews-agent/src');

// Files already fixed or excluded
const SKIP = new Set([
  'health-ai.ts', 'health-db.ts', 'health-kv.ts', 'health-mcp.ts', 'health-r2.ts',
  'auth.ts', 'ai-budget.ts', 'score-threshold.ts', 'shared.ts',
  'endpoints-proxy.ts', 'category-seeds.ts', 'classify.ts', 'cache.ts',
  'health-checks.ts', 'health-main.ts', 'types.ts', 'types-supabase.ts',
  'cf-types.d.ts', 'index.ts',
]);

function transformCatchBlock(code, catchVar) {
  const patterns = [
    // e?.message || String(e)  → safe
    { from: new RegExp(`${catchVar}\\?\\\\.message \\|\\| String\\(${catchVar}\\)`, 'g'), to: `(e instanceof Error ? e.message : String(e))` },
    // e?.message || e  → safe
    { from: new RegExp(`${catchVar}\\?\\\\.message \\|\\| ${catchVar}`, 'g'), to: `(e instanceof Error ? e.message : String(e))` },
    // e?.message || '...'  → safe || '...'
    // Keep as-is but with safe LHS
    // We handle this case separately below
  ];

  // Transform catch clause type
  code = code.replace(
    new RegExp(`catch \\(${catchVar}: any\\)`, 'g'),
    `catch (${catchVar}: unknown)`
  );

  return code;
}

function transformFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const original = content;

  // Handle different catch variable names
  for (const cv of ['e', 'err']) {
    content = transformCatchBlock(content, cv);
  }

  // Now transform error access patterns in catch blocks.
  // Strategy: find catch blocks and only transform error refs inside them.
  // Simple approach: split by catch, process each segment.
  
  // Replace e?.message || e → safe
  content = content.replace(
    /e\?\.message \|\| e/g,
    '(e instanceof Error ? e.message : String(e))'
  );
  // Replace e?.message || String(e) → safe  
  content = content.replace(
    /e\?\.message \|\| String\(e\)/g,
    '(e instanceof Error ? e.message : String(e))'
  );
  // Replace e?.message || '...' → safe || '...'
  content = content.replace(
    /e\?\.message \|\| /g,
    '(e instanceof Error ? e.message : String(e)) || '
  );
  // Replace standalone e?.message → safe (but be careful not to double-replace)
  content = content.replace(
    /e\?\.message/g,
    '(e instanceof Error ? e.message : String(e))'
  );
  // Replace e.message → safe (but not if e is already instanceof Error check)
  content = content.replace(
    /(?<!instanceof Error \? )e\.message(?! : String)/g,
    '(e instanceof Error ? e.message : String(e))'
  );
  // Clean up any double-wrapping
  content = content.replace(
    /\(e instanceof Error \? \(e instanceof Error \? e\.message : String\(e\)\) : String\(e\)\)/g,
    '(e instanceof Error ? e.message : String(e))'
  );

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }
  return false;
}

// Main
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.ts') && !SKIP.has(f));
let changed = 0;
for (const f of files) {
  if (transformFile(path.join(SRC, f))) {
    console.log(`  ✓ ${f}`);
    changed++;
  }
}
console.log(`\nDone. ${changed} files modified.`);
