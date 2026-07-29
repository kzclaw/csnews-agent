-- v0.37.78: 建 fission_reports 表（裂变报告记录）
-- 代码（csnews-fission fission-trigger.ts）写 fission_reports，
-- 但之前只建了 fission_searches（20260529 初始 schema），没有 fission_reports。
-- Viewer 通过 ?action=pull&type=fission-reports 读这个表。
-- 现场已有一个 R2 fission report（7月20日生成），但 Supabase INSERT 静默失败 → Viewer 永远空白。
--
-- 列定义对齐 csnews-fission/src/fission-trigger.ts recordFissionReport() INSERT + pull.ts queryFissionReports()
CREATE TABLE IF NOT EXISTS fission_reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
  queries TEXT[] DEFAULT '{}',
  report_content TEXT,
  r2_key TEXT NOT NULL,
  fission_type TEXT DEFAULT 'expansion',
  status TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'pending')),
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 索引：按触发时间倒序（Viewer 列表）
CREATE INDEX IF NOT EXISTS idx_fission_reports_triggered_at ON fission_reports (triggered_at DESC);

-- 索引：按 topic 查询
CREATE INDEX IF NOT EXISTS idx_fission_reports_topic_id ON fission_reports (topic_id);
