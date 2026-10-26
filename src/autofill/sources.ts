// 多源自动补全：iTunes 补歌曲信息/封面，AMLL 补逐字 TTML，LRCLIB 补行级 LRC。
// 三个源都是公开 API 且允许跨域直连（Access-Control-Allow-Origin: *），所以不需要自建后端。
// 本模块只负责取回文本 / Blob，解析与舞台更新交给 App —— 这样这里不引 AMLL 的 ESM 包，
// 自检才能跟其它模块一样在 Node 的 CommonJS 下跑。
// 这里不 import ../lyric/load：那会把 AMLL（ESM-only）拉进自检的编译依赖，
// 而自动补全只会产出 lrc / ttml 两种格式，本地声明就够了。
export type FetchedLyricFormat = "lrc" | "ttml";

const ITUNES_SEARCH = "https://itunes.apple.com/search";
const LRCLIB_API = "https://lrclib.net/api";
const AMLL_INDEX_URL =
  "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/metadata/raw-lyrics-index.jsonl";
const AMLL_RAW_BASE =
  "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/raw-lyrics/";
// 浏览器改不了 User-Agent；LRCLIB 的白名单里接受 X-User-Agent，带上它换更高的限流额度
const LRCLIB_HEADERS: Record<string, string> = {
  "X-User-Agent": "Ritsu (+https://github.com/uwuAitry/Ritsu)",
};
const TIMEOUT_MS = 12_000;

// iTunes 的 artworkUrl100 只是尺寸段，换成 600x600 拿大图（同一 CDN）
const ARTWORK_FROM = "100x100bb";
const ARTWORK_TO = "600x600bb";

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function getText(url: string): Promise<string | null> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  return await res.text();
}

async function getBlob(url: string): Promise<Blob | null> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  return await res.blob();
}

// 跨源比对用的归一化键：小写，去掉空格与所有标点（保留字母数字与 CJK）。
// 各源的标题/歌手写法差异极大，只有在这种形态下才能比。
export function matchKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// ── iTunes：歌曲信息 + 封面 ────────────────────────────────

type ItunesTrack = {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
};

// 从搜索结果里挑最可能是同一首的：标题必须吻合（完全相同或互相包含），
// 歌手吻合再加分。全都不吻合就返回 null，宁可不填也不填错。
export function pickItunesTrack(
  candidates: ItunesTrack[],
  title: string,
  artist: string,
): ItunesTrack | null {
  const wantTitle = matchKey(title);
  if (!wantTitle) return null;
  const wantArtist = matchKey(artist);
  let best: ItunesTrack | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const gotTitle = matchKey(c.trackName ?? "");
    if (!gotTitle) continue;
    const titleHit = gotTitle === wantTitle ? 2 : gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle) ? 1 : 0;
    if (titleHit === 0) continue;
    const gotArtist = matchKey(c.artistName ?? "");
    const artistHit =
      wantArtist && gotArtist
        ? gotArtist === wantArtist
          ? 2
          : gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist)
            ? 1
            : 0
        : 0;
    const score = titleHit * 2 + artistHit * 3;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

async function searchItunes(title: string, artist: string): Promise<ItunesTrack | null> {
  const term = [artist, title].filter(Boolean).join(" ");
  if (!term) return null;
  const params = new URLSearchParams({ term, entity: "song", limit: "10" });
  const data = await getJson<{ results?: ItunesTrack[] }>(`${ITUNES_SEARCH}?${params.toString()}`);
  return pickItunesTrack(Array.isArray(data.results) ? data.results : [], title, artist);
}

// ── AMLL TTML DB：逐字歌词（主源） ─────────────────────────

export type AmllEntry = { musicName: string; artists: string[]; file: string };

const ARTIST_SPLIT = /[,，/&、;；]+/;

// 索引每行长这样（metadata 是 [键, 字符串数组] 对的数组，不是对象）：
// {"metadata":[["musicName",["Idol"]],["artists",["YOASOBI"]]],"rawLyricFile":"....ttml"}
export function parseAmllLine(line: string): AmllEntry | null {
  let raw: { metadata?: unknown; rawLyricFile?: unknown };
  try {
    raw = JSON.parse(line) as { metadata?: unknown; rawLyricFile?: unknown };
  } catch {
    return null;
  }
  const file = typeof raw.rawLyricFile === "string" ? raw.rawLyricFile : "";
  if (!file || !Array.isArray(raw.metadata)) return null;
  let musicName = "";
  const artists: string[] = [];
  for (const pair of raw.metadata as unknown[]) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
    const values = Array.isArray(pair[1])
      ? (pair[1] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    if (pair[0] === "musicName" && values.length > 0) musicName = values[0];
    if (pair[0] === "artists") {
      for (const value of values) {
        for (const part of value.split(ARTIST_SPLIT)) {
          const name = part.trim();
          if (name) artists.push(name);
        }
      }
    }
  }
  if (!musicName) return null;
  return { musicName, artists, file };
}

// ponytail: 索引 1.64MB，只在内存里缓存一次；刷新页面重拉。
// 若要跨会话缓存再上 IndexedDB（sessionStorage 配额不一定撑得住）。
let amllIndex: AmllEntry[] | null = null;

export async function loadAmllIndex(): Promise<AmllEntry[]> {
  if (amllIndex) return amllIndex;
  const res = await fetchWithTimeout(AMLL_INDEX_URL);
  if (!res.ok) throw new Error(`AMLL 索引拉取失败：HTTP ${res.status}`);
  const text = await res.text();
  const entries: AmllEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseAmllLine(line);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) throw new Error("AMLL 索引为空");
  amllIndex = entries;
  return entries;
}

