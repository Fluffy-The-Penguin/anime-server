import cors from "cors";
import express from "express";
import { pbkdf2Sync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.P_SERVER_PORT || process.env.APP_PORT || 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const ACCOUNT_DATA_FILE = process.env.ACCOUNT_DATA_FILE || join(process.cwd(), "data", "users.json");
const ACCOUNT_SECRET = process.env.ACCOUNT_SECRET || "anitrack-account-secret";

const ANIME_REPO_URL = "https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json";
const MANGA_REPO_URL = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json";
const MANGADEX_API_URL = "https://api.mangadex.org";
const ANILIST_URL = "https://graphql.anilist.co";
const JIKAN_BASE_URL = "https://api.jikan.moe/v4";
const ASURA_BASE_URL = "https://asurascans.com";
const MANGAKATANA_BASE_URL = "https://mangakatana.com";
const WEEBCENTRAL_BASE_URL = "https://weebcentral.com";
const FLAMECOMICS_BASE_URL = "https://flamecomics.xyz";
const FLAMECOMICS_CDN_URL = "https://cdn.flamecomics.xyz";
const RIZZCOMIC_BASE_URL = "https://rizzcomic.com";
const TOONILY_BASE_URL = "https://toonily.com";
const PORNHWAZ_BASE_URL = "https://www.pornhwaz.com";
const HENTAI20_BASE_URL = "https://hentai20.io";
const PORNHWAPRO_BASE_URL = "https://pornhwa.pro";
const HENTAI18_BASE_URL = "https://hentai18.net";
const HENTAINAME_BASE_URL = "https://www.hentai.name";
const HENTAIZAP_BASE_URL = "https://hentaizap.com";
const HENTAIFOX_BASE_URL = "https://hentaifox.com";
const THREEHENTAI_BASE_URL = "https://3hentai.net";
const HENTAIERA_BASE_URL = "https://hentaiera.com";
const HENTAICITY_BASE_URL = "https://www.hentaicity.com";
const ANIWAVES_BASE_URL = "https://aniwaves.ru";
const HSTREAM_BASE_URL = "https://hstream.moe";
const ANIMEDEX_BASE_URL = "https://animedex.pp.ua";
const ANIZONE_BASE_URL = "https://anizone.to";

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
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "anitrack-backend" });
});

app.post("/api/account/register", async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    if (!username || password.length < 6) {
      res.status(400).json({ error: "Username and password with at least 6 characters are required" });
      return;
    }

    const users = loadUsers();
    if (users[username]) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }

    users[username] = {
      username,
      password: hashPassword(password),
      data: sanitizeAccountData(req.body?.data),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveUsers(users);
    res.json(accountResponse(users[username]));
  } catch (error) {
    next(error);
  }
});

app.post("/api/account/login", async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const users = loadUsers();
    const user = username ? users[username] : null;
    if (!user || !verifyPassword(password, user.password)) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    res.json(accountResponse(user));
  } catch (error) {
    next(error);
  }
});

app.get("/api/account/sync", async (req, res, next) => {
  try {
    const user = requireAccount(req);
    res.json({ username: user.username, data: user.data || {}, updatedAt: user.updatedAt || 0 });
  } catch (error) {
    next(error);
  }
});

app.put("/api/account/sync", async (req, res, next) => {
  try {
    const { users, username } = requireAccount(req, true);
    users[username].data = sanitizeAccountData(req.body?.data);
    users[username].updatedAt = Date.now();
    saveUsers(users);
    res.json({ ok: true, username, updatedAt: users[username].updatedAt });
  } catch (error) {
    next(error);
  }
});

app.post("/api/anilist", async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.query) {
      res.status(400).json({ error: "Missing AniList query" });
      return;
    }

    if (body.variables?.source === "jikan") {
      res.json(await fallbackAniListResponse(body));
      return;
    }

    try {
      const data = await postJson(ANILIST_URL, { query: body.query, variables: body.variables || {} }, {
        headers: { Origin: "https://anilist.co", Referer: "https://anilist.co/" },
      });
      res.json(data);
    } catch (error) {
      const fallback = await fallbackAniListResponse(body);
      if (fallback) {
        res.json(fallback);
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
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

app.get("/api/anime/search", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    res.json(await searchAniwavesAnime(title));
  } catch (error) {
    next(error);
  }
});

app.get("/api/anime/animedex/search", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    res.json(await searchAnimeDex(title));
  } catch (error) {
    if (isProviderUnavailableError(error)) {
      res.json([]);
      return;
    }
    next(error);
  }
});

