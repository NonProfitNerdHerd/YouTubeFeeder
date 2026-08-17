# YouTube Data API quota

Source: [Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost), verified **2026-08-17**.

Default project buckets (same Google Cloud project for Feed and Quad):

| Bucket | Daily default | Cost |
|---|---|---|
| General units | 10,000 | 1 unit per `subscriptions.list`, `channels.list`, `playlistItems.list`, `videos.list`, and other non-search methods |
| `search.list` | 100 calls | 1 unit per call in a **separate** bucket — do **not** bill as 100 general units |
| `videos.insert` | separate | unused by VortiQuest |

WebSub hub GET/POST to `https://pubsubhubbub.appspot.com` is **not** YouTube Data API quota (`general_units = 0`). Counts are stored in `api_quota_daily` under `websub.*`.

Feed upload metadata uses `YOUTUBE_API_KEY` on `videos.list` (1 general unit per batch of up to 50 IDs). Subscription snapshots use each user's OAuth token for `subscriptions.list?mine=true` only.

Daily endpoint counts persist in D1 table `api_quota_daily`.
