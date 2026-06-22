#!/bin/bash
# Backfill Vectorize with existing embeddings from Supabase (O12KR7)
#
# Usage:
#   export SUPABASE_URL="your-project-ref"
#   export SUPABASE_SERVICE_KEY="your-service-key"
#   ./scripts/backfill-vectorize.sh
#
# Prerequisites:
#   1. wrangler CLI installed (npx wrangler)
#   2. wrangler.toml has [[vectorize]] binding for csnews-news-vectors
#   3. SUPABASE_URL and SUPABASE_SERVICE_KEY env vars set
#
# This script is a one-time migration script. Execute and then DELETE.

set -e

echo "=== Vectorize Backfill Script (O12KR7) ==="

# Check env vars
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ]; then
  echo "Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set"
  exit 1
fi

echo "Supabase project: $SUPABASE_URL"

# Create temp directory for vector data
TEMP_DIR=$(mktemp -d)
VECTOR_FILE="$TEMP_DIR/vectors.ndjson"
trap "rm -rf $TEMP_DIR" EXIT

echo "Fetching embeddings from Supabase..."

# Fetch all news_hotspots with embeddings in batches
# Using PostgREST API with pagination
PAGE=0
PAGE_SIZE=1000
TOTAL=0

while true; do
  OFFSET=$((PAGE * PAGE_SIZE))

  # Fetch batch from Supabase
  RESPONSE=$(curl -s -X GET \
    "${SUPABASE_URL}.supabase.co/rest/v1/news_hotspots?embedding=not.is.null&select=id,title,embedding&limit=${PAGE_SIZE}&offset=${OFFSET}" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")

  # Count rows in this batch
  COUNT=$(echo "$RESPONSE" | grep -o '"id"' | wc -l)

  if [ "$COUNT" -eq 0 ]; then
    echo "No more rows. Done fetching."
    break
  fi

  echo "Page $PAGE: fetched $COUNT rows"

  # Extract id, embedding and format as newline-delimited JSON for Vectorize
  # Vectorize expects: {"id": "...", "values": [...], "metadata": {...}}
  echo "$RESPONSE" | python3 -c "
import sys
import json

data = json.load(sys.stdin)
for row in data:
    if row.get('embedding') and len(row['embedding']) > 0:
        vector = {
            'id': row['id'],
            'values': row['embedding'],
            'metadata': {
                'title': row.get('title', '') or ''
            }
        }
        print(json.dumps(vector))
" >> "$VECTOR_FILE"

  TOTAL=$((TOTAL + COUNT))
  PAGE=$((PAGE + 1))

  if [ "$COUNT" -lt "$PAGE_SIZE" ]; then
    break
  fi
done

echo ""
echo "Total embeddings fetched: $TOTAL"

if [ "$TOTAL" -eq 0 ]; then
  echo "No embeddings to backfill. Exiting."
  exit 0
fi

# Count vectors in file
VECTOR_COUNT=$(wc -l < "$VECTOR_FILE")
echo "Vectors to insert: $VECTOR_COUNT"

echo ""
echo "Inserting vectors to Vectorize..."
echo "Using wrangler vectorize insert..."

# wrangler vectorize insert expects JSON input via stdin
# Format: newline-delimited JSON with id, values, metadata
cat "$VECTOR_FILE" | npx wrangler vectorize insert csnews-news-vectors --json

echo ""
echo "=== Backfill Complete ==="
echo "Total vectors inserted: $VECTOR_COUNT"

# Note: This script should be DELETED after execution
echo "IMPORTANT: Delete this script after successful execution!"