async function findAmllTtml(title: string, artist: string): Promise<string | null> {
  const index = await loadAmllIndex();
  const wantTitle = matchKey(title);
  if (!wantTitle) return null;
  const wantArtist = matchKey(artist);
  const titleHit = (e: AmllEntry): boolean => matchKey(e.musicName) === wantTitle;
  // 先要求歌手也吻合；不中再放宽到只认标题（索引里 artists 的写法很不统一）
  const hit =
    (wantArtist ? index.find((e) => titleHit(e) && e.artists.some((x) => matchKey(x) === wantArtist)) : undefined) ??
    index.find(titleHit);
  if (!hit) return null;
  return await getText(`${AMLL_RAW_BASE}${encodeURIComponent(hit.file)}`);
}

// ── LRCLIB：行级歌词（TTML 没有时的退路） ───────────────────

type LrclibRecord = {
  trackName?: string;
  artistName?: string;
  instrumental?: boolean;
  syncedLyrics?: string | null;
};

function usableLrc(rec: LrclibRecord | undefined | null): string | null {
  if (!rec || rec.instrumental) return null;
  const text = rec.syncedLyrics;
  return typeof text === "string" && text.trim() ? text : null;
}

async function getLrclibLyrics(
  title: string,
  artist: string,
  album: string,
  durationSec: number,
): Promise<string | null> {
  // 精确查询：duration 只在其存在时传，否则 LRCLIB 会因 ±2 秒不匹配回 404
  if (artist && durationSec > 0) {
    const params = new URLSearchParams({
      track_name: title,
      artist_name: artist,
      duration: String(Math.round(durationSec)),
    });
    if (album) params.set("album_name", album);
    try {
      const rec = await getJson<LrclibRecord>(`${LRCLIB_API}/get?${params.toString()}`, {
        headers: LRCLIB_HEADERS,
      });
      const text = usableLrc(rec);
      if (text) return text;
    } catch {
      // 404 / 偶发 503 都落到模糊搜索，不在这里打断流程
    }
  }

  const query = [artist, title].filter(Boolean).join(" ");
  if (!query) return null;
  try {
    const list = await getJson<LrclibRecord[]>(
      `${LRCLIB_API}/search?${new URLSearchParams({ q: query }).toString()}`,
      { headers: LRCLIB_HEADERS },
    );
    if (!Array.isArray(list)) return null;
    const wantTitle = matchKey(title);
    // 搜索不做排序保证，自己挑：标题必须对上，优先歌手也对上的
    const wantArtist = matchKey(artist);
    const hits = list.filter((r) => matchKey(r.trackName ?? "") === wantTitle);
    const preferred = wantArtist ? hits.find((r) => matchKey(r.artistName ?? "") === wantArtist) : undefined;
    return usableLrc(preferred ?? hits.find((r) => usableLrc(r)));
  } catch {
    return null;
  }
}

// ── 对外：一次补全 ─────────────────────────────────────────

export type AutoFillQuery = { title: string; artist: string; durationMs?: number };

export type AutoFillResult = {
  meta: { title: string; artist: string; album: string };
  cover: Blob | null;
  lyrics: { text: string; format: FetchedLyricFormat } | null;
  lyricsSource: "amll" | "lrclib" | null;
};

export async function autoComplete(query: AutoFillQuery): Promise<AutoFillResult> {
  const wanted = { title: query.title.trim(), artist: query.artist.trim() };
  const result: AutoFillResult = {
    meta: { title: wanted.title, artist: wanted.artist, album: "" },
    cover: null,
    lyrics: null,
    lyricsSource: null,
  };
  if (!wanted.title) return result;

  let title = wanted.title;
  let artist = wanted.artist;
  let album = "";
  let durationSec = query.durationMs && query.durationMs > 0 ? query.durationMs / 1000 : 0;

  // 第一步：iTunes 把标题/歌手/专辑/时长规范化为官方写法，后面的歌词检索都用它
  try {
    const track = await searchItunes(wanted.title, wanted.artist);
    if (track) {
      title = track.trackName?.trim() || title;
      artist = track.artistName?.trim() || artist;
      album = track.collectionName?.trim() ?? "";
      if (track.trackTimeMillis && track.trackTimeMillis > 0) {
        durationSec = track.trackTimeMillis / 1000;
      }
      result.meta = { title, artist, album };
      const artwork = track.artworkUrl100;
      if (artwork) {
        // 取成 Blob 再用 blob: URL 进画布：跨域 <img> 会污染画布，导出时 captureStream 直接失败
        result.cover = await getBlob(artwork.replace(ARTWORK_FROM, ARTWORK_TO)).catch(() => null);
      }
    }
  } catch {
    // 元信息源不可用时，用文件名推导的标题/歌手继续找歌词
  }

  // 第二步：逐字 TTML 优先，其次行级 LRC
  let ttml = await findAmllTtml(title, artist).catch(() => null);
  if (!ttml && (title !== wanted.title || artist !== wanted.artist)) {
    ttml = await findAmllTtml(wanted.title, wanted.artist).catch(() => null);
  }
  if (ttml) {
    result.lyrics = { text: ttml, format: "ttml" };
    result.lyricsSource = "amll";
    return result;
  }

  const lrc = await getLrclibLyrics(title, artist, album, durationSec).catch(() => null);
  if (lrc) {
    result.lyrics = { text: lrc, format: "lrc" };
    result.lyricsSource = "lrclib";
  }
  return result;
}
