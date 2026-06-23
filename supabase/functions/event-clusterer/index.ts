/**
 * event-clusterer Edge Function
 * Phase 1: Entity-overlap Jaccard clustering
 *
 * Input:  { news_item_ids: string[] }
 * Output: { event_ids: string[], clusters: { event_id, news_ids, entity_ids }[] }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { news_item_ids } = await req.json()
    if (!Array.isArray(news_item_ids) || news_item_ids.length === 0) {
      return new Response(JSON.stringify({ error: 'news_item_ids array required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // ── Step 1: Load entity_ids for each news item ──────────────────────
    const { data: newsItems, error: newsError } = await supabase
      .from('news_hotspots')
      .select('id, title, entity_ids')
      .in('id', news_item_ids)

    if (newsError) {
      return new Response(JSON.stringify({ error: 'Failed to load news items', details: newsError }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const newsWithEntities = (newsItems ?? []).filter(n => n.entity_ids && n.entity_ids.length > 0)

    if (newsWithEntities.length < 2) {
      return new Response(JSON.stringify({
        event_ids: [],
        clusters: [],
        reason: 'Need at least 2 news items with entity_ids for clustering',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Step 2: Compute Jaccard similarity ───────────────────────────
    function jaccard(a: string[], b: string[]): number {
      const setA = new Set(a)
      const setB = new Set(b)
      let intersection = 0
      for (const item of setA) {
        if (setB.has(item)) intersection++
      }
      const union = setA.size + setB.size - intersection
      return union === 0 ? 0 : intersection / union
    }

    const JACCARD_THRESHOLD = 0.3
    const n = newsWithEntities.length
    const adj: number[][] = Array.from({ length: n }, () => Array(n).fill(0))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = jaccard(newsWithEntities[i].entity_ids, newsWithEntities[j].entity_ids)
        if (sim >= JACCARD_THRESHOLD) {
          adj[i][j] = sim
          adj[j][i] = sim
        }
      }
    }

    // ── Step 3: Union-Find clustering ───────────────────────────────
    const parent = Array.from({ length: n }, (_, i) => i)
    function find(x: number): number {
      return parent[x] === x ? x : (parent[x] = find(parent[x]))
    }
    function union(x: number, y: number): void {
      const px = find(x), py = find(y)
      if (px !== py) parent[px] = py
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (adj[i][j] >= JACCARD_THRESHOLD) union(i, j)
      }
    }

    // Group news by cluster
    const clusterMap = new Map<number, typeof newsWithEntities>()
    for (let i = 0; i < n; i++) {
      const root = find(i)
      if (!clusterMap.has(root)) clusterMap.set(root, [])
      clusterMap.get(root)!.push(newsWithEntities[i])
    }

    const clusters = Array.from(clusterMap.values()).filter(g => g.length >= 2)

    if (clusters.length === 0) {
      return new Response(JSON.stringify({
        event_ids: [],
        clusters: [],
        reason: 'No pairs met Jaccard threshold >= 0.3',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Step 4: Create events in DB ───────────────────────────────────
    const eventInserts = clusters.map(group => ({
      title: group[0].title.slice(0, 200),
      event_stage: 'detected',
      score: 0,
      news_count: group.length,
      first_news_id: group[0].id,
      published_at: new Date().toISOString(),
    }))

    const { data: createdEvents, error: eventError } = await supabase
      .from('events')
      .insert(eventInserts)
      .select('id, first_news_id')

    if (eventError || !createdEvents) {
      return new Response(JSON.stringify({ error: 'Failed to create events', details: eventError }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Step 5: Create event_entity associations ─────────────────────
    const eventEntityInserts: { event_id: string; entity_id: string; role: string }[] = []
    for (let i = 0; i < createdEvents.length; i++) {
      const eventId = createdEvents[i].id
      const entityIds = [...new Set(clusters[i].flatMap(n => n.entity_ids ?? []))]
      for (const entityId of entityIds) {
        eventEntityInserts.push({ event_id: eventId, entity_id: entityId, role: 'participant' })
      }
    }

    if (eventEntityInserts.length > 0) {
      await supabase.from('event_entity').insert(eventEntityInserts).catch(() => {
        // Skip silently if table not yet deployed
      })
    }

    return new Response(JSON.stringify({
      event_ids: createdEvents.map(e => e.id),
      clusters: createdEvents.map((e, i) => ({
        event_id: e.id,
        news_ids: clusters[i].map(n => n.id),
        entity_ids: [...new Set(clusters[i].flatMap(n => n.entity_ids ?? []))],
      })),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: 'Internal error', details: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
