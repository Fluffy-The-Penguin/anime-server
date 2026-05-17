import cors from "cors";
import express from "express";

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.P_SERVER_PORT || process.env.APP_PORT || 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);

const ANIME_REPO_URL = "https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json";
const MANGA_REPO_URL = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json";
const NYAA_RSS_URL = "https://nyaa.si/";
const MANGADEX_API_URL = "https://api.mangadex.org";
const ASURA_BASE_URL = "https://asurascans.com";

const app = express();
const cache = new Map();

const allowedOrigins = CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
}));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "anitrack-backend" });
});

app.get("/api/extensions/anime", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 50);
    const data = await fetchJsonCached(ANIME_REPO_URL);
    const extensions = normalizeExtensions(data, "anime").slice(0, limit);
    res.json(extensions);
  } catch (error) {
    next(error);
  }
});

app.get("/api/extensions/manga", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 50);
    const data = await fetchJsonCached(MANGA_REPO_URL);
    const extensions = normalizeExtensions(data, "manga").slice(0, limit);
    res.json(extensions);
  } catch (error) {
    next(error);
  }
});

app.get("/api/torrents/anime", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    const episode = cleanQuery(req.query.episode);
    if (!title || !episode) {
      res.status(400).json({ error: "title and episode are required" });
      return;
    }

    const paddedEpisode = String(episode).padStart(2, "0");
    const results = await searchNyaaRss([
      `${title} ${paddedEpisode}`,
      `${title} ${episode}`,
      `${title} - ${paddedEpisode}`,
      `${title} - ${episode}`,
      `${title} episode ${episode}`,
    ], ["1_2", "1_0"]);

    res.json(results);
  } catch (error) {
    next(error);
  }
});

app.get("/api/torrents/manga", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    const chapter = cleanQuery(req.query.chapter);
    if (!title || !chapter) {
      res.status(400).json({ error: "title and chapter are required" });
      return;
    }

    const results = await searchNyaaRss([
      `${title} chapter ${chapter}`,
      `${title} ch ${chapter}`,
      `${title} ${chapter}`,
    ], ["3_1", "3_0"]);

    res.json(results);
  } catch (error) {
    next(error);
  }
});

app.get("/api/manga/search", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const data = await fetchJsonCached(`${MANGADEX_API_URL}/manga?${new URLSearchParams([
      ["title", title],
      ["limit", "10"],
      ["includes[]", "cover_art"],
      ["availableTranslatedLanguage[]", "en"],
      ["contentRating[]", "safe"],
      ["contentRating[]", "suggestive"],
      ["order[relevance]", "desc"],
    ]).toString()}`);

    const [asuraResults] = await Promise.allSettled([searchAsuraManga(title)]);
    res.json([
      ...asArray(data.data).map(mapMangaDexManga),
      ...(asuraResults.status === "fulfilled" ? asuraResults.value : []),
    ]);
  } catch (error) {
    next(error);
  }
});

app.get("/api/manga/chapters", async (req, res, next) => {
  try {
    const mangaId = cleanQuery(req.query.mangaId);
    if (!mangaId) {
      res.status(400).json({ error: "mangaId is required" });
      return;
    }

    if (mangaId.startsWith("asura:")) {
      res.json(await getAsuraChapters(mangaId.slice(6)));
      return;
    }

    const chapters = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const data = await fetchJsonCached(`${MANGADEX_API_URL}/manga/${encodeURIComponent(mangaId)}/feed?${new URLSearchParams([
        ["translatedLanguage[]", "en"],
        ["order[chapter]", "asc"],
        ["includeEmptyPages", "0"],
        ["includeFutureUpdates", "0"],
        ["limit", "100"],
        ["offset", String(offset)],
      ]).toString()}`);
      chapters.push(...asArray(data.data).map(mapMangaDexChapter));
      if (chapters.length >= Number(data.total || 0) || asArray(data.data).length < 100) break;
    }

    res.json(chapters.filter((chapter) => chapter.number && chapter.pages > 0));
  } catch (error) {
    next(error);
  }
});

