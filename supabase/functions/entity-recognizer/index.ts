/**
 * entity-recognizer Edge Function
 * O4KR1 Entity Engine — Phase 2: Keyword-based NER
 *
 * v0.34 placeholder: keyword match against entity_keyword_dict
 * v0.35+: upgrade to Workers AI NER (Kimi K2.5) for L4+ signals
 *
 * Input:  { news_item_id: string }
 * Output: { entity_ids: string[], entities: {id, name, type}[] }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Parse body ───────────────────────────────────────────────────
    const { news_item_id } = await req.json()
    if (!news_item_id || typeof news_item_id !== 'string') {
      return new Response(JSON.stringify({ error: 'news_item_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Supabase client (service role — bypasses RLS) ─────────────────
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // ── Step 1: Fetch news item ───────────────────────────────────────
    const { data: newsItem, error: newsError } = await supabase
      .from('news_hotspots')
      .select('id, title, summary')
      .eq('id', news_item_id)
      .single()

    if (newsError || !newsItem) {
      return new Response(JSON.stringify({ error: 'News item not found', details: newsError }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Step 2: Load keyword dictionary ───────────────────────────────
    const { data: keywords, error: keywordError } = await supabase
      .from('entity_keyword_dict')
      .select('keyword, type, weight')

    if (keywordError) {
      return new Response(JSON.stringify({ error: 'Failed to load keyword dict', details: keywordError }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!keywords || keywords.length === 0) {
      return new Response(JSON.stringify({ entity_ids: [], entities: [], matched_keywords: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Step 3: Keyword match ────────────────────────────────────────
    const text = `${newsItem.title} ${newsItem.summary ?? ''}`
    const matchedKeywords = keywords.filter((kw: { keyword: string }) =>
      text.includes(kw.keyword)
    )

    if (matchedKeywords.length === 0) {
      return new Response(JSON.stringify({ entity_ids: [], entities: [], matched_keywords: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Step 4: Upsert entities into entity table ────────────────────
    // Build hashStr for dedup (consistent with O5KR2 topic_key approach)
    const entityUpserts = matchedKeywords.map((kw: { keyword: string; type: string }) => ({
      name: kw.keyword,
      name_hash: hashStr(kw.keyword),
      type: kw.type,
      source: 'keyword' as const,
      confidence: 0.60,
      news_count: 1,
      last_seen: new Date().toISOString(),
      is_active: true,
    }))

    const { data: upsertedEntities, error: upsertError } = await supabase
      .from('entity')
      .upsert(
        entityUpserts.map(e => ({
          ...e,
          first_seen: supabase.sql`NOW()`,
          updated_at: supabase.sql`NOW()`,
        })),
        {
          onConflict: 'name_hash',
          ignoreDuplicates: false,
        }
      )
      .select('id, name, type')

    if (upsertError) {
      return new Response(JSON.stringify({ error: 'Failed to upsert entities', details: upsertError }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch the full entity list (including existing ones that weren't re-inserted)
    const entityIds = (upsertedEntities ?? []).map((e: { id: string }) => e.id)

    // ── Step 5: Increment news_count on existing entities ────────────
    if (entityIds.length > 0) {
      await supabase.rpc('increment_entity_news_count', { entity_ids: entityIds }).catch(() => {
        // RPC may not exist yet — skip silently
      })
    }

    // ── Step 6: Update news_hotspots with entity_ids ──────────────────
    await supabase
      .from('news_hotspots')
      .update({ entity_ids: entityIds })
      .eq('id', news_item_id)

    // ── Step 7: Compute co-occurrence entity relations ─────────────────
    // O4KR1 placeholder: co-occurrence only (Signal Engine in O11)
    await computeCoOccurrenceRels(supabase, entityIds, news_item_id)

    return new Response(
      JSON.stringify({
        entity_ids: entityIds,
        entities: upsertedEntities ?? [],
        matched_keywords: matchedKeywords.map((kw: { keyword: string; type: string }) => ({
          keyword: kw.keyword,
          type: kw.type,
        })),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: 'Internal error', details: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Consistent hash function for entity deduplication.
 * Using a simple DJB2-style hash for portability (no crypto dependency in Edge).
 */
function hashStr(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }
  return Math.abs(hash).toString(36)
}

/**
 * Compute co-occurrence entity relations.
 * For entities appearing in the same news item, increment co-occurrence count.
 * v0.34: simple co-occurrence only
 * v0.35+: Signal Engine will enrich with weight/confidence
 */
async function computeCoOccurrenceRels(
  supabase: ReturnType<typeof createClient>,
  entityIds: string[],
  newsItemId: string
): Promise<void> {
  if (entityIds.length < 2) return

  // Generate all pairs
  const pairs: { from_id: string; to_id: string }[] = []
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      pairs.push({ from_id: entityIds[i], to_id: entityIds[j] })
    }
  }

  // Upsert co-occurrence relations
  for (const pair of pairs) {
    await supabase.rpc('upsert_entity_relation', {
      p_from_entity_id: pair.from_id,
      p_to_entity_id: pair.to_id,
      p_relation_type: 'co-occurrence',
    }).catch(() => {
      // RPC may not exist yet — skip silently
    })
  }
}
