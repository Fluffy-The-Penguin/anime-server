# AniTrack Backend

Node API used by AniTrack for torrent RSS lookup and extension catalog metadata.

## Local Run

```bash
npm install
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

## Pterodactyl / Bot Hosting

- Upload the `backend` folder.
- Run `npm install` once.
- Startup command: `npm start`
- Set `PORT` to the port assigned by the panel if your host does not provide it automatically. The server also reads `SERVER_PORT`, `P_SERVER_PORT`, and `APP_PORT`.
- Set `CORS_ORIGIN` to your Vercel URL, for example `https://your-site.vercel.app`.

## Endpoints

- `GET /health`
- `GET /api/extensions/anime?limit=50`
- `GET /api/extensions/manga?limit=50`
- `GET /api/torrents/anime?title=Frieren&episode=1`
- `GET /api/torrents/manga?title=Berserk&chapter=1`
- `GET /api/stremio/manifest?url=https://addon.example/manifest.json`
- `GET /api/stremio/streams?url=https://addon.example/manifest.json&type=series&id=mal:123:1`
- `GET /api/stremio/search-streams?url=https://addon.example/manifest.json&title=Frieren&episode=1`
