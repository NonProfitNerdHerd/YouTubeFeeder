# YouTubeFeeder

This project is to build a YouTube app that doesn't suck.

## Manual setup (WebSub + API key)

Create a YouTube Data API **API key** in the **existing** Google Cloud project (do not create a second project). Store it as a Worker secret, never in Vite/client code:

```
npx wrangler secret put YOUTUBE_API_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars` (gitignored) and set `YOUTUBE_API_KEY`. Leave the Vite env files alone so the key is not exposed to the browser.

`PUBLIC_ORIGIN` in `wrangler.jsonc` must be the public Worker URL so Google's WebSub hub can reach `GET`/`POST /api/websub/callback`.
