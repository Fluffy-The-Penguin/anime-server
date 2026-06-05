import cors from "cors";
import express from "express";
import Database from "better-sqlite3";
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.P_SERVER_PORT || process.env.APP_PORT || 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const ACCOUNT_DATABASE_FILE = process.env.ACCOUNT_DATABASE_FILE || process.env.SQLITE_FILE || join(process.cwd(), "data", "sync.sqlite");
const LEGACY_ACCOUNT_DATA_FILE = process.env.ACCOUNT_DATA_FILE || join(process.cwd(), "data", "users.json");
const ACCOUNT_SECRET = process.env.ACCOUNT_SECRET || "anitrack-account-secret";
const ACCOUNT_JSON_LIMIT = process.env.ACCOUNT_JSON_LIMIT || process.env.JSON_LIMIT || "50mb";
const ACCOUNT_TOKEN_TTL_MS = Number(process.env.ACCOUNT_TOKEN_TTL_MS || 1000 * 60 * 60 * 24 * 90);

const app = express();
const allowedOrigins = CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
const db = openDatabase();

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
}));
app.use(express.json({ limit: ACCOUNT_JSON_LIMIT }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "anitrack-sync", storage: "sqlite" });
});

app.post("/api/account/register", (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    if (!username || password.length < 6) {
      res.status(400).json({ error: "Username and password with at least 6 characters are required" });
      return;
    }

    if (getUser(username)) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }

    const user = {
      username,
      password: hashPassword(password),
      data: normalizeSyncData(req.body?.data),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    insertUser(user);
    res.json(accountResponse(user));
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/login", (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const user = username ? getUser(username) : null;
    if (!user || !verifyPassword(password, user.password)) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    res.json(accountResponse(user));
  } catch (error) {
    next(error);
  }
});

app.get("/api/account/sync", (req, res, next) => {
  try {
    const user = requireAccount(req);
    res.json({ username: user.username, data: user.data, updatedAt: user.updatedAt || 0 });
  } catch (error) {
    next(error);
  }
});

app.put("/api/account/sync", (req, res, next) => {
  try {
    const user = requireAccount(req);
    const updatedAt = Date.now();
    updateUserData(user.username, normalizeSyncData(req.body?.data), updatedAt);
    res.json({ ok: true, username: user.username, updatedAt });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((error, req, res, next) => {
  if (error.type === "entity.too.large") {
    res.status(413).json({ error: `Sync payload is too large. Increase ACCOUNT_JSON_LIMIT above ${ACCOUNT_JSON_LIMIT}.` });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  const status = Number(error.status || 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "Sync request failed" : error.message || "Request failed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AniTrack sync server running on port ${PORT}`);
});

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function openDatabase() {
  mkdirSync(dirname(ACCOUNT_DATABASE_FILE), { recursive: true });
  const database = new Database(ACCOUNT_DATABASE_FILE);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  migrateLegacyUsers(database);
  return database;
}

function migrateLegacyUsers(database) {
  const hasUsers = database.prepare("SELECT 1 FROM users LIMIT 1").get();
  if (hasUsers || !existsSync(LEGACY_ACCOUNT_DATA_FILE)) return;

  let legacy = {};
  try {
    legacy = JSON.parse(readFileSync(LEGACY_ACCOUNT_DATA_FILE, "utf8")) || {};
  } catch (error) {
    return;
  }

  const insert = database.prepare(`
    INSERT OR IGNORE INTO users (username, password, data, created_at, updated_at)
    VALUES (@username, @password, @data, @createdAt, @updatedAt)
  `);
  const migrate = database.transaction((users) => {
    Object.values(users || {}).forEach((user) => {
      const username = normalizeUsername(user?.username);
      const password = String(user?.password || "");
      if (!username || !password) return;
      insert.run({
        username,
        password,
        data: serializeSyncData(user.data),
        createdAt: Number(user.createdAt || Date.now()),
        updatedAt: Number(user.updatedAt || Date.now()),
      });
    });
  });
  migrate(legacy);
}

function getUser(username) {
  const row = db.prepare("SELECT username, password, data, created_at, updated_at FROM users WHERE username = ?").get(username);
  return row ? rowToUser(row) : null;
}

function insertUser(user) {
  db.prepare(`
    INSERT INTO users (username, password, data, created_at, updated_at)
    VALUES (@username, @password, @data, @createdAt, @updatedAt)
  `).run({ ...user, data: serializeSyncData(user.data) });
}

function updateUserData(username, data, updatedAt) {
  db.prepare("UPDATE users SET data = ?, updated_at = ? WHERE username = ?").run(serializeSyncData(data), updatedAt, username);
}

function rowToUser(row) {
  return {
    username: row.username,
    password: row.password,
    data: parseSyncData(row.data),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("base64url");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("base64url");
  return safeEqual(candidate, hash);
}

function accountResponse(user) {
  return {
    username: user.username,
    token: accountToken(user.username),
    data: normalizeSyncData(user.data),
    updatedAt: user.updatedAt || 0,
  };
}

function accountToken(username) {
  const expires = Date.now() + ACCOUNT_TOKEN_TTL_MS;
  const payload = `${username}.${expires}`;
  const signature = createHmac("sha256", ACCOUNT_SECRET).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

function requireAccount(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const decoded = decodeToken(token);
  const [username, expires, signature] = decoded.split(".");
  const payload = `${username}.${expires}`;
  const expected = createHmac("sha256", ACCOUNT_SECRET).update(payload).digest("base64url");
  if (!username || Number(expires) < Date.now() || !safeEqual(signature, expected)) throw unauthorizedError();

  const user = getUser(username);
  if (!user) throw unauthorizedError();
  return user;
}

function decodeToken(token) {
  try {
    return token ? Buffer.from(token, "base64url").toString("utf8") : "";
  } catch (error) {
    return "";
  }
}

function unauthorizedError() {
  const error = new Error("Unauthorized");
  error.status = 401;
  return error;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeSyncData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return JSON.parse(JSON.stringify(data));
}

function serializeSyncData(data) {
  return JSON.stringify(normalizeSyncData(data));
}

function parseSyncData(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return normalizeSyncData(parsed);
  } catch (error) {
    return {};
  }
}
