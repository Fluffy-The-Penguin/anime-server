# AniTrack Sync Backend

Small Express API used only for AniTrack account login and cloud sync. It stores one opaque JSON sync document per user in SQLite, so the app can sync libraries, settings, extension setup, and backup state without this server knowing the app schema.

## Local Run

```bash
npm install
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

## Configuration

- `PORT`: HTTP port. The server also reads `SERVER_PORT`, `P_SERVER_PORT`, and `APP_PORT`.
- `CORS_ORIGIN`: Comma-separated allowed origins, or `*`.
- `ACCOUNT_SECRET`: Secret used to sign account tokens. Set this in production.
- `ACCOUNT_DATABASE_FILE`: SQLite database path. Defaults to `data/sync.sqlite`.
- `ACCOUNT_JSON_LIMIT`: Maximum request body size. Defaults to `50mb`.
- `ACCOUNT_TOKEN_TTL_MS`: Token lifetime. Defaults to 90 days.

If an old `data/users.json` file exists and the SQLite database is empty, it is imported once on startup.

## Endpoints

- `GET /health`
- `POST /api/account/register`
- `POST /api/account/login`
- `GET /api/account/sync`
- `PUT /api/account/sync`

Authenticated sync endpoints require `Authorization: Bearer <token>` from login/register.
