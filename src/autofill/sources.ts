// 多源自动补全：iTunes 补歌曲信息/封面，AMLL 补逐字 TTML，LRCLIB 补行级 LRC。
// 三个源都是公开 API 且允许跨域直连（Access-Control-Allow-Origin: *），所以不需要自建后端。
// 本模块只负责取回候选 / 文本 / Blob，解析与舞台更新交给 App —— 这样这里不引 AMLL 的 ESM 包，
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

function countLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
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

/** 单个「信息 + 封面」候选。封面 URL 仅用于列表展示；应用时另行取 Blob 防污染画布。 */
export interface MetaCandidate {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  durationMs?: number;
}

const MAX_META = 8;
const MAX_LYRIC = 6;

function toMetaCandidate(track: ItunesTrack, fallbackId: number): MetaCandidate {
  return {
    id: String(track.trackId ?? `itunes-${fallbackId}`),
    title: track.trackName?.trim() ?? "",
    artist: track.artistName?.trim() ?? "",
    album: track.collectionName?.trim() ?? "",
    coverUrl: (track.artworkUrl100 ?? "").replace(ARTWORK_FROM, ARTWORK_TO),
    durationMs: track.trackTimeMillis && track.trackTimeMillis > 0 ? track.trackTimeMillis : undefined,
  };
}

function metaScore(track: ItunesTrack, wantTitle: string, wantArtist: string): number {
  const gotTitle = matchKey(track.trackName ?? "");
  const gotArtist = matchKey(track.artistName ?? "");
  let score = 0;
  if (wantTitle && gotTitle === wantTitle) score += 4;
  else if (wantTitle && gotTitle && (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle))) score += 2;
  if (wantArtist && gotArtist === wantArtist) score += 3;
  else if (wantArtist && gotArtist && (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist))) score += 1;
  return score;
}

/** 按匹配度排序的信息候选列表（最佳在前），交给界面点选。 */
export async function searchMetaCandidates(query: {
  title: string;
  artist: string;
}): Promise<MetaCandidate[]> {
  const term = [query.artist.trim(), query.title.trim()].filter(Boolean).join(" ");
  if (!term) return [];
  const params = new URLSearchParams({ term, entity: "song", limit: "12" });
  const data = await getJson<{ results?: ItunesTrack[] }>(`${ITUNES_SEARCH}?${params.toString()}`);
  const tracks = Array.isArray(data.results) ? data.results : [];
  const wantTitle = matchKey(query.title);
  const wantArtist = matchKey(query.artist);
  return tracks
    .map((track, index) => ({ track, index, score: metaScore(track, wantTitle, wantArtist) }))
    .filter(({ track }) => Boolean(track.trackName?.trim()))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_META)
    .map(({ track, index }) => toMetaCandidate(track, index));
}

/** 整包补全用：只在标题确实吻合时返回最佳候选，否则 null（宁可不填也不填错）。 */
export async function bestMetaCandidate(query: {
  title: string;
  artist: string;
}): Promise<MetaCandidate | null> {
  const want = matchKey(query.title);
  if (!want) return null;
  const list = await searchMetaCandidates(query);
  const exact = list.find((c) => matchKey(c.title) === want);
  if (exact) return exact;
  return list.find((c) => {
    const got = matchKey(c.title);
    return got && (got.includes(want) || want.includes(got));
  }) ?? null;
}

/** 取封面 Blob（跨域 <img> 会污染画布，导出 captureStream 直接失败，故取成 blob:）。 */
export async function fetchCoverBlob(candidate: MetaCandidate): Promise<Blob | null> {
  if (!candidate.coverUrl) return null;
  return getBlob(candidate.coverUrl).catch(() => null);
}

// ── 歌词候选（AMLL 逐字 TTML / LRCLIB 行级 LRC）───────────────

export type LyricSource = "amll" | "lrclib";

