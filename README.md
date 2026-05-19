# AniTrack Backend

Node API used by AniTrack for AniList fallback data, extension catalog metadata, manga pages, and native anime source lookups.

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
- `POST /api/anilist`
- `GET /api/extensions/anime?limit=50`
- `GET /api/extensions/manga?limit=50`
- `GET /api/manga/search?title=Berserk&providers=mangadex`
- `GET /api/manga/chapters?mangaId=mangadex:...`
- `GET /api/manga/pages?chapterId=mangadex:...`
- `GET /api/anime/animedex/search?title=Bleach`
- `GET /api/anime/animedex/episodes?animeId=...&anilistId=...`
- `GET /api/anime/animedex/streams?episodeId=...`
- `GET /api/anime/anizone/search?title=Bleach`
- `GET /api/anime/anizone/episodes?animeId=...`
- `GET /api/anime/anizone/streams?episodeUrl=...`
