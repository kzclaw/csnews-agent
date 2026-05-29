#!/bin/bash
# CSNEWS Agent cron runner - bypass proxy for Cloudflare Workers
# Note: .workers.dev domains require IPv4 (IPv6 broken on this network)
unset https_proxy http_proxy https HTTP ALL_PROXY all_proxy ALL_PROXY
export no_proxy='*'
export NO_PROXY='*'
TOKEN="REDACTED-WORKER-BEARER-TOKEN"
curl -4s --noproxy '*' -H "Authorization: Bearer $TOKEN" \
  "https://csnews-agent.kwokzit.workers.dev/?action=process" \
  >> /tmp/csnews_process.log 2>&1
