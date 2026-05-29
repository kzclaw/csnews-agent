#!/bin/bash
# CSNEWS Agent cron runner - bypass proxy for Cloudflare
unset https_proxy http_proxy https HTTP ALL_PROXY all_proxy
TOKEN="REDACTED-WORKER-BEARER-TOKEN"
curl -s -H "Authorization: Bearer $TOKEN" "https://csnews-agent.kwokzit.workers.dev/?action=process" >> /tmp/csnews_process.log 2>&1