app.get("/api/manga/pages", async (req, res, next) => {
  try {
    const chapterId = cleanQuery(req.query.chapterId);
    if (!chapterId) {
      res.status(400).json({ error: "chapterId is required" });
      return;
    }

    if (chapterId.startsWith("asura:")) {
      res.json({ pages: await getAsuraPages(chapterId.slice(6)) });
      return;
    }

    const data = await fetchJsonCached(`${MANGADEX_API_URL}/at-home/server/${encodeURIComponent(chapterId)}`);
    const hash = data.chapter?.hash;
    const pages = asArray(data.chapter?.data).map((file) => `${data.baseUrl}/data/${hash}/${file}`);
    res.json({ pages });
  } catch (error) {
    next(error);
  }
});

app.get("/api/stremio/manifest", async (req, res, next) => {
  try {
    const url = validateHttpUrl(req.query.url);
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const manifest = await fetchJsonCached(url);
    res.json(manifest);
  } catch (error) {
    next(error);
  }
});

app.get("/api/stremio/streams", async (req, res, next) => {
  try {
    const manifestUrl = validateHttpUrl(req.query.url);
    const type = cleanQuery(req.query.type || "series");
    const id = cleanQuery(req.query.id);
    if (!manifestUrl || !type || !id) {
      res.status(400).json({ error: "url, type, and id are required" });
      return;
    }

    const baseUrl = manifestUrl.replace(/\/manifest\.json(?:\?.*)?$/i, "").replace(/\/+$/, "");
    const streamUrl = `${baseUrl}/stream/${pathSegment(type)}/${pathSegment(id)}.json`;
    const data = await fetchJsonCached(streamUrl, { emptyOn404: true });
    res.json(data.streams || []);
  } catch (error) {
    next(error);
  }
});