app.get("/api/anime/animedex/episodes", async (req, res, next) => {
  try {
    const animeId = cleanQuery(req.query.animeId);
    const anilistId = cleanQuery(req.query.anilistId);
    if (!animeId && !anilistId) {
      res.status(400).json({ error: "animeId or anilistId is required" });
      return;
    }

    res.json(await getAnimeDexEpisodes({ animeId, anilistId }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/anime/animedex/streams", async (req, res, next) => {
  try {
    const episodeId = cleanQuery(req.query.episodeId || req.query.id);
    if (!episodeId) {
      res.status(400).json({ error: "episodeId is required" });
      return;
    }

    res.json(await getAnimeDexStreams(episodeId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/anime/animedex/proxy", async (req, res, next) => {
  try {
    await proxyAnimeDexMedia(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/anime/anizone/search", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    res.json(await searchAniZone(title));
  } catch (error) {
    if (isProviderUnavailableError(error)) {
      res.json([]);
      return;
    }
    next(error);
  }
});

app.get("/api/anime/anizone/episodes", async (req, res, next) => {
  try {
    const animeId = cleanQuery(req.query.animeId);
    if (!animeId) {
      res.status(400).json({ error: "animeId is required" });
      return;
    }

    res.json(await getAniZoneEpisodes(animeId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/anime/anizone/streams", async (req, res, next) => {
  try {
    const episodeUrl = validateHttpUrl(req.query.episodeUrl || req.query.url);
    if (!episodeUrl || !episodeUrl.startsWith(`${ANIZONE_BASE_URL}/anime/`)) {
      res.status(400).json({ error: "valid AniZone episodeUrl is required" });
      return;
    }

    res.json(await getAniZoneStreams(episodeUrl));
  } catch (error) {
    next(error);
  }
});

app.get("/api/anime/anizone/proxy", async (req, res, next) => {
  try {
    await proxyAniZoneMedia(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/adult/search", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    res.json(await searchHstreamAdult(title));
  } catch (error) {
    next(error);
  }
});

app.get("/api/adult/streams", async (req, res, next) => {
  try {
    const url = validateHttpUrl(req.query.url);
    if (!url || !url.startsWith(`${HSTREAM_BASE_URL}/hentai/`)) {
      res.status(400).json({ error: "valid hstream url is required" });
      return;
    }

    res.json(await getHstreamAdultStreams(url));
  } catch (error) {
    next(error);
  }
});

app.get("/api/manga/search", async (req, res, next) => {
  try {
    const title = cleanQuery(req.query.title);
    const latest = !title && String(req.query.latest || "") === "1";
    if (!title && !latest) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const providers = providerSet(req.query.providers);
    const page = Math.max(1, Number.parseInt(req.query.page || "1", 10) || 1);
    const doujinQueries = doujinSearchQueries(title, providers);

    const [mangaDexResults, asuraResults, mangaKatanaResults, weebCentralResults, flameComicsResults, rizzComicResults, toonilyResults, pornhwaZResults, hentai20Results, pornhwaProResults, hentai18Results, hentaiNameResults, hentaiZapResults, hentaiFoxResults, threeHentaiResults, hentaiEraResults, hentaiCityResults] = await Promise.allSettled([
      providers.has("mangadex") && !latest ? searchMangaDexManga(title) : [],
      providers.has("asura") && !latest ? searchAsuraManga(title) : [],
      providers.has("mangakatana") && !latest ? searchMangaKatanaManga(title) : [],
      providers.has("weebcentral") && !latest ? searchWeebCentralManga(title) : [],
      providers.has("flamecomics") && !latest ? searchFlameComicsManga(title) : [],
      providers.has("rizzcomic") && !latest ? searchRizzComicManga(title) : [],
      providers.has("toonily") && !latest ? searchToonilyManga(title) : [],
      providers.has("pornhwaz") && !latest ? searchPornhwaZ(title) : [],
      providers.has("hentai20") && !latest ? searchHentai20(title) : [],
      providers.has("pornhwapro") && !latest ? searchPornhwaPro(title) : [],
      providers.has("hentai18") && !latest ? searchHentai18(title) : [],
      providers.has("hentainame") && !latest ? searchHentaiName(title) : [],
      providers.has("hentaizap") ? (latest ? latestHentaiZap(page) : searchManyDoujinQueries("hentaizap", doujinQueries, page)) : [],
      providers.has("hentaifox") ? (latest ? latestHentaiFox(page) : searchManyDoujinQueries("hentaifox", doujinQueries, page)) : [],
      providers.has("3hentai") ? (latest ? latest3Hentai(page) : searchManyDoujinQueries("3hentai", doujinQueries, page)) : [],
      providers.has("hentaiera") ? (latest ? latestHentaiEra(page) : searchManyDoujinQueries("hentaiera", doujinQueries, page)) : [],
      providers.has("hentaicity") ? (latest ? latestHentaiCity() : searchHentaiCity(title)) : [],
    ]);
    res.json([
      ...(mangaDexResults.status === "fulfilled" ? mangaDexResults.value : []),
      ...(asuraResults.status === "fulfilled" ? asuraResults.value : []),
      ...(mangaKatanaResults.status === "fulfilled" ? mangaKatanaResults.value : []),
      ...(weebCentralResults.status === "fulfilled" ? weebCentralResults.value : []),
      ...(flameComicsResults.status === "fulfilled" ? flameComicsResults.value : []),
      ...(rizzComicResults.status === "fulfilled" ? rizzComicResults.value : []),
      ...(toonilyResults.status === "fulfilled" ? toonilyResults.value : []),
      ...(pornhwaZResults.status === "fulfilled" ? pornhwaZResults.value : []),
      ...(hentai20Results.status === "fulfilled" ? hentai20Results.value : []),
      ...(pornhwaProResults.status === "fulfilled" ? pornhwaProResults.value : []),
      ...(hentai18Results.status === "fulfilled" ? hentai18Results.value : []),
      ...(hentaiNameResults.status === "fulfilled" ? hentaiNameResults.value : []),
      ...(hentaiZapResults.status === "fulfilled" ? hentaiZapResults.value : []),
      ...(hentaiFoxResults.status === "fulfilled" ? hentaiFoxResults.value : []),
      ...(threeHentaiResults.status === "fulfilled" ? threeHentaiResults.value : []),
      ...(hentaiEraResults.status === "fulfilled" ? hentaiEraResults.value : []),
      ...(hentaiCityResults.status === "fulfilled" ? hentaiCityResults.value : []),
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

    if (mangaId.startsWith("mangakatana:")) {
      res.json(await getMangaKatanaChapters(mangaId.slice(12)));
      return;
    }

    if (mangaId.startsWith("weebcentral:")) {
      res.json(await getWeebCentralChapters(mangaId.slice(12)));
      return;
    }

    if (mangaId.startsWith("flamecomics:")) {
      res.json(await getFlameComicsChapters(mangaId.slice(13)));
      return;
    }

    if (mangaId.startsWith("rizzcomic:")) {
      res.json(await getRizzComicChapters(mangaId.slice(10)));
      return;
    }

    if (mangaId.startsWith("toonily:")) {
      res.json(await getToonilyChapters(mangaId.slice(8)));
      return;
    }

    const adultProvider = adultMangaProviderFromId(mangaId);
    if (adultProvider) {
      res.json(await getAdultMangaChapters(adultProvider, mangaId.slice(adultProvider.length + 1)));
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

    if (chapterId.startsWith("mangakatana:")) {
      res.json({ pages: await getMangaKatanaPages(chapterId.slice(12)) });
      return;
    }

    if (chapterId.startsWith("weebcentral:")) {
      res.json({ pages: await getWeebCentralPages(chapterId.slice(12)) });
      return;
    }

    if (chapterId.startsWith("flamecomics:")) {
      res.json({ pages: await getFlameComicsPages(chapterId.slice(13)) });
      return;
    }

    if (chapterId.startsWith("rizzcomic:")) {
      res.json({ pages: await getRizzComicPages(chapterId.slice(10)) });
      return;
    }

    if (chapterId.startsWith("toonily:")) {
      res.json({ pages: await getToonilyPages(chapterId.slice(8)) });
      return;
    }

    const adultProvider = adultMangaProviderFromId(chapterId);
    if (adultProvider) {
      res.json({ pages: await getAdultMangaPages(adultProvider, chapterId.slice(adultProvider.length + 1)) });
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

app.use((error, req, res, next) => {
  const isTimeout = error.name === "AbortError" || error.code === "UPSTREAM_TIMEOUT";
  const isUpstreamHttpError = Boolean(error.url && error.status && error.status >= 400);
  const status = isTimeout ? 504 : isUpstreamHttpError ? 502 : error.status || 500;
  console.error(isTimeout
    ? `Upstream request timed out: ${error.url || req.originalUrl}`
    : isUpstreamHttpError
      ? `Upstream request failed: ${error.status} ${error.message} ${error.url}`
      : error);
  res.status(status).json({ error: isTimeout ? "Upstream request timed out" : isUpstreamHttpError ? `Upstream source returned ${error.status}` : "Backend request failed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AniTrack backend running on port ${PORT}`);
});

async function fallbackAniListResponse(body) {
  const query = String(body?.query || "");
  const variables = body?.variables || {};
  const type = /type:\s*MANGA/.test(query) ? "manga" : "anime";
  const page = Math.max(1, Number(variables.page) || 1);

  if (/Media\s*\(/.test(query)) {
    const id = Number(variables.id);
    if (!id) return null;
    const data = await fetchJsonCached(`${JIKAN_BASE_URL}/${type}/${id}/full`);
    return { data: { Media: type === "manga" ? jikanToAniListManga(data.data) : jikanToAniListAnime(data.data) } };
  }

  const params = new URLSearchParams({ page: String(page), limit: "25" });
  if (variables.search) params.set("q", String(variables.search));
  if (variables.year) params.set("start_date", `${variables.year}-01-01`);
  const endpoint = variables.search ? `${JIKAN_BASE_URL}/${type}` : `${JIKAN_BASE_URL}/top/${type}`;
  const data = await fetchJsonCached(`${endpoint}?${params}`);
  const mapper = type === "manga" ? jikanToAniListManga : jikanToAniListAnime;
  return { data: { Page: { media: asArray(data.data).map(mapper).filter(Boolean) } } };
}

function jikanToAniListAnime(item) {
  if (!item) return null;
  return {
    id: item.mal_id,
    idMal: item.mal_id,
    dataSource: "jikan",
    title: { romaji: item.title || "", english: item.title_english || item.title || "", native: item.title_japanese || "" },
    synonyms: asArray(item.title_synonyms),
    description: item.synopsis || "",
    episodes: item.episodes || 0,
    duration: parseDurationMinutes(item.duration),
    averageScore: item.score ? Math.round(Number(item.score) * 10) : null,
    popularity: item.members || 0,
    seasonYear: item.year || yearFromDate(item.aired?.from),
    status: item.status || "Unknown",
    format: item.type || "Anime",
    genres: asArray(item.genres).map((genre) => genre.name).filter(Boolean),
    bannerImage: item.trailer?.images?.maximum_image_url || item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || "",
    coverImage: { extraLarge: item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || "", large: item.images?.jpg?.image_url || "", color: null },
    studios: { nodes: asArray(item.studios).map((studio) => ({ name: studio.name })) },
    streamingEpisodes: [],
  };
}

function jikanToAniListManga(item) {
  if (!item) return null;
  return {
    id: item.mal_id,
    idMal: item.mal_id,
    dataSource: "jikan",
    title: { romaji: item.title || "", english: item.title_english || item.title || "", native: item.title_japanese || "" },
    synonyms: asArray(item.title_synonyms),
    description: item.synopsis || "",
    chapters: item.chapters || 0,
    volumes: item.volumes || 0,
    averageScore: item.score ? Math.round(Number(item.score) * 10) : null,
    popularity: item.members || 0,
    seasonYear: yearFromDate(item.published?.from),
    status: item.status || "Unknown",
    format: item.type || "Manga",
    genres: asArray(item.genres).map((genre) => genre.name).filter(Boolean),
    bannerImage: item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || "",
    coverImage: { extraLarge: item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || "", large: item.images?.jpg?.image_url || "", color: null },
    staff: { nodes: asArray(item.authors).slice(0, 1).map((author) => ({ name: { full: author.name } })) },
  };
}

function yearFromDate(value) {
  const year = new Date(value || "").getUTCFullYear();
  return Number.isFinite(year) ? year : null;
}

function parseDurationMinutes(value) {
  const match = /([0-9]+)\s*min/i.exec(String(value || ""));
  return match ? Number(match[1]) : 0;
}

async function searchAniwavesAnime(title) {
  const data = await fetchJsonCached(`${ANIWAVES_BASE_URL}/ajax/anime/search?keyword=${encodeURIComponent(title)}`, {
    headers: {
      "Accept": "application/json,text/javascript,*/*;q=0.01",
      "Referer": `${ANIWAVES_BASE_URL}/home`,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const html = String(data.result?.html || "");
  return parseAniwavesSearchResults(html, title);
}

function parseAniwavesSearchResults(html, query) {
  const results = [];
  const itemRegex = /<a\b[^>]*class="[^"]*\bitem\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = itemRegex.exec(html)) && results.length < 10) {
    const itemHtml = match[2];
    const titleMatch = itemHtml.match(/<div\b[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const title = stripHtml(titleMatch?.[1] || "");
    if (!title) continue;

    const image = firstMatch(itemHtml, /<img\b[^>]*src="([^"]+)"/i);
    const meta = [...itemHtml.matchAll(/<span\b[^>]*class="[^"]*\bdot\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)].map((metaMatch) => stripHtml(metaMatch[1])).filter(Boolean);
    results.push({
      provider: "aniwaves",
      id: match[1].replace(/^\/watch\//, ""),
      title,
      url: absolutizeUrl(match[1], ANIWAVES_BASE_URL),
      image: absolutizeUrl(image, ANIWAVES_BASE_URL),
      rating: meta[0] || "",
      score: meta[1] || "",
      type: meta[2] || "",
      date: meta[3] || "",
      matchScore: titleScore(query, title),
    });
  }
  return results.sort((a, b) => b.matchScore - a.matchScore);
}

async function searchAnimeDex(title) {
  const data = await fetchJsonCached(`${ANIMEDEX_BASE_URL}/api/anime/search?q=${encodeURIComponent(title)}&page=1`);
  return asArray(data.animes).map((item) => ({
    provider: "animedex",
    id: item.id,
    anilistId: item.anilistId || "",
    malId: item.malId || "",
    title: cleanHtml(item.name || item.title || item.id),
    nativeTitle: cleanHtml(item.jname || ""),
    url: `${ANIMEDEX_BASE_URL}/watch/${encodeURIComponent(item.id)}/ep-1`,
    image: item.poster || item.image || "",
    banner: item.banner || "",
    episodeCount: item.episodes?.total || item.episodes?.sub || item.totalEpisodes || 0,
    score: titleScore(title, item.name || item.title || item.id),
  })).filter((item) => item.id && item.title && item.score >= 0.2).sort((a, b) => b.score - a.score);
}

function isProviderUnavailableError(error) {
  return Boolean(error?.url && [403, 429, 500, 502, 503, 504].includes(Number(error.status)));
}

async function getAnimeDexEpisodes({ animeId, anilistId }) {
  if (anilistId) {
    const data = await postJson(`${ANIMEDEX_BASE_URL}/api/stream/sources`, { action: "episodes", anilistId });
    const episodes = [...asArray(data.sub).map((item) => ({ ...item, audio: "sub" })), ...asArray(data.dub).map((item) => ({ ...item, audio: "dub" }))];
    if (episodes.length) return episodes.map((episode, index) => animeDexEpisodeRow(episode, index));
  }

  const data = await fetchJsonCached(`${ANIMEDEX_BASE_URL}/api/anime/episodes/${encodeURIComponent(animeId)}`);
  return asArray(data.episodes).map((episode, index) => animeDexEpisodeRow({ ...episode, id: `${animeId}:${episode.epSlug || episode.number}` }, index));
}

function animeDexEpisodeRow(episode, index) {
  const number = episode.number || index + 1;
  return {
    id: episode.id || String(number),
    provider: "animedex",
    number,
    title: cleanHtml(episode.title || `Episode ${number}`),
    date: episode.airDate || "",
    duration: episode.duration || 0,
    image: episode.image || "",
    description: cleanHtml(episode.description || ""),
    audio: episode.audio || "sub",
  };
}

async function getAnimeDexStreams(episodeId) {
  const data = await postJson(`${ANIMEDEX_BASE_URL}/api/stream/sources`, { action: "sources", episodeId });
  const tracks = normalizeTrackList(data.subtitles);
  return {
    provider: "animedex",
    sources: asArray(data.sources).filter((source) => source?.url && (source.isHLS || String(source.url).includes(".m3u8"))).map((source, index) => ({
      name: `AnimeDex ${source.quality || index + 1}`,
      quality: source.quality || "auto",
      type: source.isHLS || String(source.url).includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
      url: proxyAnimeDexUrl(source.url),
      referer: source.referer || "",
      isHLS: Boolean(source.isHLS || String(source.url).includes(".m3u8")),
      tracks,
    })),
    tracks,
    intro: data.intro || null,
    outro: data.outro || null,
  };
}

async function proxyAnimeDexMedia(req, res) {
  const target = validateHttpUrl(req.query.url);
  if (!target || !isAllowedAnimeDexMediaUrl(target)) {
    res.status(400).json({ error: "valid AnimeDex media url is required" });
    return;
  }

  const response = await fetch(target, { headers: animeDexMediaHeaders(req) });
  if (!response.ok) {
    res.status(response.status).send(await response.text().catch(() => response.statusText));
    return;
  }

  const contentType = animeDexContentTypeForUrl(target, response.headers.get("content-type"));
  res.status(response.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", contentType);
  ["content-length", "content-range", "accept-ranges", "cache-control"].forEach((header) => {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  });

  if (target.includes(".m3u8") || contentType.includes("mpegurl")) {
    const text = await response.text();
    res.send(rewriteM3u8(text, target, proxyAnimeDexUrl));
    return;
  }

  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(res);
}

function animeDexMediaHeaders(req) {
  return {
    Accept: "*/*",
    Referer: "https://kwik.cx/",
    Origin: "https://kwik.cx",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniTrack/1.0",
    ...(req.headers.range ? { Range: req.headers.range } : {}),
  };
}

function proxyAnimeDexUrl(url) {
  return `/api/anime/animedex/proxy?url=${encodeURIComponent(url)}`;
}

function isAllowedAnimeDexMediaUrl(url) {
  try {
    const parsed = new URL(url);
    const allowedHosts = ["owocdn.top", "uwucdn.top"];
    return parsed.protocol === "https:" && allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch (error) {
    return false;
  }
}

function animeDexContentTypeForUrl(url, upstreamType = "") {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".jpg") || path.includes("/segment-")) return "video/mp2t";
  return upstreamType || contentTypeForUrl(url);
}

async function searchAniZone(title) {
  const html = await fetchTextCached(`${ANIZONE_BASE_URL}/anime?search=${encodeURIComponent(title)}`);
  const results = [];
  const seen = new Set();
  const linkRegex = /<a\b[^>]*href="(https:\/\/anizone\.to\/anime\/([a-z0-9-]+))"[^>]*title="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(html))) {
    const url = decodeXml(match[1]);
    const id = decodeXml(match[2]);
    if (seen.has(id)) continue;
    seen.add(id);
    const titleText = cleanHtml(match[3]);
    const nearby = html.slice(Math.max(0, match.index - 1200), Math.min(html.length, match.index + 1200));
    const image = firstMatch(nearby, /<img\b[^>]*src="([^"]+)"/i);
    results.push({
      provider: "anizone",
      id,
      title: titleText,
      url,
      image: absolutizeUrl(image, ANIZONE_BASE_URL),
      score: titleScore(title, titleText),
    });
  }
  return results.filter((item) => item.score >= 0.2).sort((a, b) => b.score - a.score);
}

async function getAniZoneEpisodes(animeId) {
  const slug = animeId.replace(/^anizone:/, "").replace(/[^a-z0-9-]/gi, "");
  const html = await fetchTextCached(`${ANIZONE_BASE_URL}/anime/${slug}`);
  const links = [];
  const seen = new Set();
  const linkRegex = new RegExp(`href="(https:\\/\\/anizone\\.to\\/anime\\/${escapeRegex(slug)}\\/(\\d+))"`, "gi");
  let match;
  while ((match = linkRegex.exec(html))) {
    const url = decodeXml(match[1]);
    const number = Number(match[2]);
    if (!number || seen.has(number)) continue;
    seen.add(number);
    links.push({
      id: url,
      provider: "anizone",
      number,
      title: `Episode ${number}`,
      date: "",
      url,
      description: "AniZone direct HLS episode.",
    });
  }
  return links.sort((a, b) => a.number - b.number);
}

async function getAniZoneStreams(episodeUrl) {
  const html = await fetchTextCached(episodeUrl, { headers: { Referer: ANIZONE_BASE_URL } });
  const streamUrl = firstMatch(html, /<media-player\b[^>]*\bsrc="([^"]+\.m3u8[^"]*)"/i);
  if (!streamUrl) {
    const error = new Error("AniZone stream URL not found");
    error.status = 404;
    throw error;
  }
  const tracks = [...html.matchAll(/<track\b[^>]*src=([^\s>]+)[^>]*label="([^"]+)"[^>]*srclang="([^"]+)"/gi)].map((match) => ({
    kind: "subtitles",
    label: cleanHtml(match[2]),
    srclang: match[3],
    url: proxyAniZoneUrl(decodeXml(match[1].replace(/^['"]|['"]$/g, ""))),
  }));
  return {
    provider: "anizone",
    sources: [{
      name: "AniZone HLS",
      quality: "auto",
      type: "application/vnd.apple.mpegurl",
      url: proxyAniZoneUrl(streamUrl),
      isHLS: true,
      tracks,
    }],
    tracks,
  };
}

async function proxyAniZoneMedia(req, res) {
  const target = validateHttpUrl(req.query.url);
  if (!target || !isAllowedAniZoneMediaUrl(target)) {
    res.status(400).json({ error: "valid AniZone media url is required" });
    return;
  }

  const response = await fetch(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniTrack/1.0",
      "Accept": "*/*",
      "Referer": `${ANIZONE_BASE_URL}/`,
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    },
  });
  if (!response.ok) {
    res.status(response.status).send(await response.text().catch(() => response.statusText));
    return;
  }

  const contentType = response.headers.get("content-type") || contentTypeForUrl(target);
  res.status(response.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", contentType);
  ["content-length", "content-range", "accept-ranges", "cache-control"].forEach((header) => {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  });

  if (target.includes(".m3u8") || contentType.includes("mpegurl")) {
    const text = await response.text();
    res.send(rewriteM3u8ForAniZone(text, target));
    return;
  }

  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(res);
}

function rewriteM3u8ForAniZone(text, manifestUrl) {
  return rewriteM3u8(text, manifestUrl, proxyAniZoneUrl);
}

function rewriteM3u8(text, manifestUrl, proxyUrl) {
  return String(text || "")
    .replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxyUrl(new URL(uri, manifestUrl).toString())}"`)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return proxyUrl(new URL(trimmed, manifestUrl).toString());
    })
    .join("\n");
}

function proxyAniZoneUrl(url) {
  return `/api/anime/anizone/proxy?url=${encodeURIComponent(url)}`;
}

function isAllowedAniZoneMediaUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname.endsWith(".xin-cdn.xyz") || parsed.hostname.endsWith(".vid-cdn.xyz"));
  } catch (error) {
    return false;
  }
}

function normalizeTrackList(tracks) {
  return asArray(tracks).filter((track) => track?.url || track?.file).map((track, index) => ({
    kind: track.kind || "subtitles",
    label: track.label || track.lang || track.srclang || `Subtitle ${index + 1}`,
    srclang: track.srclang || track.lang || "en",
    url: track.url || track.file,
  }));
}

function contentTypeForUrl(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".ts")) return "video/mp2t";
  if (path.endsWith(".m4s")) return "video/iso.segment";
  if (path.endsWith(".key")) return "application/octet-stream";
  if (path.endsWith(".vtt")) return "text/vtt";
  if (path.endsWith(".ass")) return "text/plain";
  return "application/octet-stream";
}

async function searchHstreamAdult(title) {
  const html = await fetchTextCached(`${HSTREAM_BASE_URL}/search?search=${encodeURIComponent(title)}`);
  const results = [];
  const seen = new Set();
  const pattern = /<a\s+class="[^"]*hover:text-blue-600[^"]*"\s+href="(https:\/\/hstream\.moe\/hentai\/[^"]+)"[\s\S]*?<img\s+alt="([^"]*)"[\s\S]*?src="([^"]*)"/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const url = decodeXml(match[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    const titleText = cleanHtml(match[2]);
    const score = titleScore(title, titleText);
    if (!titleText || score < 0.15) continue;
    const nearby = html.slice(Math.max(0, match.index - 400), Math.min(html.length, match.index + 1800));
    const quality = cleanHtml(firstMatch(nearby, /<p[^>]*bg-rose-700[^>]*>\s*([\s\S]*?)<\/p>/i));

    results.push({
      id: `hstream:${new URL(url).pathname}`,
      provider: "hstream",
      adult: true,
      title: titleText,
      url,
      image: absolutizeUrl(decodeXml(match[3]), HSTREAM_BASE_URL),
      quality,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

async function getHstreamAdultStreams(pageUrl) {
  const { html, cookie } = await fetchHstreamPageSession(pageUrl);
  const episodeId = firstMatch(html, /id="e_id"\s+type="hidden"\s+value="([^"]+)"/i) || firstMatch(html, /value="([^"]+)"\s+[^>]*id="e_id"/i);
  const token = firstMatch(html, /name="_token"\s+value="([^"]+)"/i) || firstMatch(html, /name="csrf-token"\s+content="([^"]+)"/i);
  if (!episodeId || !token) {
    const error = new Error("Could not read hstream player metadata");
    error.status = 502;
    throw error;
  }

  const data = await postHstreamPlayerApi(pageUrl, episodeId, token, cookie);
  const domains = asArray(data.stream_domains).filter(Boolean);
  const streamPath = hstreamStreamPath(data.stream_url);
  const firstDomain = domains[0] || "";
  const sources = [];
  const tracks = firstDomain && streamPath ? [{ kind: "subtitles", label: "English", srclang: "en", url: `${firstDomain}/${streamPath}/eng.vtt` }] : [];

  if (firstDomain && streamPath) {
    const hstreamSource = (name, quality, type, url) => ({ name, quality, type, url, tracks });
    sources.push(hstreamSource("hstream 720p MP4", "720p", "video/mp4", `${firstDomain}/${streamPath}/x264.720p.mp4`));
    sources.push(hstreamSource("hstream 720p DASH", "720p", "application/dash+xml", `${firstDomain}/${streamPath}/720/manifest.mpd`));
    sources.push(hstreamSource("hstream 1080p DASH", "1080p", "application/dash+xml", `${firstDomain}/${streamPath}/1080/manifest.mpd`));
    sources.push(hstreamSource("hstream 2160p DASH", "2160p", "application/dash+xml", `${firstDomain}/${streamPath}/2160/manifest.mpd`));
    if (Number(data.interpolated) === 1) sources.push(hstreamSource("hstream 1080p48 DASH", "1080p48", "application/dash+xml", `${firstDomain}/${streamPath}/1080i/manifest.mpd`));
    if (Number(data.interpolated_uhd) === 1) sources.push(hstreamSource("hstream 2160p48 DASH", "2160p48", "application/dash+xml", `${firstDomain}/${streamPath}/2160i/manifest.mpd`));
  }

  return {
    provider: "hstream",
    adult: true,
    title: cleanHtml(data.title || "hstream"),
    pageUrl,
    poster: absolutizeUrl(data.poster || "", HSTREAM_BASE_URL),
    domains,
    tracks,
    sources,
  };
}

async function fetchHstreamPageSession(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniTrack/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
    return { html: await response.text(), cookie: cookies.map((item) => item.split(";")[0]).join("; ") };
  } finally {
    clearTimeout(timeout);
  }
}

async function postHstreamPlayerApi(pageUrl, episodeId, token, cookie) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${HSTREAM_BASE_URL}/player/api`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniTrack/1.0",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": token,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": pageUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ episode_id: episodeId }),
    });
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      error.url = `${HSTREAM_BASE_URL}/player/api`;
      throw error;
    }
    return response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Upstream request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutError.name = "UpstreamTimeoutError";
      timeoutError.code = "UPSTREAM_TIMEOUT";
      timeoutError.status = 504;
      timeoutError.url = `${HSTREAM_BASE_URL}/player/api`;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function hstreamStreamPath(value) {
  return String(value || "").split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function stripHtml(value) {
  return decodeXml(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function titleScore(query, candidate) {
  const a = normalizeTitle(query);
  const b = normalizeTitle(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return 0.95;
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

async function searchMangaDexManga(title) {
  const data = await fetchJsonCached(`${MANGADEX_API_URL}/manga?${new URLSearchParams([
    ["title", title],
    ["limit", "10"],
    ["includes[]", "cover_art"],
    ["availableTranslatedLanguage[]", "en"],
    ["contentRating[]", "safe"],
    ["contentRating[]", "suggestive"],
    ["order[relevance]", "desc"],
  ]).toString()}`);
  return asArray(data.data).map(mapMangaDexManga);
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

  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

async function getAsuraChapters(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${ASURA_BASE_URL}${safePath}`);
  const chapters = [];
  const seen = new Set();
  const pattern = /<a\s+href="(\/comics\/[^"]+\/chapter\/([^"/]+))"[^>]*data-astro-prefetch="hover"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const chapterPath = decodeXml(match[1]);
    const number = decodeXml(match[2]);
    if (seen.has(chapterPath)) continue;
    seen.add(chapterPath);
    const block = match[3];
    const subtitle = cleanHtml(firstMatch(block, /<span\s+class="[^"]*block[^"]*"[^>]*>([\s\S]*?)<\/span>/i));
    const date = cleanHtml(firstMatch(block, /<div\s+class="[^"]*flex-shrink-0[^"]*"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)) || "Date TBA";

    chapters.push({
      id: `asura:${chapterPath}`,
      provider: "asura",
      number,
      title: subtitle ? `Chapter ${number}: ${subtitle}` : `Chapter ${number}`,
      date,
      description: subtitle || `Chapter ${number}`,
      pages: 1,
    });
  }

  if (!chapters.length) {
    const fallbackPattern = /href="(\/comics\/[^"]+\/chapter\/([^"/]+))"/gi;
    while ((match = fallbackPattern.exec(html))) {
      const chapterPath = decodeXml(match[1]);
      const number = decodeXml(match[2]);
      if (seen.has(chapterPath)) continue;
      seen.add(chapterPath);
      chapters.push({ id: `asura:${chapterPath}`, provider: "asura", number, title: `Chapter ${number}`, date: "Date TBA", description: `Chapter ${number}`, pages: 1 });
    }
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
  const pattern = /https:\/\/cdn\.asurascans\.com\/asura-images\/chapters(?:-restored)?\/[^"'\\<\s]+?\.(?:webp|jpg|jpeg|png|gif)/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const url = decodeXml(match[0]).replace(/&quot.*$/i, "");
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push(url);
  }

  return pages;
}

async function searchMangaKatanaManga(title) {
  const html = await fetchTextCached(`${MANGAKATANA_BASE_URL}/?search=${encodeURIComponent(title)}&search_by=m_name`);
  const results = [];
  const seen = new Set();
  const pattern = /<h3 class="title">[\s\S]*?<a href="(https:\/\/mangakatana\.com\/manga\/[^\"]+)"[^>]*>([\s\S]*?)<\/a>(?:<span>\s*-\s*Update chapter\s*([^<]+)<\/span>)?/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const url = new URL(decodeXml(match[1]));
    const path = url.pathname;
    if (seen.has(path)) continue;
    seen.add(path);

    const name = cleanHtml(match[2]);
    if (!name) continue;

    const nearby = html.slice(Math.max(0, match.index - 1200), Math.min(html.length, match.index + 2200));
    const cover = decodeXml(firstMatch(nearby, /<img\s+src="([^"]+)"/i));
    const description = cleanHtml(firstMatch(nearby, /<div class="summary[^"]*">([\s\S]*?)<\/div>/i));
    const latest = Number.parseFloat(cleanHtml(match[3] || "0"));

    results.push({
      id: `mangakatana:${path}`,
      provider: "mangakatana",
      title: name,
      description,
      status: cleanHtml(firstMatch(nearby, /<div class="status[^"]*">[\s\S]*?<\/i>\s*([^<]+)<\/div>/i)) || "unknown",
      year: "",
      cover,
      chapterCount: Number.isFinite(latest) ? latest : 0,
      score: titleScore(title, name),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

async function getMangaKatanaChapters(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${MANGAKATANA_BASE_URL}${safePath}`);
  const chapters = [];
  const seen = new Set();
  const pattern = /<a href="(https:\/\/mangakatana\.com\/manga\/[^\"]+\/c([^\"]+))"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,260}?<div class="update_time">([^<]*)<\/div>/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const url = new URL(decodeXml(match[1]));
    const chapterPath = url.pathname;
    if (seen.has(chapterPath)) continue;
    seen.add(chapterPath);

    const number = decodeXml(match[2]).replace(/^c/i, "");
    const title = cleanHtml(match[3]) || `Chapter ${number}`;
    chapters.push({
      id: `mangakatana:${chapterPath}`,
      provider: "mangakatana",
      number,
      title,
      date: cleanHtml(match[4]) || "Date TBA",
      description: title,
      pages: 1,
    });
  }

  return chapters.sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

async function getMangaKatanaPages(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${MANGAKATANA_BASE_URL}${safePath}`);
  const pages = [];
  const seen = new Set();
  const pattern = /https:\/\/i\d+\.mangakatana\.com\/token\/[^'"\s]+?\.(?:jpg|jpeg|png|webp)/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const url = decodeXml(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push(url);
  }

  return pages;
}

async function searchWeebCentralManga(title) {
  try {
    const html = await fetchTextCached(`${WEEBCENTRAL_BASE_URL}/search/data?${new URLSearchParams([
      ["text", title],
      ["display_mode", "Full Display"],
    ]).toString()}`, {
      headers: {
        "Accept": "text/html,*/*;q=0.8",
        "HX-Request": "true",
        "HX-Current-URL": `${WEEBCENTRAL_BASE_URL}/search?text=${encodeURIComponent(title)}`,
        "Referer": `${WEEBCENTRAL_BASE_URL}/search?text=${encodeURIComponent(title)}`,
      },
    });
    const results = parseWeebCentralSearchResults(html, title);
    if (results.length) return results;
  } catch (error) {
    console.warn(`WeebCentral search failed, trying sitemap fallback: ${error.status || error.message}`);
  }

  try {
    return await searchWeebCentralSitemap(title);
  } catch (error) {
    console.warn(`WeebCentral sitemap fallback failed: ${error.status || error.message}`);
    return [];
  }
}

function parseWeebCentralSearchResults(html, title) {
  const results = [];
  const seen = new Set();
  const blocks = String(html || "").split(/(?=<article\b[^>]*class="[^"]*bg-base-300)/i);

  for (const block of blocks) {
    const path = decodeXml(firstMatch(block, /href="(?:https:\/\/weebcentral\.com)?(\/series\/[^"]+)"/i));
    if (seen.has(path)) continue;
    seen.add(path);

    const name = cleanHtml(firstMatch(block, /alt="([^"]*?)\s+cover"/i)) || cleanHtml(firstMatch(block, /<a\s+href="(?:https:\/\/weebcentral\.com)?\/series\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i));
    if (!path || !name || titleScore(title, name) < 0.15) continue;

    results.push({
      id: `weebcentral:${path}`,
      provider: "weebcentral",
      title: name,
      description: cleanHtml(firstMatch(block, /<strong[^>]*>Tag\(s\):\s*<\/strong>([\s\S]*?)<\/div>/i)),
      status: cleanHtml(firstMatch(block, /<strong>Status:<\/strong>\s*<span>([^<]*)<\/span>/i)) || "unknown",
      year: cleanHtml(firstMatch(block, /<strong>Year:<\/strong>\s*<span>([^<]*)<\/span>/i)),
      cover: decodeXml(firstMatch(block, /<img\s+src="([^"]*)"/i)),
      chapterCount: 0,
      score: titleScore(title, name),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

async function searchWeebCentralSitemap(title) {
  const xml = await fetchTextCached(`${WEEBCENTRAL_BASE_URL}/sitemap.xml`);
  const results = [];
  const seen = new Set();
  const pattern = /<loc>https:\/\/weebcentral\.com(\/series\/[^<]+)<\/loc>/gi;
  let match;

  while ((match = pattern.exec(xml))) {
    const path = decodeXml(match[1]);
    if (seen.has(path)) continue;
    const slug = decodeURIComponent(path.split("/").pop() || "").replace(/[-_]+/g, " ");
    const score = titleScore(title, slug);
    if (score < 0.65) continue;
    seen.add(path);
    results.push({
      id: `weebcentral:${path}`,
      provider: "weebcentral",
      title: cleanHtml(slug),
      description: "",
      status: "unknown",
      year: "",
      cover: "",
      chapterCount: 0,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

async function getWeebCentralChapters(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  try {
    return await getWeebCentralChaptersFromRss(safePath);
  } catch (error) {
    console.warn(`WeebCentral RSS chapters failed, trying series page: ${error.status || error.message}`);
  }

  const html = await fetchTextCached(`${WEEBCENTRAL_BASE_URL}${safePath}`);
  const chapters = [];
  const seen = new Set();
  const pattern = /<a\s+href="https:\/\/weebcentral\.com(\/chapters\/[^"]+)"\s+class="[^"]*hover:bg-base-300[^"]*"[\s\S]*?<span\s+class="">\s*([^<]+?)\s*<\/span>[\s\S]*?<time[^>]*datetime="([^"]+)"/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const chapterPath = decodeXml(match[1]);
    if (seen.has(chapterPath)) continue;
    seen.add(chapterPath);

    const title = cleanHtml(match[2]);
    const number = firstMatch(title, /(?:Chapter|Ch\.?|Episode)\s*([\d.]+)/i) || firstMatch(title, /([\d.]+)/) || String(chapters.length + 1);
    const date = cleanHtml(match[3]) || "Date TBA";

    chapters.push({
      id: `weebcentral:${chapterPath}`,
      provider: "weebcentral",
      number,
      title: title || `Chapter ${number}`,
      date: date !== "Date TBA" ? new Date(date).toLocaleDateString("en-US") : date,
      description: title || `Chapter ${number}`,
      pages: 1,
    });
  }

  const firstChapterPath = chapters[chapters.length - 1]?.id?.replace(/^weebcentral:/, "") || firstMatch(html, /href="https:\/\/weebcentral\.com(\/chapters\/[^"]+)"/i);
  const firstChapterId = firstMatch(firstChapterPath, /\/chapters\/([^/]+)/i);
  if (firstChapterId) {
    const seriesBasePath = firstMatch(safePath, /^(\/series\/[^/]+)/i) || safePath.replace(/\/$/, "");
    const selectHtml = await fetchTextCached(`${WEEBCENTRAL_BASE_URL}${seriesBasePath}/chapter-select?current_chapter=${encodeURIComponent(firstChapterId)}`);
    const selectedTitle = cleanHtml(firstMatch(selectHtml, /<button\s+id="selected_chapter"[^>]*>([\s\S]*?)<\/button>/i));
    const selected = selectedTitle ? [{ path: firstChapterPath, title: selectedTitle }] : [];
    const selectorChapters = selected;
    const selectorSeen = new Set(selected.map((item) => item.path));
    const selectorPattern = /<a\s+href="https:\/\/weebcentral\.com(\/chapters\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let selectorMatch;

    while ((selectorMatch = selectorPattern.exec(selectHtml))) {
      const chapterPath = decodeXml(selectorMatch[1]);
      if (selectorSeen.has(chapterPath)) continue;
      selectorSeen.add(chapterPath);
      selectorChapters.push({ path: chapterPath, title: cleanHtml(selectorMatch[2]) });
    }

    if (selectorChapters.length > chapters.length) {
      return selectorChapters.map((chapter, index) => {
        const number = firstMatch(chapter.title, /(?:Chapter|Ch\.?|Episode)\s*([\d.]+)/i) || firstMatch(chapter.title, /([\d.]+)/) || String(index + 1);
        return {
          id: `weebcentral:${chapter.path}`,
          provider: "weebcentral",
          number,
          title: chapter.title || `Chapter ${number}`,
          date: "Date TBA",
          description: chapter.title || `Chapter ${number}`,
          pages: 1,
        };
      }).filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
    }
  }

  return chapters
    .filter((chapter) => chapter.number !== "0")
    .sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

async function getWeebCentralChaptersFromRss(seriesPath) {
  const seriesId = firstMatch(seriesPath, /^\/series\/([^/]+)/i);
  if (!seriesId) return [];

  const rss = await fetchTextCached(`${WEEBCENTRAL_BASE_URL}/series/${encodeURIComponent(seriesId)}/rss`, {
    headers: { Accept: "application/rss+xml,application/xml,text/xml,*/*" },
  });
  const firstChapterPath = firstMatch(rss, /<link>https:\/\/weebcentral\.com(\/chapters\/[^<]+)<\/link>/i);
  const firstChapterId = firstMatch(firstChapterPath, /\/chapters\/([^/]+)/i);
  if (!firstChapterId) return parseWeebCentralRssChapters(rss);

  const selectHtml = await fetchTextCached(`${WEEBCENTRAL_BASE_URL}/series/${encodeURIComponent(seriesId)}/chapter-select?current_chapter=${encodeURIComponent(firstChapterId)}`, {
    headers: {
      "HX-Request": "true",
      "HX-Current-URL": `${WEEBCENTRAL_BASE_URL}${seriesPath}`,
      "Referer": `${WEEBCENTRAL_BASE_URL}${seriesPath}`,
    },
  });
  const selectedTitle = cleanHtml(firstMatch(selectHtml, /<button\s+id="selected_chapter"[^>]*>([\s\S]*?)<\/button>/i));
  const chapters = selectedTitle ? [{ path: firstChapterPath, title: selectedTitle }] : [];
  const seen = new Set(chapters.map((chapter) => chapter.path));
  const pattern = /<a\s+href="https:\/\/weebcentral\.com(\/chapters\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(selectHtml))) {
    const chapterPath = decodeXml(match[1]);
    if (seen.has(chapterPath)) continue;
    seen.add(chapterPath);
    chapters.push({ path: chapterPath, title: cleanHtml(match[2]) });
  }

  if (!chapters.length) return parseWeebCentralRssChapters(rss);

  return chapters.map((chapter, index) => {
    const number = firstMatch(chapter.title, /(?:Chapter|Ch\.?|Episode|#)\s*([\d.]+)/i) || firstMatch(chapter.title, /([\d.]+)/) || String(index + 1);
    return {
      id: `weebcentral:${chapter.path}`,
      provider: "weebcentral",
      number,
      title: chapter.title || `Chapter ${number}`,
      date: "Date TBA",
      description: chapter.title || `Chapter ${number}`,
      pages: 1,
    };
  }).filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

function parseWeebCentralRssChapters(rss) {
  const chapters = [];
  const pattern = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>https:\/\/weebcentral\.com(\/chapters\/[^<]+)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/gi;
  let match;

  while ((match = pattern.exec(rss))) {
    const title = cleanHtml(match[1]);
    const number = firstMatch(title, /(?:Chapter|Ch\.?|Episode|#)\s*([\d.]+)/i) || firstMatch(title, /([\d.]+)/) || String(chapters.length + 1);
    chapters.push({
      id: `weebcentral:${decodeXml(match[2])}`,
      provider: "weebcentral",
      number,
      title: title || `Chapter ${number}`,
      date: cleanHtml(match[3]) ? new Date(cleanHtml(match[3])).toLocaleDateString("en-US") : "Date TBA",
      description: title || `Chapter ${number}`,
      pages: 1,
    });
  }

  return chapters.filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

async function getWeebCentralPages(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const chapterUrl = `${WEEBCENTRAL_BASE_URL}${safePath}`;
  const html = await fetchTextCached(`${chapterUrl}/images?is_prev=False&current_page=1&reading_style=long_strip`, {
    headers: {
      "HX-Request": "true",
      "HX-Current-URL": chapterUrl,
      "Referer": chapterUrl,
    },
  });
  const pages = [];
  const seen = new Set();
  const pattern = /https:\/\/[^"'\\<\s]+?\.(?:webp|jpg|jpeg|png|gif)/gi;
  let match;

  while ((match = pattern.exec(html))) {
    const url = decodeXml(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push(url);
  }

  return pages;
}

async function searchFlameComicsManga(title) {
  const html = await fetchTextCached(`${FLAMECOMICS_BASE_URL}/browse`, { headers: flameComicsHeaders("/browse") });
  const data = parseNextData(html);
  const entries = collectObjects(data).filter((item) => item && item.series_id && item.title);
  const seen = new Set();
  const results = [];

  for (const item of entries) {
    const id = String(item.series_id);
    const name = cleanHtml(item.title);
    if (!id || !name || seen.has(id) || titleScore(title, name) < 0.2) continue;
    seen.add(id);
    results.push({
      id: `flamecomics:/series/${id}`,
      provider: "flamecomics",
      title: name,
      description: cleanHtml(item.description || asArray(item.altTitles).join(", ")),
      status: cleanHtml(item.status || "unknown"),
      year: "",
      cover: flameComicsCoverUrl(id, item.thumbnail || item.cover || item.thumbnail_url || ""),
      chapterCount: Number(item.chapter_count || item.chapterCount || 0),
      score: titleScore(title, name),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

function flameComicsCoverUrl(seriesId, cover) {
  const file = cleanHtml(cover || "");
  if (!file) return "";
  if (/^https?:\/\//i.test(file)) return file;
  return `${FLAMECOMICS_CDN_URL}/uploads/images/series/${seriesId}/${file.replace(/^\/+/, "")}`;
}

async function getFlameComicsChapters(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${FLAMECOMICS_BASE_URL}${safePath}`, { headers: flameComicsHeaders(safePath) });
  const data = parseNextData(html);
  const entries = collectObjects(data).filter((item) => item && (item.chapter_id || item.slug || item.hash || item.token) && (item.title || item.chapter || item.number));
  const seriesPath = firstMatch(safePath, /^\/series\/[^/]+/i) || safePath.replace(/\/$/, "");
  const chapters = [];
  const seen = new Set();

  for (const item of entries) {
    const slug = cleanHtml(item.slug || item.hash || item.token || item.chapter_id || "");
    const rawPath = cleanHtml(item.path || item.url || "");
    const chapterPath = rawPath.startsWith("/series/") ? rawPath : slug ? `${seriesPath}/${slug}` : "";
    if (!chapterPath || seen.has(chapterPath) || /thumbnail|cover\./i.test(chapterPath)) continue;
    seen.add(chapterPath);
    const number = cleanChapterNumber(item.chapter || item.number || "") || firstMatch(`${item.title || ""} ${chapterPath}`, /(?:chapter|ch\.?|-)[^\d]*([\d.]+)/i) || String(chapters.length + 1);
    const title = cleanHtml(item.title || "") || `Chapter ${number}`;
    const timestamp = Number(item.release_date || item.edit_time || item.created_at || item.updated_at || 0);

    chapters.push({
      id: `flamecomics:${chapterPath}`,
      provider: "flamecomics",
      number,
      title,
      date: timestamp ? new Date(timestamp * 1000).toLocaleDateString("en-US") : "Date TBA",
      description: title,
      pages: 1,
    });
  }

  if (chapters.length) {
    return chapters.filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
  }

  const htmlPattern = new RegExp(`href="(${escapeRegex(seriesPath)}\/[^"#?]+)"`, "gi");
  let htmlMatch;
  while ((htmlMatch = htmlPattern.exec(html))) {
    const chapterPath = decodeXml(htmlMatch[1]);
    if (seen.has(chapterPath) || /thumbnail|cover\.|\.(?:webp|jpg|jpeg|png|gif)$/i.test(chapterPath)) continue;
    seen.add(chapterPath);
    const nearby = html.slice(Math.max(0, htmlMatch.index - 900), Math.min(html.length, htmlMatch.index + 1200));
    const title = cleanHtml(firstMatch(nearby, /"title":"([^"]+)"/i) || firstMatch(nearby, /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i));
    const number = firstMatch(`${title} ${chapterPath}`, /(?:chapter|ch\.?|AGS-|-)\s*([\d.]+)/i) || firstMatch(`${title} ${chapterPath}`, /([\d.]+)/) || String(chapters.length + 1);
    chapters.push({ id: `flamecomics:${chapterPath}`, provider: "flamecomics", number, title: title || `Chapter ${number}`, date: "Date TBA", description: title || `Chapter ${number}`, pages: 1 });
  }

  if (chapters.length) {
    return chapters.filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
  }

  for (const item of entries) {
    const slug = cleanHtml(item.slug || item.hash || item.chapter_id || "");
    const rawPath = cleanHtml(item.path || item.url || "");
    const chapterPath = rawPath.startsWith("/series/") ? rawPath : slug ? `${seriesPath}/${slug}` : "";
    if (!chapterPath || seen.has(chapterPath) || /thumbnail|cover\./i.test(chapterPath)) continue;
    seen.add(chapterPath);
    const title = cleanHtml(item.title || item.name || "");
    const number = firstMatch(`${item.chapter || item.number || ""} ${title} ${chapterPath}`, /(?:chapter|ch\.?|AGS-|-)\s*([\d.]+)/i) || firstMatch(`${item.chapter || item.number || ""} ${title}`, /([\d.]+)/) || String(chapters.length + 1);

    chapters.push({
      id: `flamecomics:${chapterPath}`,
      provider: "flamecomics",
      number,
      title: title || `Chapter ${number}`,
      date: item.created_at || item.updated_at ? new Date(item.created_at || item.updated_at).toLocaleDateString("en-US") : "Date TBA",
      description: title || `Chapter ${number}`,
      pages: 1,
    });
  }

  if (!chapters.length) {
    const pattern = new RegExp(`href="(${escapeRegex(seriesPath)}\/[^"#?]+)"`, "gi");
    let match;
    while ((match = pattern.exec(html))) {
      const chapterPath = decodeXml(match[1]);
      if (seen.has(chapterPath) || /thumbnail|cover\./i.test(chapterPath)) continue;
      seen.add(chapterPath);
      const nearby = html.slice(Math.max(0, match.index - 600), Math.min(html.length, match.index + 900));
      const title = cleanHtml(firstMatch(nearby, /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i));
      const number = firstMatch(`${title} ${chapterPath}`, /(?:chapter|ch\.?|AGS-|-)\s*([\d.]+)/i) || firstMatch(`${title} ${chapterPath}`, /([\d.]+)/) || String(chapters.length + 1);
      chapters.push({ id: `flamecomics:${chapterPath}`, provider: "flamecomics", number, title: title || `Chapter ${number}`, date: "Date TBA", description: title || `Chapter ${number}`, pages: 1 });
    }
  }

  return chapters.filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

function cleanChapterNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? String(number) : "";
}

async function getFlameComicsPages(path) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${FLAMECOMICS_BASE_URL}${safePath}`, { headers: flameComicsHeaders(safePath) });
  return uniqueMatches(html, /https:\/\/cdn\.flamecomics\.xyz\/uploads\/images\/series\/[^"'\\<\s]+?\.(?:webp|jpg|jpeg|png|gif)(?:\?\d+)?/gi)
    .filter((url) => !/\/thumbnail\.|\/cover\./i.test(url));
}

function flameComicsHeaders(path = "/") {
  const url = `${FLAMECOMICS_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  return {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Referer": `${FLAMECOMICS_BASE_URL}/browse`,
    "Origin": FLAMECOMICS_BASE_URL,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "X-Current-URL": url,
  };
}

async function searchRizzComicManga(title) {
  return searchWordPressManga({
    title,
    baseUrl: RIZZCOMIC_BASE_URL,
    provider: "rizzcomic",
    prefix: "rizzcomic",
    searchPath: `/?s=${encodeURIComponent(title)}`,
    seriesPattern: /href="(https:\/\/rizzcomic\.com\/manga\/[^"#?]+\/?)"[^>]*>([\s\S]*?)<\/a>/gi,
  });
}

async function getRizzComicChapters(path) {
  return getWordPressChapters({ path, baseUrl: RIZZCOMIC_BASE_URL, provider: "rizzcomic", prefix: "rizzcomic", chapterPattern: /href="(https:\/\/rizzcomic\.com\/[^"#?]+chapter[^"#?]+\/?)"[^>]*>([\s\S]*?)<\/a>/gi });
}

async function getRizzComicPages(path) {
  return getWordPressPages({ path, baseUrl: RIZZCOMIC_BASE_URL, imagePattern: /https:\/\/(?:phitoria\.com\/series\/data|[^"'\\<\s]*rizzcomic\.com\/wp-content\/uploads)\/[^"'\\<\s]+?\.(?:webp|jpg|jpeg|png|gif)/gi });
}

async function searchToonilyManga(title) {
  return searchWordPressManga({
    title,
    baseUrl: TOONILY_BASE_URL,
    provider: "toonily",
    prefix: "toonily",
    searchPath: `/?s=${encodeURIComponent(title)}&post_type=wp-manga`,
    seriesPattern: /href="(https:\/\/toonily\.com\/serie\/[^"#?]+\/?)"[^>]*>([\s\S]*?)<\/a>/gi,
  });
}

async function getToonilyChapters(path) {
  return getWordPressChapters({ path, baseUrl: TOONILY_BASE_URL, provider: "toonily", prefix: "toonily", chapterPattern: /data-redirect="(https:\/\/toonily\.com\/serie\/[^"#?]+\/(?:chapter|side-story)-[^"#?]+\/?)"[\s\S]*?<\/div>/gi });
}

async function getToonilyPages(path) {
  return getWordPressPages({ path, baseUrl: TOONILY_BASE_URL, imagePattern: /https:\/\/(?:static\.tnlycdn\.com|toonily\.com\/wp-content\/uploads)\/[^"'\\<\s]+?\.(?:webp|jpg|jpeg|png|gif)/gi });
}

async function searchWordPressManga({ title, baseUrl, provider, prefix, searchPath, seriesPattern }) {
  const html = await fetchTextCached(`${baseUrl}${searchPath}`);
  const results = [];
  const seen = new Set();
  let match;

  while ((match = seriesPattern.exec(html))) {
    const url = new URL(decodeXml(match[1]));
    const path = url.pathname;
    if (seen.has(path)) continue;
    seen.add(path);

    const nearby = html.slice(Math.max(0, match.index - 1200), Math.min(html.length, match.index + 2200));
    const name = cleanHtml(firstMatch(match[0], /title="([^"]+)"/i)) || cleanHtml(firstMatch(nearby, /title="([^"]+)"/i)) || cleanHtml(firstMatch(nearby, /alt="([^"]+)"/i)) || cleanHtml(match[2]);
    if (!name || titleScore(title, name) < 0.15) continue;
    const cover = decodeXml(firstMatch(nearby, /<img[^>]+(?:data-src|src)="([^"]+)"/i));

    results.push({
      id: `${prefix}:${path}`,
      provider,
      title: name,
      description: cleanHtml(firstMatch(nearby, /<div[^>]+class="[^"]*(?:summary|excerpt|desc)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)),
      status: cleanHtml(firstMatch(nearby, /(?:Status|status)[\s\S]{0,120}?<[^>]+>([^<]+)<\/[^>]+>/i)) || "unknown",
      year: "",
      cover: absolutizeUrl(cover, baseUrl),
      chapterCount: 0,
      score: titleScore(title, name),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function getWordPressChapters({ path, baseUrl, provider, prefix, chapterPattern }) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${baseUrl}${safePath}`);
  const chapters = [];
  const seen = new Set();
  let match;

  while ((match = chapterPattern.exec(html))) {
    const url = new URL(decodeXml(match[1]));
    const chapterPath = url.pathname;
    if (seen.has(chapterPath)) continue;
    seen.add(chapterPath);

    const block = match[0];
    const title = cleanHtml(match[2] || block) || cleanHtml(firstMatch(block, /title="([^"]+)"/i));
    const number = firstMatch(`${title} ${chapterPath}`, /(?:chapter|ch\.?)\s*([\d.]+)/i) || firstMatch(`${title} ${chapterPath}`, /side-story-([\d.]+)/i) || firstMatch(`${title} ${chapterPath}`, /([\d.]+)/) || String(chapters.length + 1);
    const date = cleanHtml(firstMatch(block, /<time[^>]*>([\s\S]*?)<\/time>/i) || firstMatch(block, /class="[^"]*(?:date|time)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)) || "Date TBA";

    chapters.push({
      id: `${prefix}:${chapterPath}`,
      provider,
      number,
      title: title || `Chapter ${number}`,
      date,
      description: title || `Chapter ${number}`,
      pages: 1,
    });
  }

  return chapters.filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

async function getWordPressPages({ path, baseUrl, imagePattern }) {
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const html = await fetchTextCached(`${baseUrl}${safePath}`, { headers: { "Referer": `${baseUrl}${safePath}` } });
  return uniqueMatches(html, imagePattern)
    .map((url) => absolutizeUrl(url, baseUrl))
    .filter((url) => !/logo|favicon|cropped|thumbnail|cover|avatar|banner|wp-content\/themes|wp-content\/plugins/i.test(url));
}

async function searchPornhwaZ(title) {
  const direct = await directAdultSeriesMatch({ provider: "pornhwaz", title, baseUrl: PORNHWAZ_BASE_URL, path: `/webtoon/${slugifyTitle(title)}/` });
  const html = await fetchTextCached(`${PORNHWAZ_BASE_URL}/?s=${encodeURIComponent(title).replace(/%20/g, "+")}&post_type=wp-manga`);
  const results = parseAdultSeriesMatches({
    html,
    title,
    provider: "pornhwaz",
    baseUrl: PORNHWAZ_BASE_URL,
    pattern: /<a\b[^>]*href="(https:\/\/www\.pornhwaz\.com\/webtoon\/[^"#?]+\/?)[^>]*"[^>]*(?:title="([^"]+)")?[^>]*>([\s\S]*?)<\/a>/gi,
    pathPattern: /^\/webtoon\/[^/?#]+\/?$/i,
  });
  return mergeAdultResults(direct ? [direct] : [], results);
}

async function searchHentai20(title) {
  const direct = await directAdultSeriesMatch({ provider: "hentai20", title, baseUrl: HENTAI20_BASE_URL, path: `/manga/${slugifyTitle(title)}/` });
  const html = await fetchTextCached(`${HENTAI20_BASE_URL}/?s=${encodeURIComponent(title).replace(/%20/g, "+")}&post_type=wp-manga`);
  const results = [];
  const seen = new Set();
  const pattern = /<div class="bsx">([\s\S]*?)(?=<div class="bsx">|<\/main>|<\/body>)/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const block = match[1];
    const path = normalizeAdultPath(firstMatch(block, /<a\b[^>]*href="(https:\/\/hentai20\.io\/manga\/[^"#?]+\/?)[^>]*"/i), HENTAI20_BASE_URL, /^\/manga\/[^/?#]+\/?$/i);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = cleanHtml(firstMatch(block, /title="([^"]+)"/i) || firstMatch(block, /<div class="tt">([\s\S]*?)<\/div>/i));
    const score = titleScore(title, name);
    if (!name || score < 0.15) continue;
    const cover = firstMatch(block, /<img\b[^>]*src="([^"]+)"/i);
    results.push(adultSourceResult({ provider: "hentai20", path, title: name, cover: absolutizeUrl(cover, HENTAI20_BASE_URL), score }));
  }
  return mergeAdultResults(direct ? [direct] : [], results);
}

async function searchPornhwaPro(title) {
  const direct = await directAdultSeriesMatch({ provider: "pornhwapro", title, baseUrl: PORNHWAPRO_BASE_URL, paths: slugifyTitleVariants(title).map((slug) => `/manhwa/${slug}/`) });
  let html = await fetchTextCached(`${PORNHWAPRO_BASE_URL}/search/${encodeURIComponent(title).replace(/%20/g, "-")}/`);
  let results = parsePornhwaProSearch(html, title);
  if (!results.length && title.includes(" ")) {
    html = await fetchTextCached(`${PORNHWAPRO_BASE_URL}/search/${encodeURIComponent(title.split(/\s+/)[0])}/`);
    results = parsePornhwaProSearch(html, title);
  }
  return mergeAdultResults(direct ? [direct] : [], results);
}

function parsePornhwaProSearch(html, title) {
  const results = [];
  const seen = new Set();
  const pattern = /<div class="overflow-hidden rounded-lg[\s\S]*?(?=<div class="overflow-hidden rounded-lg|<\/main>|<\/body>)/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const block = match[0];
    const path = normalizeAdultPath(firstMatch(block, /<a\b[^>]*href="(\/manhwa\/[^"#?]+\/)"/i), PORNHWAPRO_BASE_URL, /^\/manhwa\/[^/?#]+\/?$/i);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = cleanHtml(firstMatch(block, /<img\b[^>]*alt="([^"]+)"/i) || firstMatch(block, /<!--t=[^>]*-->([\s\S]*?)<!---->/i));
    const score = titleScore(title, name);
    if (!name || score < 0.15) continue;
    const cover = firstMatch(block, /(?:data-src|src)="(https?:[^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    results.push(adultSourceResult({ provider: "pornhwapro", path, title: name, cover: absolutizeUrl(cover, PORNHWAPRO_BASE_URL), score }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function searchHentai18(title) {
  const direct = await directAdultSeriesMatch({ provider: "hentai18", title, baseUrl: HENTAI18_BASE_URL, path: `/read-hentai/${slugifyTitle(title)}` });
  const html = await fetchTextCached(`${HENTAI18_BASE_URL}/search?s=${encodeURIComponent(title).replace(/%20/g, "+")}`);
  const results = [];
  const seen = new Set();
  const pattern = /<li>[\s\S]*?(?=<li>|<\/ul>)/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const block = match[0];
    const path = normalizeAdultPath(firstMatch(block, /<h3 class="title">\s*<a\b[^>]*href="(https:\/\/hentai18\.net\/read-hentai\/[^"#?]+)"/i), HENTAI18_BASE_URL, /^\/read-hentai\/[^/?#]+$/i);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = cleanHtml(firstMatch(block, /<h3 class="title">\s*<a\b[^>]*>[\s\S]*?([^<>]+)<\/a>/i));
    const score = titleScore(title, name);
    if (!name || score < 0.15) continue;
    const cover = firstMatch(block, /data-original="([^"]+)"/i) || firstMatch(block, /<img\b[^>]*src="([^"]+)"/i);
    results.push(adultSourceResult({ provider: "hentai18", path, title: name, cover: absolutizeUrl(cover, HENTAI18_BASE_URL), score }));
  }
  return mergeAdultResults(direct ? [direct] : [], results);
}

async function searchHentaiName(title) {
  const html = await fetchTextCached(`${HENTAINAME_BASE_URL}/search/${encodeURIComponent(slugifyTitle(title))}/`, { headers: simpleUserAgentHeaders({ Referer: HENTAINAME_BASE_URL }) });
  return parseAdultGallerySearch({ html, title, provider: "hentainame", baseUrl: HENTAINAME_BASE_URL, pathPattern: /^\/g\/\d+\/?$/i });
}

async function searchHentaiZap(title, page = 1) {
  const html = await fetchTextCached(`${HENTAIZAP_BASE_URL}/search/?key=${encodeURIComponent(title)}&page=${pageNumber(page)}`, { headers: { Referer: HENTAIZAP_BASE_URL } });
  return parseAdultGallerySearch({ html, title, provider: "hentaizap", baseUrl: HENTAIZAP_BASE_URL, pathPattern: /^\/gallery\/\d+\/?$/i });
}

async function searchHentaiFox(title, page = 1) {
  const html = await fetchTextCached(`${HENTAIFOX_BASE_URL}/search/?q=${encodeURIComponent(title)}&page=${pageNumber(page)}`, { headers: { Referer: HENTAIFOX_BASE_URL } });
  return parseAdultGallerySearch({ html, title, provider: "hentaifox", baseUrl: HENTAIFOX_BASE_URL, pathPattern: /^\/gallery\/\d+\/?$/i });
}

async function latestHentaiZap(page = 1) {
  const html = await fetchTextCached(`${HENTAIZAP_BASE_URL}/search/?lt=1&d=1&en=1&page=${pageNumber(page)}`, { headers: { Referer: HENTAIZAP_BASE_URL } });
  return parseAdultGallerySearch({ html, title: "", provider: "hentaizap", baseUrl: HENTAIZAP_BASE_URL, pathPattern: /^\/gallery\/\d+\/?$/i });
}

async function latestHentaiFox(page = 1) {
  const html = await fetchTextCached(pageNumber(page) > 1 ? `${HENTAIFOX_BASE_URL}/?page=${pageNumber(page)}` : HENTAIFOX_BASE_URL, { headers: { Referer: HENTAIFOX_BASE_URL } });
  return parseAdultGallerySearch({ html, title: "", provider: "hentaifox", baseUrl: HENTAIFOX_BASE_URL, pathPattern: /^\/gallery\/\d+\/?$/i });
}

async function search3Hentai(title, page = 1) {
  const html = await fetchTextCached(`${THREEHENTAI_BASE_URL}/search?q=${encodeURIComponent(`${title} language:english`)}&page=${pageNumber(page)}`, { headers: { Referer: THREEHENTAI_BASE_URL } });
  return parse3HentaiSearch(html, title);
}

async function latest3Hentai(page = 1) {
  const html = await fetchTextCached(`${THREEHENTAI_BASE_URL}/search?q=language%3Aenglish&page=${pageNumber(page)}`, { headers: { Referer: THREEHENTAI_BASE_URL } });
  return parse3HentaiSearch(html, "");
}

async function searchHentaiEra(title, page = 1) {
  const html = await fetchTextCached(`${HENTAIERA_BASE_URL}/search/?key=${encodeURIComponent(title)}&mg=1&dj=1&ws=1&is=1&ac=1&gc=1&en=1&jp=0&es=0&fr=0&kr=0&de=0&ru=0&lt=1&page=${pageNumber(page)}`, { headers: { Referer: HENTAIERA_BASE_URL } });
  return parseHentaiEraSearch(html, title);
}

async function latestHentaiEra(page = 1) {
  const html = await fetchTextCached(`${HENTAIERA_BASE_URL}/search/?mg=1&dj=1&ws=1&is=1&ac=1&gc=1&en=1&jp=0&es=0&fr=0&kr=0&de=0&ru=0&lt=1&page=${pageNumber(page)}`, { headers: { Referer: HENTAIERA_BASE_URL } });
  return parseHentaiEraSearch(html, "");
}

async function searchHentaiCity(title) {
  const html = await fetchTextCached(`${HENTAICITY_BASE_URL}/customsearch.php?view=search&search_type=gallery&search=${encodeURIComponent(title)}&main_cat=0`, { headers: { Referer: HENTAICITY_BASE_URL } });
  return parseHentaiCitySearch(html, title);
}

async function latestHentaiCity() {
  const html = await fetchTextCached(`${HENTAICITY_BASE_URL}/galleries/`, { headers: { Referer: HENTAICITY_BASE_URL } });
  return parseHentaiCitySearch(html, "");
}

async function searchManyDoujinQueries(provider, queries, page) {
  const searches = await Promise.allSettled(queries.map((query) => {
    if (provider === "hentaizap") return searchHentaiZap(query, page);
    if (provider === "hentaifox") return searchHentaiFox(query, page);
    if (provider === "3hentai") return search3Hentai(query, page);
    if (provider === "hentaiera") return searchHentaiEra(query, page);
    return [];
  }));
  return uniqueAdultResults(searches.flatMap((result) => result.status === "fulfilled" ? result.value : []), 42);
}

function uniqueAdultResults(results, limit = 42) {
  const byId = new Map();
  for (const result of results) {
    if (!result?.id) continue;
    const current = byId.get(result.id);
    if (!current || Number(result.score || 0) > Number(current.score || 0)) byId.set(result.id, result);
  }
  return [...byId.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, limit);
}

function doujinSearchQueries(title, providers) {
  const hasDoujinProvider = ["hentaizap", "hentaifox", "3hentai", "hentaiera", "hentaicity"].some((provider) => providers.has(provider));
  if (!hasDoujinProvider) return [title];
  const terms = String(title || "").split(/[\s,]+/).map((term) => term.trim()).filter((term) => term.length > 1);
  return terms.length > 1 ? uniqueStrings([title, ...terms]) : [title];
}

async function getAdultMangaChapters(provider, id) {
  if (provider === "pornhwaz") return getPornhwaZChapters(id);
  if (provider === "hentai20") return getAdultChapters(id, HENTAI20_BASE_URL, "hentai20", /^\/manga\/[^/?#]+\/?$/i, /href="(https:\/\/hentai20\.io\/[^"#?{}]+chapter-[^"#?{}]+\/)"[^>]*>([\s\S]*?)<\/a>/gi);
  if (provider === "pornhwapro") return getAdultChapters(id, PORNHWAPRO_BASE_URL, "pornhwapro", /^\/manhwa\/[^/?#]+\/?$/i, /href="(\/manhwa\/[^"#?]+\/chapter-[^"#?]+\/)"[^>]*>([\s\S]*?)<\/a>/gi);
  if (provider === "hentai18") return getHentai18Chapters(id);
  if (provider === "3hentai") return get3HentaiChapters(id);
  if (provider === "hentainame" || provider === "hentaizap" || provider === "hentaifox" || provider === "hentaiera" || provider === "hentaicity") return getAdultGalleryChapters(provider, id);
  return [];
}

async function getAdultMangaPages(provider, id) {
  if (provider === "pornhwaz") return getAdultPages(id, PORNHWAZ_BASE_URL, /https:\/\/cdn\.pornhwaz\.com\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png)(?:\?[^"'<>\s]*)?/gi);
  if (provider === "hentai20") return getAdultPages(id, HENTAI20_BASE_URL, /https:\/\/img\.hentai1\.io\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png)(?:\?[^"'<>\s]*)?/gi);
  if (provider === "pornhwapro") return getAdultPages(id, PORNHWAPRO_BASE_URL, /https:\/\/[^"'<>\s]*manhwature\.com\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png)(?:\?[^"'<>\s]*)?/gi);
  if (provider === "hentai18") return getAdultPages(id, HENTAI18_BASE_URL, /https:\/\/cdn\.hentai18\.net\/images\/manga\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png)(?:\?[^"'<>\s]*)?/gi);
  if (provider === "3hentai") return get3HentaiPages(id);
  if (provider === "hentainame" || provider === "hentaizap" || provider === "hentaifox" || provider === "hentaiera" || provider === "hentaicity") return getAdultGalleryPages(provider, id);
  return [];
}

async function getAdultChapters(id, baseUrl, provider, seriesPattern, chapterPattern) {
  const path = normalizeAdultPath(id, baseUrl, seriesPattern);
  if (!path) return [];
  const html = await fetchTextCached(`${baseUrl}${path}`, { headers: { Referer: baseUrl } });
  return adultChapterLinksFromHtml(html, provider, baseUrl, chapterPattern);
}

async function getPornhwaZChapters(id) {
  const path = normalizeAdultPath(id, PORNHWAZ_BASE_URL, /^\/webtoon\/[^/?#]+\/?$/i);
  if (!path) return [];
  const html = await fetchTextCached(`${PORNHWAZ_BASE_URL}${path}ajax/chapters/?t=1`, { method: "POST", headers: { Referer: `${PORNHWAZ_BASE_URL}${path}`, "X-Requested-With": "XMLHttpRequest" } });
  return adultChapterLinksFromHtml(html, "pornhwaz", PORNHWAZ_BASE_URL, /href="(https?:\/\/[^"#?]+\/[^"#?]+\/chapter-[^"#?]+\/?|\/[^"#?]+\/chapter-[^"#?]+\/)"[^>]*>([\s\S]*?)<\/a>/gi);
}

async function getHentai18Chapters(id) {
  const path = normalizeAdultPath(id, HENTAI18_BASE_URL, /^\/read-hentai\/[^/?#]+$/i);
  if (!path) return [];
  const html = await fetchTextCached(`${HENTAI18_BASE_URL}${path}`, { headers: { Referer: HENTAI18_BASE_URL } });
  const chapters = adultChapterLinksFromHtml(html, "hentai18", HENTAI18_BASE_URL, /href="(\/read-hentai\/[^"#?]+chapter-[^"#?]+)"[^>]*title="([^"]+)"/gi);
  if (chapters.length) return chapters;
  const urls = uniqueMatches(html, /https:\/\/hentai18\.net\/read-hentai\/[^"'<>\s]+?chapter-[^"'<>\s]+/gi);
  return urls.map((url, index) => {
    const chapterPath = normalizeAdultPath(url, HENTAI18_BASE_URL, /^\/read-hentai\/[^/?#]+$/i);
    const number = firstMatch(chapterPath, /chapter-([\d.]+)/i) || String(index + 1);
    return { id: `hentai18:${chapterPath}`, provider: "hentai18", number, title: `Chapter ${number}`, date: "Date TBA", description: `Chapter ${number}`, pages: 1 };
  }).filter((chapter) => chapter.id !== "hentai18:").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

async function getAdultGalleryChapters(provider, id) {
  const baseUrl = adultGalleryBaseUrl(provider);
  const path = normalizeAdultPath(id, baseUrl, adultGalleryPathPattern(provider));
  if (!path) return [];
  const html = await fetchTextCached(`${baseUrl}${path}`, { headers: provider === "hentainame" ? simpleUserAgentHeaders({ Referer: baseUrl }) : { Referer: baseUrl } });
  const title = cleanHtml(firstMatch(html, /<meta\b[^>]*(?:property|name)="og:title"[^>]*content="([^"]+)"/i) || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) || provider;
  const pages = (await adultGalleryPageImages(provider, html, baseUrl, path)).length || 1;
  return [{ id: `${provider}:${path}`, provider, number: "1", title, date: "Date TBA", description: title, pages }];
}

async function get3HentaiChapters(id) {
  const { path } = parse3HentaiId(id);
  if (!path) return [];
  return [{ id: `3hentai:${id}`, provider: "3hentai", number: "1", title: "Gallery", date: "Date TBA", description: "Gallery", pages: 1 }];
}

async function getAdultGalleryPages(provider, id) {
  const baseUrl = adultGalleryBaseUrl(provider);
  const path = normalizeAdultPath(id, baseUrl, adultGalleryPathPattern(provider));
  if (!path) return [];
  const html = await fetchTextCached(`${baseUrl}${path}`, { headers: provider === "hentainame" ? simpleUserAgentHeaders({ Referer: baseUrl }) : { Referer: baseUrl } });
  return adultGalleryPageImages(provider, html, baseUrl, path);
}

async function get3HentaiPages(id) {
  const { path, imageBase } = parse3HentaiId(id);
  if (imageBase) return probeSequentialImages(imageBase, "jpg");
  const html = await fetchTextCached(`${THREEHENTAI_BASE_URL}${path}`, { headers: { Referer: THREEHENTAI_BASE_URL } });
  return adultGalleryPageImages("3hentai", html, THREEHENTAI_BASE_URL, path);
}

async function getAdultPages(id, baseUrl, imagePattern) {
  const path = normalizeAdultPath(id, baseUrl, /^\//i);
  if (!path) return [];
  const html = await fetchTextCached(`${baseUrl}${path}`, { headers: { Referer: `${baseUrl}${path}` } });
  return uniqueMatches(html, imagePattern).filter((url) => !/logo|favicon|avatar|banner|discord|cursor|thumbs|\/resize\//i.test(url));
}

function parseAdultSeriesMatches({ html, title, provider, baseUrl, pattern, pathPattern }) {
  const results = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(html))) {
    const path = normalizeAdultPath(match[1], baseUrl, pathPattern);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const nearby = html.slice(Math.max(0, match.index - 450), Math.min(html.length, match.index + 900));
    const name = cleanHtml(match[2] || firstMatch(nearby, /<h3[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i) || match[3]);
    const score = titleScore(title, name);
    if (!name || score < 0.15) continue;
    const cover = firstMatch(nearby, /(?:data-src|src)="([^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    results.push(adultSourceResult({ provider, path, title: name, cover: absolutizeUrl(cover, baseUrl), score }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

function parseAdultGallerySearch({ html, title, provider, baseUrl, pathPattern }) {
  const results = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href="([^"]*(?:\/g\/\d+\/|\/gallery\/\d+\/)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const path = normalizeAdultPath(match[1], baseUrl, pathPattern);
    if (!path) continue;
    const nearby = html.slice(Math.max(0, match.index - 800), Math.min(html.length, match.index + 1400));
    const name = cleanHtml(firstMatch(match[2], /alt="([^"]+)"/i) || match[2] || firstMatch(nearby, /<h2[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i) || firstMatch(nearby, /<div class="caption">([\s\S]*?)<\/div>/i));
    if (!isEnglishAdultGalleryBlock(provider, `${nearby} ${match[2]}`, name)) continue;
    const score = Math.max(0.2, titleScore(title, name));
    if (!name || seen.has(path)) continue;
    seen.add(path);
    const cover = firstMatch(nearby, /(?:data-src|src)="([^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    results.push(adultSourceResult({ provider, path, title: name, cover: absolutizeUrl(cover, baseUrl), score }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

function parse3HentaiSearch(html, title) {
  const results = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href="([^"]*\/d\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const block = match[0];
    const path = normalizeAdultPath(match[1], THREEHENTAI_BASE_URL, /^\/d\/\d+$/i);
    const cover = firstMatch(block, /(?:data-src|src)="([^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    const imageBase = firstMatch(cover, /(https:\/\/s\d+\.3hentai\.(?:net|xyz)\/d\d+)\//i);
    const idPath = imageBase ? `${path}|${imageBase}` : path;
    if (!path || seen.has(idPath)) continue;
    const name = cleanHtml(firstMatch(block, /<div\b[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || firstMatch(block, /alt="([^"]+)"/i));
    if (!name || !isEnglishAdultGalleryBlock("3hentai", block, name)) continue;
    seen.add(idPath);
    results.push(adultSourceResult({ provider: "3hentai", path: idPath, title: name, cover: absolutizeUrl(cover, THREEHENTAI_BASE_URL), score: Math.max(0.2, titleScore(title, name)) }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

function parse3HentaiId(id) {
  const [rawPath, rawImageBase] = String(id || "").split("|");
  const path = normalizeAdultPath(rawPath, THREEHENTAI_BASE_URL, /^\/d\/\d+$/i);
  const imageBase = /^https:\/\/s\d+\.3hentai\.(?:net|xyz)\/d\d+$/i.test(rawImageBase || "") ? rawImageBase : "";
  return { path, imageBase };
}

async function probeSequentialImages(imageBase, extension) {
  const pages = [];
  for (let start = 1; start <= 300; start += 20) {
    const batch = await Promise.all([...Array(20)].map((_, index) => imageExists(`${imageBase}/${start + index}.${extension}`)));
    for (let index = 0; index < batch.length; index += 1) {
      const url = `${imageBase}/${start + index}.${extension}`;
      if (!batch[index]) return pages;
      pages.push(url);
    }
  }
  return pages;
}

async function imageExists(url) {
  try {
    const response = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0 AniTrack/1.0" } });
    return response.ok && /^image\//i.test(response.headers.get("content-type") || "");
  } catch (error) {
    return false;
  }
}

function parseHentaiEraSearch(html, title) {
  const results = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href="([^"]*\/gallery\/\d+\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const block = match[0];
    const path = normalizeAdultPath(match[1], HENTAIERA_BASE_URL, /^\/gallery\/\d+\/?$/i);
    if (!path || seen.has(path)) continue;
    const name = cleanHtml(firstMatch(block, /alt="([^"]+)"/i) || match[2]);
    if (!name || !isEnglishAdultGalleryBlock("hentaiera", block, name)) continue;
    seen.add(path);
    const cover = firstMatch(block, /(?:data-src|src)="([^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    results.push(adultSourceResult({ provider: "hentaiera", path, title: name, cover: absolutizeUrl(cover, HENTAIERA_BASE_URL), score: Math.max(0.2, titleScore(title, name)) }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

function parseHentaiCitySearch(html, title) {
  const results = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href="([^"]*(?:\/click\/\d+-\d+)?\/gallery\/[^"?#]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const block = match[0];
    const path = normalizeAdultPath(match[1], HENTAICITY_BASE_URL, /^\/(?:click\/\d+-\d+\/)?gallery\/[^/?#]+\.html$/i);
    if (!path || seen.has(path)) continue;
    const name = cleanHtml(firstMatch(block, /alt="([^"]+)"/i) || firstMatch(block, /title="([^"]+)"/i) || match[2]);
    if (!name) continue;
    seen.add(path);
    const cover = firstMatch(block, /(?:data-src|src)="([^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    results.push(adultSourceResult({ provider: "hentaicity", path, title: name, cover: absolutizeUrl(cover, HENTAICITY_BASE_URL), score: Math.max(0.2, titleScore(title, name)) }));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 42);
}

function adultGalleryBaseUrl(provider) {
  return ({ hentainame: HENTAINAME_BASE_URL, hentaizap: HENTAIZAP_BASE_URL, hentaifox: HENTAIFOX_BASE_URL, "3hentai": THREEHENTAI_BASE_URL, hentaiera: HENTAIERA_BASE_URL, hentaicity: HENTAICITY_BASE_URL }[provider] || "");
}

function adultGalleryPathPattern(provider) {
  if (provider === "3hentai") return /^\/d\/\d+$/i;
  if (provider === "hentaicity") return /^\/(?:click\/\d+-\d+\/)?gallery\/[^/?#]+\.html$/i;
  return provider === "hentainame" ? /^\/g\/\d+\/?$/i : /^\/gallery\/\d+\/?$/i;
}

async function adultGalleryPageImages(provider, html, baseUrl = "", path = "") {
  if (provider === "hentainame") {
    return sortAdultPageImages(uniqueMatches(html, /https:\/\/pics\.hentai\.name\/[^"'<>\s]+?\/\d+_thumb\.webp/gi).map((url) => url.replace(/_thumb\.webp(?:\?[^?]*)?$/i, ".webp")));
  }
  if (provider === "hentaizap") {
    const candidates = uniqueMatches(html, /https:\/\/m\d+\.hentaizap\.com\/[^"'<>\s]+?\/\d+t\.jpg/gi);
    const pages = await Promise.all(candidates.map((url) => hentaizapFullImage(url)));
    return sortAdultPageImages(pages.filter(Boolean));
  }
  if (provider === "hentaifox") {
    const galleryId = firstMatch(path, /\/gallery\/(\d+)\/?/i);
    const pageCount = Number(firstMatch(html, /id="load_pages"\s+value="(\d+)"/i) || firstMatch(html, /Pages:\s*(\d+)/i));
    if (galleryId && pageCount > 10) return hentaifoxReaderImages(baseUrl, galleryId, pageCount);
    const extension = await hentaifoxImageExtension(baseUrl, path);
    return sortAdultPageImages(uniqueMatches(html, /https:\/\/i\d*\.hentaifox\.com\/[^"'<>\s]+?\/\d+t\.jpg/gi).map((url) => url.replace(/(\d+)t\.jpg(?:\?[^?]*)?$/i, `$1.${extension}`)));
  }
  if (provider === "3hentai") {
    return sortAdultPageImages(uniqueMatches(html, /https:\/\/s\d+\.3hentai\.(?:net|xyz)\/d\d+\/\d+t\.jpg/gi).map((url) => url.replace(/(\d+)t\.jpg(?:\?[^?]*)?$/i, "$1.jpg")));
  }
  if (provider === "hentaiera") {
    const galleryId = firstMatch(path, /\/gallery\/(\d+)\/?/i);
    const pageCount = Number(firstMatch(html, /id="load_pages"\s+value="(\d+)"/i) || firstMatch(html, /Pages:\s*(\d+)/i));
    if (galleryId && pageCount > 12) return hentaieraReaderImages(baseUrl, galleryId, pageCount);
    return sortAdultPageImages(uniqueMatches(html, /https:\/\/m\d+\.hentaiera\.com\/[^"'<>\s]+?\/\d+t\.jpg/gi).map((url) => url.replace(/(\d+)t\.jpg(?:\?[^?]*)?$/i, "$1.webp")));
  }
  if (provider === "hentaicity") {
    return uniqueStrings(uniqueMatches(html, /https:\/\/cdn\d+\.images\.hentaicity\.com\/galleries\/[^"'<>\s]+?-t\.jpg/gi).map((url) => url.replace(/-t\.jpg(?:\?[^?]*)?$/i, ".jpg")));
  }
  return [];
}

async function hentaizapFullImage(thumbUrl) {
  const base = thumbUrl.replace(/(\d+)t\.jpg(?:\?[^?]*)?$/i, "$1");
  for (const extension of ["webp", "jpg", "png"]) {
    const url = `${base}.${extension}`;
    if (await imageExists(url)) return url;
  }
  return "";
}

async function hentaifoxImageExtension(baseUrl, galleryPath) {
  const galleryId = firstMatch(galleryPath, /\/gallery\/(\d+)\/?/i);
  if (!baseUrl || !galleryId) return "jpg";
  try {
    const html = await fetchTextCached(`${baseUrl}/g/${galleryId}/1/`, { headers: { Referer: baseUrl } });
    return firstMatch(html, /https:\/\/i\d*\.hentaifox\.com\/[^"'<>\s]+?\/1\.(webp|jpg|jpeg|png)/i) || "jpg";
  } catch (error) {
    return "jpg";
  }
}

async function hentaifoxReaderImages(baseUrl, galleryId, pageCount) {
  const pages = [];
  const total = Math.min(300, Math.max(1, Number(pageCount || 0)));
  for (let start = 1; start <= total; start += 12) {
    const batch = await Promise.all([...Array(Math.min(12, total - start + 1))].map((_, index) => hentaifoxReaderImage(baseUrl, galleryId, start + index)));
    pages.push(...batch.filter(Boolean));
  }
  return sortAdultPageImages(pages);
}

async function hentaifoxReaderImage(baseUrl, galleryId, pageNumber) {
  try {
    const html = await fetchTextCached(`${baseUrl}/g/${galleryId}/${pageNumber}/`, { headers: { Referer: baseUrl } });
    return html.match(new RegExp(`https://i\\d*\\.hentaifox\\.com/[^"'<>\\s]+?/${pageNumber}\\.(?:webp|jpg|jpeg|png)`, "i"))?.[0] || "";
  } catch (error) {
    return "";
  }
}

async function hentaieraReaderImages(baseUrl, galleryId, pageCount) {
  const pages = [];
  const total = Math.min(300, Math.max(1, Number(pageCount || 0)));
  for (let start = 1; start <= total; start += 12) {
    const batch = await Promise.all([...Array(Math.min(12, total - start + 1))].map((_, index) => hentaieraReaderImage(baseUrl, galleryId, start + index)));
    pages.push(...batch.filter(Boolean));
  }
  return sortAdultPageImages(pages);
}

async function hentaieraReaderImage(baseUrl, galleryId, pageNumber) {
  try {
    const html = await fetchTextCached(`${baseUrl}/view/${galleryId}/${pageNumber}/`, { headers: { Referer: baseUrl } });
    return html.match(new RegExp(`https://m\\d+\\.hentaiera\\.com/[^"'<>\\s]+?/${pageNumber}\\.(?:webp|jpg|jpeg|png)`, "i"))?.[0] || "";
  } catch (error) {
    return "";
  }
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function loadUsers() {
  try {
    return JSON.parse(readFileSync(ACCOUNT_DATA_FILE, "utf8")) || {};
  } catch (error) {
    return {};
  }
}

function saveUsers(users) {
  mkdirSync(dirname(ACCOUNT_DATA_FILE), { recursive: true });
  writeFileSync(ACCOUNT_DATA_FILE, JSON.stringify(users, null, 2));
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
  const left = Buffer.from(candidate);
  const right = Buffer.from(hash);
  return left.length === right.length && timingSafeEqual(left, right);
}

function accountResponse(user) {
  return { username: user.username, token: accountToken(user.username), data: user.data || {}, updatedAt: user.updatedAt || 0 };
}

function accountToken(username) {
  const expires = Date.now() + 1000 * 60 * 60 * 24 * 90;
  const payload = `${username}.${expires}`;
  const signature = createHmac("sha256", ACCOUNT_SECRET).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

function requireAccount(req, includeUsers = false) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const decoded = token ? Buffer.from(token, "base64url").toString("utf8") : "";
  const [username, expires, signature] = decoded.split(".");
  const payload = `${username}.${expires}`;
  const expected = createHmac("sha256", ACCOUNT_SECRET).update(payload).digest("base64url");
  if (!username || Number(expires) < Date.now() || signature !== expected) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
  const users = loadUsers();
  if (!users[username]) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
  return includeUsers ? { users, username } : users[username];
}

function sanitizeAccountData(data) {
  const input = data && typeof data === "object" ? data : {};
  return {
    library: input.library && typeof input.library === "object" ? input.library : {},
    settings: input.settings && typeof input.settings === "object" ? input.settings : {},
    theme: String(input.theme || "").slice(0, 20),
    readerMode: String(input.readerMode || "").slice(0, 40),
    updatedAt: Number(input.updatedAt || Date.now()),
  };
}

function sortAdultPageImages(urls) {
  return uniqueStrings(urls).sort((a, b) => adultPageNumberFromUrl(a) - adultPageNumberFromUrl(b));
}

function adultPageNumberFromUrl(url) {
  return Number(firstMatch(url, /\/(\d+)(?:_thumb|t)?\.(?:webp|jpg|jpeg|png)/i)) || 0;
}

function isEnglishAdultGalleryBlock(provider, html, title) {
  const text = `${html || ""} ${title || ""}`;
  if (provider === "hentainame") return /\[\s*english\s*\]/i.test(title || "");
  if (provider === "hentaizap") return /\/language\/english\/|fl_en|flag-gb|fl_gb|\[\s*english\s*\]|data-languages="[^"]*\b3\b/i.test(text);
  if (provider === "hentaifox") return /\/language\/english\/|flag-gb|fl_gb|\[\s*english\s*\]|data-languages="[^"]*\b2\b/i.test(text);
  if (provider === "3hentai") return /flag-eng|\[\s*english\s*\]|language:\s*english/i.test(text);
  if (provider === "hentaiera") return /\[\s*english\s*\]|flag-us|\ben\b/i.test(text);
  return true;
}

function simpleUserAgentHeaders(headers = {}) {
  return { "User-Agent": "Mozilla/5.0 AniTrack/1.0", ...headers };
}

async function directAdultSeriesMatch({ provider, title, baseUrl, path, paths }) {
  for (const candidatePath of uniqueStrings([path, ...(paths || [])])) {
    if (!candidatePath || /\/\//.test(candidatePath)) continue;
    let html = "";
    try {
      html = await fetchTextCached(`${baseUrl}${candidatePath}`, { headers: { Referer: baseUrl } });
    } catch (error) {
      continue;
    }
    if (!html || /<h1>\s*404 Not Found\s*<\/h1>/i.test(html)) continue;
    const rawTitle = cleanHtml(firstMatch(html, /<meta\b[^>]*(?:property|name)="og:title"[^>]*content="([^"]+)"/i) || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
    const name = titleScore(title, rawTitle) >= 0.6 ? rawTitle : title;
    const cover = firstMatch(html, /<meta\b[^>]*(?:property|name)="og:image"[^>]*content="([^"]+)"/i) || firstMatch(html, /(?:data-src|src)="([^"]+\.(?:webp|jpg|jpeg|png)[^"]*)"/i);
    return adultSourceResult({ provider, path: candidatePath, title: name, cover: absolutizeUrl(cover, baseUrl), score: Math.max(0.95, titleScore(title, name)) });
  }
  return null;
}

function adultChapterLinksFromHtml(html, provider, baseUrl, pattern) {
  const chapters = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(html))) {
    const path = normalizeAdultPath(decodeXml(match[1]), baseUrl, /^\//i);
    if (!path || seen.has(path) || path.includes("{{")) continue;
    seen.add(path);
    const block = html.slice(Math.max(0, match.index - 300), Math.min(html.length, match.index + 700));
    const title = cleanHtml(match[2] || firstMatch(block, /title="([^"]+)"/i));
    const number = firstMatch(`${title} ${path}`, /chapter[-\s]*([\d.]+)/i) || firstMatch(`${title} ${path}`, /ch\.\s*([\d.]+)/i) || String(chapters.length + 1);
    const date = cleanHtml(firstMatch(block, /<span[^>]*class="[^"]*(?:date|post-on|time)[^"]*"[^>]*>([\s\S]*?)<\/span>/i)) || "Date TBA";
    chapters.push({ id: `${provider}:${path}`, provider, number, title: title || `Chapter ${number}`, date, description: title || `Chapter ${number}`, pages: 1 });
  }
  return chapters.filter((chapter) => chapter.number !== "0").sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

function adultSourceResult({ provider, path, title, cover, score }) {
  return { id: `${provider}:${path}`, provider, title, description: "Adult manga/manhwa source.", status: "unknown", year: "", cover, chapterCount: 0, score };
}

function mergeAdultResults(preferred, results) {
  const byId = new Map();
  [...preferred, ...results].forEach((result) => {
    if (!result?.id) return;
    const current = byId.get(result.id);
    if (current && current.score >= result.score) return;
    byId.set(result.id, result);
  });
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}

function normalizeAdultPath(value, baseUrl, pattern) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(decodeXml(raw), baseUrl);
    const path = url.pathname.replace(/\/+$/, "") + (url.pathname.endsWith("/") ? "/" : "");
    return pattern.test(path) ? path : "";
  } catch (error) {
    return "";
  }
}

function slugifyTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function slugifyTitleVariants(value) {
  const text = String(value || "");
  return uniqueStrings([slugifyTitle(text), slugifyTitle(text.replace(/['’]/g, ""))]).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function adultMangaProviderFromId(value) {
  const provider = String(value || "").split(":")[0];
  return ["pornhwaz", "hentai20", "pornhwapro", "hentai18", "hentainame", "hentaizap", "hentaifox", "3hentai", "hentaiera", "hentaicity"].includes(provider) ? provider : "";
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

function parseNextData(html) {
  const raw = firstMatch(html, /<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/i);
  if (!raw) return {};
  try {
    return JSON.parse(decodeXml(raw));
  } catch (error) {
    return {};
  }
}

function collectObjects(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (!Array.isArray(value)) output.push(value);
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") collectObjects(item, output, seen);
  }
  return output;
}

function uniqueMatches(value, pattern) {
  const results = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(String(value || "")))) {
    const url = decodeXml(match[0]).replace(/\\u002F/g, "/");
    if (seen.has(url)) continue;
    seen.add(url);
    results.push(url);
  }
  return results;
}

function absolutizeUrl(value, baseUrl) {
  const url = decodeXml(String(value || "")).trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch (error) {
    return url;
  }
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
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

async function fetchJsonCached(url, options = {}) {
  const text = await fetchTextCached(url, options);
  return text ? JSON.parse(text) : {};
}

async function postJson(url, body, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniTrack/1.0",
        "Accept": "application/json,text/plain,*/*",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      error.url = url;
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Upstream request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutError.name = "UpstreamTimeoutError";
      timeoutError.code = "UPSTREAM_TIMEOUT";
      timeoutError.status = 504;
      timeoutError.url = url;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextCached(url, options = {}) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniTrack/1.0",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.headers || {}),
      },
    });
    if (response.status === 404 && options.emptyOn404) return "";
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      error.url = url;
      throw error;
    }
    const value = await response.text();
    cache.set(url, { value, time: Date.now() });
    return value;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`Upstream request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutError.name = "UpstreamTimeoutError";
      timeoutError.code = "UPSTREAM_TIMEOUT";
      timeoutError.status = 504;
      timeoutError.url = url;
      throw timeoutError;
    }
    throw error;
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

function pageNumber(value) {
  const number = Number(value || 1);
  return Math.max(1, Number.isFinite(number) ? Math.floor(number) : 1);
}

function providerSet(value) {
  const allowed = new Set(["mangadex", "asura", "mangakatana", "weebcentral", "flamecomics", "rizzcomic", "toonily", "pornhwaz", "hentai20", "pornhwapro", "hentai18", "hentainame", "hentaizap", "hentaifox", "3hentai", "hentaiera", "hentaicity"]);
  const selected = String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => allowed.has(item));
  return new Set(selected.length ? selected : allowed);
}

function parseLimit(value, fallback) {
  const limit = Number(value || fallback);
  return Math.min(2000, Math.max(1, Number.isFinite(limit) ? limit : fallback));
}
