#!/usr/bin/env bash
# Tries every model on every route and prints the HTTP status, to map what works where.
# Usage:
#   FOUNDRY_RESOURCE=my-resource FOUNDRY_KEY=xxx ./smoke.sh
#   FOUNDRY_MODELS="MAI-Thinking-1 gpt-6-sol gpt-6-luna"   (optional)
set -u
: "${FOUNDRY_RESOURCE:?set FOUNDRY_RESOURCE (the resource name only, e.g. my-resource)}"
: "${FOUNDRY_KEY:?set FOUNDRY_KEY}"
MODELS="${FOUNDRY_MODELS:-MAI-Thinking-1 gpt-6-sol gpt-6-luna}"
MODELS="${MODELS//,/ }"

# label|url   (B is my guess, not listed on the docs page; a 404 there is fine)
ROUTES=(
  "A-openai-v1|https://${FOUNDRY_RESOURCE}.openai.azure.com/openai/v1/chat/completions"
  "B-services-v1|https://${FOUNDRY_RESOURCE}.services.ai.azure.com/openai/v1/chat/completions"
  "C-legacy-models|https://${FOUNDRY_RESOURCE}.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview"
)

try() { # url model token_param
  curl -sS -m 60 -o /tmp/smoke_body -w '%{http_code}' "$1" \
    -H "api-key: ${FOUNDRY_KEY}" -H "Content-Type: application/json" \
    -d "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}],\"$3\":200}" 2>/dev/null || echo "ERR"
}

printf '%-16s %-16s %-6s %s\n' MODEL ROUTE STATUS NOTE
for m in $MODELS; do
  for r in "${ROUTES[@]}"; do
    label="${r%%|*}"; url="${r#*|}"
    code=$(try "$url" "$m" max_tokens)
    note=""
    if [ "$code" = "400" ] && grep -q "max_completion_tokens\|unsupported_parameter" /tmp/smoke_body; then
      code=$(try "$url" "$m" max_completion_tokens); note="(needs max_completion_tokens)"
    fi
    if [ "$code" != "200" ]; then note="$note $(head -c 160 /tmp/smoke_body | tr '\n' ' ')"; fi
    printf '%-16s %-16s %-6s %s\n' "$m" "$label" "$code" "$note"
  done
done
