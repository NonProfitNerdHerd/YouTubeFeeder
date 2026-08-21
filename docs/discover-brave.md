# Discover Brave provider (Phases 1–4)

Brave backs **typed YouTube Discover** and **For You / topic / Discover More** when `DISCOVER_SEARCH_PROVIDER=brave`. Podcasts, Popular, Live, and WebSub are unchanged.

## Architecture split

| Concern | Source |
| --- | --- |
| Typed Discover **YouTube search** | Brave + batch `videos.list` / `channels.list` |
| For You interest chip / Discover More | Same Brave provider pool + For You fingerprint scoring (`MIN_ACCEPT=55`) |
| Subscribed channel/video data | Existing YouTube APIs + WebSub + feed ingestion |

Typed relevance scoring and For You fingerprint scoring stay separate. Brave only supplies candidates.

### Shared 30-day cache

`discover_provider_cache` key:

```text
brave:youtube:{strategyVersion}:{normalizeDiscoverQuery(query)}
```

Typed `Microsoft` and interest-label `Microsoft` share the same pool when strategy/query match. User subscribed / Not Interested filters apply after load and never mutate the global pool.

### Discover More

1. Score unused provider/topic candidates against the interest fingerprint  
2. Persist qualifying rows  
3. Only if still short: fetch the **next** Brave provider page (no restart at offset 0)  
4. Repeat within `DISCOVER_BRAVE_MAX_PAGES_PER_REQUEST` and soft caps  

Zero qualifying candidates → empty state (HTTP 200), not `Could not discover recommendations.`

### V1 Brave query strategy

```text
site:youtube.com {query}
```

For You prefers one primary query (interest label) + pagination over many paid expansions.

### Attribution

Brave Search API Terms say customers **may** provide “POWERED BY BRAVE” attribution. Confirm with your plan/ToS before production launch. No UI badge is added yet.

## Secrets / vars

```bash
npx wrangler secret put BRAVE_SEARCH_API_KEY
```

- `DISCOVER_SEARCH_PROVIDER=brave` — required to activate Brave for typed + For You
- `DISCOVER_PROVIDER_STRATEGY_VERSION=v1`
- `BRAVE_USER_DAILY_SOFT_CAP=100`
- `BRAVE_GLOBAL_DAILY_SOFT_CAP=750`
- `DISCOVER_BRAVE_MAX_PAGES_PER_REQUEST=3`
- Migration `0027_discover_brave_provider.sql` must be applied remotely

No silent fallback from Brave to YouTube `search.list`.