/** 单个歌词候选。AMLL 的文件在 load() 里才真正下载，避免一次列几十个文件。 */
export interface LyricCandidate {
  id: string;
  title: string;
  artist: string;
  album?: string;
  source: LyricSource;
  format: FetchedLyricFormat;
  synced: boolean;
  lineCount?: number;
  load: () => Promise<string>;
}

export type LyricQuery = { title: string; artist: string; album?: string; durationMs?: number };

export async function searchLyricCandidates(
  query: LyricQuery,
  source: LyricSource,
): Promise<LyricCandidate[]> {
  const title = query.title.trim();
  if (!title) return [];
  const artist = query.artist.trim();
  return source === "amll"
    ? searchAmllCandidates(title, artist)
    : searchLrclibCandidates(title, artist, query.album ?? "", query.durationMs && query.durationMs > 0 ? query.durationMs / 1000 : 0);
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

async function searchAmllCandidates(title: string, artist: string): Promise<LyricCandidate[]> {
  const index = await loadAmllIndex();
  const wantTitle = matchKey(title);
  if (!wantTitle) return [];
  const wantArtist = matchKey(artist);
  const hits = index.filter((e) => matchKey(e.musicName) === wantTitle);
  hits.sort((a, b) => {
    const sa = wantArtist && a.artists.some((x) => matchKey(x) === wantArtist) ? 1 : 0;
    const sb = wantArtist && b.artists.some((x) => matchKey(x) === wantArtist) ? 1 : 0;
    return sb - sa;
  });
  return hits.slice(0, MAX_LYRIC).map((entry, i) => ({
    id: `amll-${entry.file}-${i}`,
    title: entry.musicName,
    artist: entry.artists.join(" / "),
    source: "amll" as const,
    format: "ttml" as const,
    synced: true,
    load: async () => {
      const text = await getText(`${AMLL_RAW_BASE}${encodeURIComponent(entry.file)}`);
      if (text == null) throw new Error("AMLL 歌词文件下载失败");
      return text;
    },
  }));
}

// ── LRCLIB：行级歌词（TTML 没有时的退路） ───────────────────

type LrclibRecord = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  instrumental?: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
};

async function searchLrclibCandidates(
  title: string,
  artist: string,
  _album: string,
  _durationSec: number,
): Promise<LyricCandidate[]> {
  const query = [artist, title].filter(Boolean).join(" ");
  if (!query) return [];
  let list: LrclibRecord[] = [];
  try {
    list = await getJson<LrclibRecord[]>(
      `${LRCLIB_API}/search?${new URLSearchParams({ q: query }).toString()}`,
      { headers: LRCLIB_HEADERS },
    );
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const wantTitle = matchKey(title);
  const wantArtist = matchKey(artist);
  const score = (r: LrclibRecord): number => {
    const gotTitle = matchKey(r.trackName ?? "");
    const gotArtist = matchKey(r.artistName ?? "");
    let s = 0;
    if (wantTitle && gotTitle === wantTitle) s += 4;
    else if (wantTitle && gotTitle && (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle))) s += 2;
    if (wantArtist && gotArtist === wantArtist) s += 3;
    else if (wantArtist && gotArtist && (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist))) s += 1;
    if (r.syncedLyrics?.trim()) s += 1;
    return s;
  };
  return list
    .map((rec) => ({ rec, text: (rec.syncedLyrics ?? rec.plainLyrics ?? "").trim() }))
    .filter(({ rec, text }) => !rec.instrumental && text.length > 0)
    .sort((a, b) => score(b.rec) - score(a.rec))
    .slice(0, MAX_LYRIC)
    .map(({ rec, text }, i) => ({
      id: `lrclib-${rec.id ?? i}`,
      title: rec.trackName?.trim() || title,
      artist: rec.artistName?.trim() ?? "",
      album: rec.albumName?.trim(),
      source: "lrclib" as const,
      format: "lrc" as const,
      synced: Boolean(rec.syncedLyrics?.trim()),
      lineCount: countLines(text),
      load: async () => text,
    }));
}