app.get("/api/stremio/search-streams", async (req, res, next) => {
  try {
    const manifestUrl = validateHttpUrl(req.query.url);
    const title = cleanQuery(req.query.title);
    const episode = cleanQuery(req.query.episode || "1");
    const malId = cleanQuery(req.query.malId);
    const anilistId = cleanQuery(req.query.anilistId);
    if (!manifestUrl || !title) {
      res.status(400).json({ error: "url and title are required" });
      return;
    }

    const streams = await searchStremioByTitle({ manifestUrl, title, episode, malId, anilistId });
    res.json(streams);
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "Backend request failed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AniTrack backend running on port ${PORT}`);
});

async function searchNyaaRss(queries, categories) {
  for (const category of categories) {
    for (const query of queries) {
      const params = new URLSearchParams({ page: "rss", q: query, c: category, f: "0" });
      const xml = await fetchTextCached(`${NYAA_RSS_URL}?${params.toString()}`);
      const results = parseNyaaRss(xml);
      if (results.length) return results;
    }
  }
  return [];
}

async function searchStremioByTitle({ manifestUrl, title, episode, malId, anilistId }) {
  const baseUrl = addonBaseUrl(manifestUrl);
  const manifest = await fetchJsonCached(manifestUrl);
  const catalogs = asArray(manifest.catalogs).filter((catalog) => ["series", "anime", "movie"].includes(catalog.type));
  const metas = [];

  for (const catalog of catalogs) {
    const supportsSearch = asArray(catalog.extra).some((extra) => extra.name === "search");
    if (!supportsSearch && catalogs.length > 1) continue;

    try {
      const data = await fetchJsonCached(`${baseUrl}/catalog/${pathSegment(catalog.type)}/${pathSegment(catalog.id)}/search=${encodeURIComponent(title)}.json`, { emptyOn404: true });
      asArray(data.metas).forEach((meta) => metas.push({ ...meta, type: catalog.type }));
    } catch (error) {
      // Try the next catalog.
    }
  }

  const bestMetas = metas
    .map((meta) => ({ ...meta, score: titleScore(title, meta.name || meta.title || "") }))
    .filter((meta) => meta.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const fallbackIds = [];
  if (malId) fallbackIds.push(`mal:${malId}:${episode}`, `mal:${malId}`);
  if (anilistId) fallbackIds.push(`anilist:${anilistId}:${episode}`, `anilist:${anilistId}`);

  for (const meta of bestMetas) {
    const streamIds = await streamIdCandidates(baseUrl, meta, episode);
    const streams = await firstStreamsForIds(baseUrl, meta.type, [...streamIds, ...fallbackIds]);
    if (streams.length) return streams.map((stream) => ({ ...stream, matchedTitle: meta.name || meta.title, matchedId: meta.id }));
  }

  return firstStreamsForIds(baseUrl, "series", fallbackIds);
}

async function streamIdCandidates(baseUrl, meta, episode) {
  const ids = [meta.id, `${meta.id}:${episode}`, `${meta.id}:1:${episode}`, `${meta.id}:0:${episode}`].filter(Boolean);
  try {
    const data = await fetchJsonCached(`${baseUrl}/meta/${pathSegment(meta.type)}/${pathSegment(meta.id)}.json`, { emptyOn404: true });
    asArray(data.meta?.videos).forEach((video) => {
      if (String(video.episode || "") === String(episode) || String(video.title || "").includes(String(episode))) ids.unshift(video.id);
    });
  } catch (error) {
    // Meta endpoint is optional.
  }
  return [...new Set(ids)];
}

async function firstStreamsForIds(baseUrl, type, ids) {
  for (const id of ids.filter(Boolean)) {
    try {
      const data = await fetchJsonCached(`${baseUrl}/stream/${pathSegment(type)}/${pathSegment(id)}.json`, { emptyOn404: true });
      if (asArray(data.streams).length) return data.streams;
    } catch (error) {
      // Try next ID.
    }
  }
  return [];
}

function addonBaseUrl(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json(?:\?.*)?$/i, "").replace(/\/+$/, "");
}

function titleScore(query, candidate) {
  const a = normalizeTitle(query);
  const b = normalizeTitle(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.82;
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return shared / Math.max(aTokens.size, bTokens.size, 1);
}

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mapMangaDexManga(item) {
  const attrs = item.attributes || {};
  const cover = asArray(item.relationships).find((rel) => rel.type === "cover_art")?.attributes?.fileName || "";
  const title = localizedText(attrs.title) || "Untitled";
  return {
    id: item.id,
    provider: "mangadex",
    title,
    description: localizedText(attrs.description),
    status: attrs.status || "unknown",
    year: attrs.year || "",
    cover: cover ? `https://uploads.mangadex.org/covers/${item.id}/${cover}.256.jpg` : "",
    score: titleScore(title, title),
  };
}

function mapMangaDexChapter(item) {
  const attrs = item.attributes || {};
  return {
    id: item.id,
    provider: "mangadex",
    number: attrs.chapter || "0",
    title: attrs.title ? `Chapter ${attrs.chapter || "?"}: ${attrs.title}` : `Chapter ${attrs.chapter || "?"}`,
    date: attrs.publishAt ? new Date(attrs.publishAt).toLocaleDateString("en-US") : "Date TBA",
    description: attrs.title || `Chapter ${attrs.chapter || "?"}`,
    pages: Number(attrs.pages || 0),
  };
}

async function searchAsuraManga(title) {
  const html = await fetchTextCached(`${ASURA_BASE_URL}/browse?search=${encodeURIComponent(title)}`);
  const results = [];
  const seen = new Set();
  const pattern = /<a[^>]+href="(\/comics\/[^"]+)"[\s\S]{0,700}?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const path = decodeXml(match[1]);
    if (seen.has(path)) continue;
    seen.add(path);
    const name = cleanHtml(match[2]);
    if (!name) continue;

    const nearby = html.slice(Math.max(0, match.index - 1600), Math.min(html.length, match.index + 1600));
    const cover = decodeXml(firstMatch(nearby, /&quot;cover(?:_url)?&quot;:\[0,&quot;([^&]+)&quot;\]/i));
    const description = cleanHtml(decodeXml(firstMatch(nearby, /&quot;description&quot;:\[0,&quot;([\s\S]*?)&quot;\]/i)));
    const chapterCount = Number(firstMatch(nearby, /&quot;chapter_count&quot;:\[0,(\d+)\]/i) || 0);

    results.push({
      id: `asura:${path}`,
      provider: "asura",
      title: name,
      description,
      status: "unknown",
      year: "",
      cover,
      chapterCount,
      score: titleScore(title, name),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function getAsuraChapters(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${ASURA_BASE_URL}${safePath}`);
  const chapters = [];
  const seen = new Set();
  const pattern = /href="(\/comics\/[^"]+\/chapter\/([^"/]+))"/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const chapterPath = decodeXml(match[1]);
    const number = decodeXml(match[2]);
    if (seen.has(chapterPath)) continue;
    seen.add(chapterPath);

    chapters.push({
      id: `asura:${chapterPath}`,
      provider: "asura",
      number,
      title: `Chapter ${number}`,
      date: "Date TBA",
      description: `Chapter ${number}`,
      pages: 1,
    });
  }

  return chapters
    .filter((chapter) => chapter.number !== "0")
    .sort((a, b) => Number(a.number) - Number(b.number));
}

async function getAsuraPages(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${ASURA_BASE_URL}${safePath}`);
  const pages = [];
  const seen = new Set();
  const pattern = /https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\/[^"'\\<\s]+?\.(?:webp|jpg|jpeg|png|gif)/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const url = decodeXml(match[0]).replace(/&quot.*$/i, "");
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push(url);
  }

  return pages;
}

function cleanHtml(value) {
  return decodeXml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function firstMatch(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
}

function localizedText(value) {
  if (!value) return "";
  return value.en || Object.values(value)[0] || "";
}

function parseNyaaRss(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((item) => {
    const infoHash = tagValue(item, "infoHash");
    const name = tagValue(item, "title") || "Unknown torrent";
    const link = tagValue(item, "link");

    return {
      name,
      link,
      magnet_uri: infoHash ? buildMagnetLink(infoHash, name) : link,
      seeders: Number(tagValue(item, "seeders") || 0),
      leechers: Number(tagValue(item, "leechers") || 0),
      downloads: Number(tagValue(item, "downloads") || 0),
      size: tagValue(item, "size"),
      category: tagValue(item, "category"),
      trusted: tagValue(item, "trusted"),
    };
  }).sort((a, b) => b.seeders - a.seeders);
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"));
  if (!match) return "";
  return decodeXml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
}

function decodeXml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeExtensions(data, type) {
  const extensions = Array.isArray(data) ? data : asArray(data?.extensions || Object.values(data || {}));
  return extensions.map((ext, index) => ({
    type,
    id: String(ext.id || ext.pkg || ext.key || ext.name || `${type}-${index}`),
    name: ext.name || "Unknown",
    version: ext.version || ext.versionCode || "1.0",
    description: ext.description || `${ext.lang || "Unknown language"} ${type} source`,
    lang: ext.lang || "unknown",
    nsfw: Boolean(Number(ext.nsfw || 0)),
    url: ext.sources?.[0]?.baseUrl || "",
    sources: asArray(ext.sources).map((source) => ({
      name: source.name || "Unknown source",
      lang: source.lang || ext.lang || "unknown",
      url: source.baseUrl || "",
    })),
  })).filter((ext) => ext.name && ext.url);
}

function buildMagnetLink(infoHash, name) {
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
  ];
  return `magnet:?xt=urn:btih:${encodeURIComponent(infoHash)}&dn=${encodeURIComponent(name)}${trackers.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join("")}`;
}

async function fetchJsonCached(url, options = {}) {
  const text = await fetchTextCached(url, options);
  return text ? JSON.parse(text) : {};
}

async function fetchTextCached(url, options = {}) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniTrack/1.0",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (response.status === 404 && options.emptyOn404) return "";
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    const value = await response.text();
    cache.set(url, { value, time: Date.now() });
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanQuery(value) {
  return String(value || "").trim().slice(0, 160);
}

function validateHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function pathSegment(value) {
  return encodeURIComponent(value).replace(/%3A/gi, ":");
}

function parseLimit(value, fallback) {
  const limit = Number(value || fallback);
  return Math.min(2000, Math.max(1, Number.isFinite(limit) ? limit : fallback));
}
