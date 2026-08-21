# Discover Brave provider (Phases 1–2)

Infrastructure only. Production Discover still uses YouTube `search.list` until Phase 3.

## Architecture split

| Concern | Source |
| --- | --- |
| Typed Discover **YouTube search** (when `DISCOVER_SEARCH_PROVIDER=brave`) | Brave Search API + batch `videos.list` / `channels.list` |
| For You / Discover More / topic fill | Still YouTube `search.list` (Phase 4+) |
| Subscribed channel/video data | Existing YouTube APIs + WebSub + feed ingestion |

### V1 Brave query strategy

```text
site:youtube.com {query}
```

Selected for usable unique channels per Brave request: includes channel pages and videos (resolved via `videos.list`). Alternate `site:youtube.com/@ {query}` is retained as strategy `v1-at` for offline comparison only.

### Attribution

Brave Search API Terms say customers **may** provide “POWERED BY BRAVE” attribution (with logo) when attributing; they do not state a mandatory UI badge for all integrations. Confirm with your Brave plan/ToS before production launch. Phase 3 does not add Brave branding to the Discover UI.


## Secrets / vars

```bash
# Production
npx wrangler secret put BRAVE_SEARCH_API_KEY

# Local: add to .dev.vars (never commit real keys)
BRAVE_SEARCH_API_KEY=...
```

Configurable vars (also in `wrangler.jsonc`):

- `DISCOVER_SEARCH_PROVIDER=youtube` — leave as `youtube` until Phase 3
- `DISCOVER_PROVIDER_STRATEGY_VERSION=v1`
- `BRAVE_USER_DAILY_SOFT_CAP=100` — actual Brave HTTP requests / user / UTC day
- `BRAVE_GLOBAL_DAILY_SOFT_CAP=750` — actual Brave HTTP requests / UTC day
- Cache hits do **not** count against these caps

## Migration

```bash
npx wrangler d1 migrations apply youtube-feeder --local
npx wrangler d1 migrations apply youtube-feeder --remote
```

Tables: `discover_provider_cache`, `discover_provider_locks`, `discover_brave_usage_daily`.

Cache key: `brave:youtube:{strategyVersion}:{normalizedQuery}` · TTL 30 days.

Expired cache rows are retained ~7 days after `expires_at` for stale-while-error, then removed by lazy cleanup.

Provider-page exhaustion (`provider_offset` / `more_results_available`) is separate from usable-candidate exhaustion (`candidate_consume_offset` vs `candidates_json`).
