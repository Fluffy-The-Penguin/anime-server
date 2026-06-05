# watchAny Sync Backend

Small Express API used only for watchAny account login and cloud sync. It stores one opaque JSON sync document per user in SQLite, so the app can sync libraries, settings, extension setup, and backup state without this server knowing the app schema.

## Local Run

```bash
npm install
npm start
```

The server reads `.env` from the working directory before startup.

Health check:

```bash
curl http://localhost:21204/health
```

## Configuration

- `PORT`: HTTP port. Defaults to `21204` for the hosted sync server. The server also reads `SERVER_PORT`, `P_SERVER_PORT`, `APP_PORT`, `BOT_PORT`, `PRIMARY_PORT`, `ALLOCATED_PORT`, `PTERODACTYL_PORT`, and `BOT_HOSTING_PORT`.
- `CORS_ORIGIN`: Comma-separated allowed origins, or `*`.
- `ACCOUNT_SECRET`: Secret used to sign account tokens. Set this in production. If missing, the server generates a temporary secret and all login tokens expire on restart.
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

## Bot-Hosting / Pterodactyl Notes

The backend must listen on the same port the hosting panel exposes. For the current watchAny sync host, the exposed address is:

```text
fi10.bot-hosting.net:21204
```

If logs show `watchAny sync server running on port 3000`, the app is listening on the wrong internal port and `http://watchany-fluffy.duckdns.org:21204/health` will fail. Restart after pulling this version, or set `PORT=21204` in the hosting panel environment.
