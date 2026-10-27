// Ritsu 应用外壳：素材载入 → 实时预览 → 实时导出。
// 只做编排（引擎 / 舞台 / React 状态），画面细节全部在 StageRenderer 内。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import { BackgroundRender } from "@applemusic-like-lyrics/react";
import type { LyricLine } from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";

import { AudioEngine } from "./audio/engine";
import { exportVideo, pickMimeType } from "./export/recorder";
import { exportOfflineRender, isOfflineRenderSupported } from "./export/offline";
import { loadLyricFile, parseLyricsText } from "./lyric/load";
import { autoComplete } from "./autofill/sources";
import { StageRenderer } from "./render/stage";
import type { StageMeta } from "./render/stage";
import type { AdmMetadata, AtmosRoomShape, AudioSource } from "./types";

const AUDIO_ACCEPT = "audio/*,.wav,.bwf,.rf64,.flac,.mp3,.m4a,.aac,.ogg";
const LYRIC_ACCEPT = ".lrc,.yrc,.qrc,.lys,.lyl,.lqe,.ttml,.xml,.txt";
const COVER_ACCEPT = "image/*";

// 离线渲染分辨率预设（16:9）+ 帧率档位；选「自定义」时宽高可编辑
const RESOLUTION_PRESETS = [
  { id: "1080p", label: "1080p（1920×1080）", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p（2560×1440）", width: 2560, height: 1440 },
  { id: "4k", label: "4K（3840×2160）", width: 3840, height: 2160 },
] as const;
const FPS_CHOICES = [24, 30, 60];

// 输出宽高就近取偶并夹进可编码范围：H.264 yuv420 要求偶数，NaN / 过小归到下限
function snapEvenSize(v: number): number {
  if (!Number.isFinite(v)) return 2;
  return Math.min(7680, Math.max(2, Math.round(v) & ~1));
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

// "Artist - Title.flac" → { artist, title }；没有分隔符时整体当标题
function splitFileName(fileName: string): { title: string; artist: string } {
  const base = baseName(fileName);
  const sep = base.indexOf(" - ");
  if (sep > 0) {
    return { artist: base.slice(0, sep).trim(), title: base.slice(sep + 3).trim() };
  }
  return { title: base, artist: "" };
}

// 空输入的兜底文案（同时用作输入框 placeholder）
const META_PLACEHOLDER = { title: "未知曲目", artist: "未知歌手" };

// 用户输入优先，空则回退文件名推导值，再回退兜底文案：舞台上不留空白标题行
function resolveMeta(input: StageMeta, fallback: StageMeta): StageMeta {
  return {
    title: input.title.trim() || fallback.title || META_PLACEHOLDER.title,
    artist: input.artist.trim() || fallback.artist || META_PLACEHOLDER.artist,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 「就绪 / 处理中」这类文案原地换字（transitions.dev text-states-swap）：
// 旧字上移模糊退出 → 换字 → 新字从下方进入。
// span 不带 children、textContent 全程由 effect 拥有 —— 交给 React 渲染的话，
// 新字会在退出动画开始前就被写进 DOM，动画等于没有。
function SwapText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  // useLayoutEffect：首帧就把字写进去，否则按钮会先空一帧再长出文字
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.textContent || el.textContent === text) {
      el.textContent = text;
      return;
    }
    const cs = getComputedStyle(document.documentElement);
    const dur = parseFloat(cs.getPropertyValue("--text-swap-dur")) || 150;
    el.classList.add("is-exit");
    const timer = window.setTimeout(() => {
      el.textContent = text;
      el.classList.remove("is-exit");
      el.classList.add("is-enter-start");
      void el.offsetHeight; // 强制回流，新字才会从下方起步而不是直接归位
      el.classList.remove("is-enter-start");
    }, dur);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove("is-exit", "is-enter-start");
    };
  }, [text]);

  return <span ref={ref} className="t-text-swap" />;
}

// 摆位开关：勾选框改成按钮 + 描边打勾（transitions.dev checkbox-check）。
// 原生 input 的对勾由浏览器绘制，做不了描边动画，所以自己画 SVG。
function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="check-row">
      <button
        type="button"
        className="t-check"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
      >
        <svg viewBox="0 0 10.1668 10.1668" aria-hidden="true">
          <path d="M1 5.52L3.92 9.17L9.17 1" />
        </svg>
      </button>
      {/* 文字只是点击热区：可访问名已经在按钮上，这里屏蔽掉避免读屏重复播报 */}
      <span className="check-label" aria-hidden="true" onClick={onChange}>
        {label}
      </span>
    </div>
  );
}

// 封面缩略图：挂载时先只画虚线占位，下一帧交叉模糊揭示真图（transitions.dev skeleton-reveal）。
// 没图就不渲染槽位 —— 没有待加载数据时摆个 skeleton 等于假报进度。
function CoverSlot({ url }: { url: string }) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <span className={revealed ? "t-skel cover-slot is-revealed" : "t-skel cover-slot"}>
      <span className="t-skel-skeleton" aria-hidden="true" />
      <span className="t-skel-content">
        <img className="cover-thumb" src={url} alt="封面预览" />
      </span>
    </span>
  );
}

// 空舞台：两行文案分层浮现（transitions.dev texts-reveal）。
// .is-shown 必须等挂载后的一帧再加，否则首次绘制就是终态、没有过渡可放。
function StageEmpty() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="stage-empty" aria-hidden="true">
      <div className={shown ? "t-stagger is-shown" : "t-stagger"}>
        <div className="t-stagger-line t-stagger-line--1">
          <div className="stage-empty-mark">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <p className="t-stagger-line t-stagger-line--2 stage-empty-text">等待载入素材</p>
      </div>
    </div>
  );
}

// 条件出现的整块内容：挂载时先折叠，下一帧再展开（transitions.dev accordion 的 0fr ↔ 1fr 高度过渡）。
// 折叠态只存在于挂载后的那一帧；子节点仍由父级条件渲染，关闭时直接卸载，
// 所以不会像常挂载的手风琴那样留下看不见却能 Tab 到的控件。
function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className={className ? `t-acc ${className}` : "t-acc"} data-open={open ? "true" : "false"}>
      <div className="t-acc-panel">
        <div className="t-acc-panel-inner">{children}</div>
      </div>
    </div>
  );
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  const stageRef = useRef<StageRenderer | null>(null);
  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const bgHostRef = useRef<HTMLDivElement | null>(null);
  const coverUrlRef = useRef<string | null>(null);
  // 封面/歌词是「自动补全填的」还是「用户自己传的」：只有自动填的才允许被下一次补全覆盖
  const coverAutoRef = useRef(false);
  const lyricsAutoRef = useRef(false);

  const [source, setSource] = useState<AudioSource | null>(null);
  const [adm, setAdm] = useState<AdmMetadata | null>(null);
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverImg, setCoverImg] = useState<HTMLImageElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  // 导出模式与离线参数：realtime = 原实时录制路径，offline = 逐帧编码（WebCodecs + mp4-muxer）
  const [exportMode, setExportMode] = useState<"realtime" | "offline">("realtime");
  const [resPreset, setResPreset] = useState("1080p");
  const [outWidth, setOutWidth] = useState(1920);
  const [outHeight, setOutHeight] = useState(1080);
  const [outFps, setOutFps] = useState(30);
  // 离线渲染的取消句柄
  const abortRef = useRef<AbortController | null>(null);
  // ADM 逐声道活动时间线：预览与离线导出共用（离线舞台需要同一份数据才能画出同样的摆位）
  const admActivityRef = useRef<Uint8Array[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 歌曲信息：metaInput 是输入框原值（可为空串），metaDefault 是文件名推导值
  const [metaInput, setMetaInput] = useState<StageMeta>({ title: "", artist: "" });
  const [metaDefault, setMetaDefault] = useState<StageMeta>({ title: "", artist: "" });
  // 自动补全的结果来源与专辑名（专辑只在状态里展示，舞台信息条仍是双行）
  const [autoAlbum, setAutoAlbum] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  // 摆位显示：隐藏未发声对象 + 消失延迟（秒）
  const [hideSilent, setHideSilent] = useState(false);
  const [silentDelaySec, setSilentDelaySec] = useState(2);
  // 摆位视图：空间形状 / 辉光轨迹 / 房间粒子（都由 timeMs 驱动，导出与预览一致）
  const [roomShape, setRoomShape] = useState<AtmosRoomShape>("sphere");
  const [trailOn, setTrailOn] = useState(true);
  const [trailSec, setTrailSec] = useState(0.5);
  const [particlesOn, setParticlesOn] = useState(true);

  // 引擎 / 舞台在挂载时创建、卸载时销毁。StrictMode 的模拟卸载走同一条清理路径，
  // 重新挂载即重建 —— 不在 render 里 new，避免被双调用泄漏 AudioContext / WebGL context。
  useEffect(() => {
    const engine = new AudioEngine();
    const stage = new StageRenderer();
    engineRef.current = engine;
    stageRef.current = stage;

    // 舞台画布进预览位；bgCanvas 进 1920×1080 的隐藏宿主，
    // StageRenderer 靠它 querySelector("canvas") 找到 AMLL 流体背景画布。
    stageHostRef.current?.appendChild(stage.canvas);
    bgHostRef.current?.appendChild(stage.bgCanvas);
    // 舞台到手就按当前状态初始化摆位视图（渲染器默认值与这里一致，显式下发避免以后默认值漂移）
    stage.setViewOptions({
      activityEnabled: hideSilent,
      activityDelayMs: silentDelaySec * 1000,
      roomShape,
      trailMs: trailOn ? trailSec * 1000 : 0,
      particles: particlesOn,
    });
    stage.render();

    const offTick = engine.onTick((t) => {
      const ms = t * 1000;
      setTimeMs(ms);
      stage.setTime(ms);
      stage.setPlaying(true);
      stage.render();
    });
    const offState = engine.onState((s) => {
      const nowPlaying = s === "playing";
      setPlaying(nowPlaying);
      stage.setPlaying(nowPlaying);
      stage.render();
    });

    return () => {
      offTick();
      offState();
      engine.dispose();
      stage.dispose();
      engineRef.current = null;
      stageRef.current = null;
      stage.canvas.remove();
      stage.bgCanvas.remove();
      if (coverUrlRef.current) {
        URL.revokeObjectURL(coverUrlRef.current);
        coverUrlRef.current = null;
      }
    };
  }, []);

  // 每次 setter 之后同步时间并强制重绘：暂停时没有 tick，画面会停在旧帧。
  const syncStage = (ms?: number): void => {
    const stage = stageRef.current;
    if (!stage) return;
    const t = ms ?? (engineRef.current ? engineRef.current.currentTime * 1000 : 0);
    stage.setTime(t);
    setTimeMs(t);
    stage.render();
  };

  const handleAudio = async (file: File): Promise<void> => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage) return;
    setBusy(true);
    setError(null);
    try {
      // engine.load 内部就是 decodeAudioFile，并把解码缓冲交给引擎（避免重复解码）
      const loaded = await engine.load(file);
      // 文件名 → 默认歌曲信息：输入框预填，舞台同步（空歌手回退兜底文案）
      const derived: StageMeta = splitFileName(file.name);
      setMetaDefault(derived);
      setMetaInput(derived);
      // 换了素材，上一轮的补全结果就作废了
      setAutoAlbum("");
      setAutoNote(null);
      stage.setMeta(resolveMeta(derived, derived));
      stage.setDuration(loaded.source.durationSec * 1000);

      const admMeta: AdmMetadata | null = loaded.source.isAdm ? loaded.adm : null;
      // 逐声道活动时间线随 ADM 下发；对象按声道绑定（chna / trackIndex）在渲染器内取用
      admActivityRef.current = admMeta ? loaded.activity : null;
      stage.setAdm(admMeta, admActivityRef.current);

      setSource(loaded.source);
      setAdm(admMeta);
      syncStage(0);
    } catch (e) {
      // engine.load 已清空旧缓冲，UI 状态跟着回到“未载入”，避免出现按了没反应的播放键
      setSource(null);
      setAdm(null);
      stage.setAdm(null);
      setError(`音频加载失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // 改一个字就立刻同步舞台：暂停时没有 tick，必须手动补一帧
  const updateMeta = (patch: Partial<StageMeta>): void => {
    const next = { ...metaInput, ...patch };
    setMetaInput(next);
    const stage = stageRef.current;
    if (!stage) return;
    stage.setMeta(resolveMeta(next, metaDefault));
    stage.render();
  };

  // 摆位视图选项：改状态 + 下发给渲染器，并补一帧（暂停时没有 tick，画面不会自己更新）
  const updateView = (patch: {
    hideSilent?: boolean;
    silentDelaySec?: number;
    roomShape?: AtmosRoomShape;
    trailOn?: boolean;
    trailSec?: number;
    particlesOn?: boolean;
  }): void => {
    const nextHide = patch.hideSilent ?? hideSilent;
    const nextDelay = patch.silentDelaySec ?? silentDelaySec;
    const nextShape = patch.roomShape ?? roomShape;
    const nextTrailOn = patch.trailOn ?? trailOn;
    const nextTrailSec = patch.trailSec ?? trailSec;
    const nextParticles = patch.particlesOn ?? particlesOn;
    setHideSilent(nextHide);
    setSilentDelaySec(nextDelay);
    setRoomShape(nextShape);
    setTrailOn(nextTrailOn);
    setTrailSec(nextTrailSec);
    setParticlesOn(nextParticles);
    const stage = stageRef.current;
    if (!stage) return;
    stage.setViewOptions({
      activityEnabled: nextHide,
      activityDelayMs: nextDelay * 1000,
      roomShape: nextShape,
      // 轨迹时长 0 = 关闭，不需要单独的开关字段
      trailMs: nextTrailOn ? nextTrailSec * 1000 : 0,
      particles: nextParticles,
    });
    syncStage();
  };

  const handleLyric = async (file: File): Promise<void> => {
    const stage = stageRef.current;
    if (!stage) return;
    setBusy(true);
    setError(null);
    try {
      lyricsAutoRef.current = false; // 用户亲手传的歌词，后续自动补全不得覆盖
      const parsed = await loadLyricFile(file);
      setLines(parsed);
      stage.setLyricLines(parsed);
      stage.render();
      if (parsed.length === 0) setError("未能从该文件解析出歌词行，请检查格式");
    } catch (e) {
      setError(`歌词解析失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCover = (file: File): void => {
    const stage = stageRef.current;
    if (!stage) return;
    setError(null);
    coverAutoRef.current = false; // 用户亲手传的封面，后续自动补全不得覆盖
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const prev = coverUrlRef.current;
      coverUrlRef.current = url;
      if (prev) URL.revokeObjectURL(prev);
      setCoverUrl(url);
      setCoverImg(img);
      stage.setCover(img);
      stage.render();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError("封面图片加载失败");
    };
    img.src = url;
  };

  // 把取回的封面 Blob 装成图片（blob: URL 同源，不会污染画布），复用上传路径的装填逻辑
  const applyCoverBlob = (blob: Blob): Promise<boolean> =>
    new Promise((resolve) => {
      const stage = stageRef.current;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const prev = coverUrlRef.current;
        coverUrlRef.current = url;
        if (prev) URL.revokeObjectURL(prev);
        setCoverUrl(url);
        setCoverImg(img);
        stage?.setCover(img);
        stage?.render();
        resolve(true);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(false);
      };
      img.src = url;
    });

  // 多源自动补全：以当前输入（空则文件名推导值）为查询条件，一次性补歌曲信息 + 封面 + 歌词。
  // 已有素材不覆盖：用户手动传过的封面 / 歌词优先。
  const handleAutoFill = async (): Promise<void> => {
    const stage = stageRef.current;
    if (!stage) return;
    const query = {
      title: metaInput.title.trim() || metaDefault.title,
      artist: metaInput.artist.trim() || metaDefault.artist,
      durationMs: source ? source.durationSec * 1000 : 0,
    };
    if (!query.title) {
      setAutoNote("先载入音频或填写标题，再自动补全");
      return;
    }
    setAutoBusy(true);
    setAutoNote(null);
    setError(null);
    try {
      const filled = await autoComplete(query);
      const next: StageMeta = { title: filled.meta.title, artist: filled.meta.artist };
      // 先把补全后的信息写入舞台，后面的歌词/封面都挂在同一份信息上
      setMetaInput(next);
      setMetaDefault(next);
      setAutoAlbum(filled.meta.album);
      stage.setMeta(resolveMeta(next, next));

      let coverOk = false;
      // 同理：只覆盖自动填的或空槽
      if (filled.cover && (!coverUrlRef.current || coverAutoRef.current)) {
        coverOk = await applyCoverBlob(filled.cover);
        if (coverOk) coverAutoRef.current = true;
      }

      let lyricLines = 0;
      // 只在没有歌词、或已有歌词也是上一轮自动填的时候才覆盖；用户上传的保留
      if (filled.lyrics && (lines.length === 0 || lyricsAutoRef.current)) {
        const parsed = parseLyricsText(filled.lyrics.text, filled.lyrics.format);
        if (parsed.length > 0) {
          lyricLines = parsed.length;
          lyricsAutoRef.current = true;
          setLines(parsed);
          stage.setLyricLines(parsed);
        }
      }
      stage.render();

      const parts: string[] = [];
      if (filled.meta.title !== query.title || filled.meta.album) parts.push("歌曲信息");
      if (coverOk) parts.push("封面");
      if (lyricLines > 0) {
        const kind = filled.lyricsSource === "amll" ? "逐字 TTML" : "行级 LRC";
        parts.push(`${kind} 歌词（${lyricLines} 行）`);
      }
      const kept = [
        coverUrlRef.current && filled.cover && !coverOk ? "已有封面" : "",
        lines.length > 0 && filled.lyrics && lyricLines === 0 ? "已有歌词" : "",
      ].filter(Boolean);
      if (parts.length === 0) parts.push("没找到可补的内容");
      setAutoNote(`已补全：${parts.join(" · ")}${kept.length > 0 ? `（保留${kept.join("、")}）` : ""}`);
    } catch (e) {
      setAutoNote(null);
      setError(`自动补全失败：${errText(e)}`);
    } finally {
      setAutoBusy(false);
    }
  };

  const handleSeek = (e: ChangeEvent<HTMLInputElement>): void => {
    const ms = Number(e.target.value);
    engineRef.current?.seek(ms / 1000);
    syncStage(ms);
  };

  const togglePlay = (): void => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    if (playing) engine.pause();
    else engine.play();
  };

  // 离线逐帧导出：不播放、不等实时。画面走独立 StageRenderer（与预览同一帧路径），
  // 音频取解码缓冲 → OfflineAudioContext 下混立体声 → WebCodecs 编码 → mp4-muxer 封 MP4。
  const exportOffline = async (): Promise<void> => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    const buffer = engine.decodedBuffer;
    if (!buffer) {
      setError("音频缓冲尚未就绪，无法离线渲染");
      return;
    }

    const width = snapEvenSize(outWidth);
    const height = snapEvenSize(outHeight);
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setExporting(true);
    setExportProgress(0);
    engine.pause(); // 离线不驱动播放时钟；避免播放与渲染争抢 CPU

    // 独立舞台实例：装上与预览一致的状态，但尺寸为目标分辨率（scale 参数化），不干扰预览画布
    const offStage = new StageRenderer(width, height);
    offStage.setCover(coverImg);
    offStage.setLyricLines(lines);
    offStage.setMeta(resolveMeta(metaInput, metaDefault));
    offStage.setDuration((engine.duration || source.durationSec) * 1000);
    offStage.setAdm(adm, adm ? admActivityRef.current : null);
    offStage.setViewOptions({
      activityEnabled: hideSilent,
      activityDelayMs: silentDelaySec * 1000,
      roomShape,
      trailMs: trailOn ? trailSec * 1000 : 0,
      particles: particlesOn,
    });
    // bgCanvas 挂进预览的流体背景宿主：StageRenderer 靠 parentElement 里的 canvas 找到 AMLL
    // 流体背景（宿主是空的 React 节点，追加的 canvas 不会被 React 回收）。
    // ponytail: AMLL 流体画布由 AMLL 自身按真实时间驱动、无法按时间轴重放，离线导出里它只按
    // 渲染墙钟推进，与音乐的对应关系是近似的；要精确重放需改为由时间轴驱动的背景。
    bgHostRef.current?.appendChild(offStage.bgCanvas);

    try {
      const blob = await exportOfflineRender({
        canvas: offStage.canvas,
        buffer,
        fps: outFps,
        renderFrame: (t) => {
          offStage.setTime(t);
          offStage.render();
        },
        onProgress: setExportProgress,
        signal: controller.signal,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName(source.fileName)}.mp4`;
      a.click();
      // ponytail: 延迟回收；立刻 revoke 在部分浏览器会打断下载
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      if ((e as Error).name === "AbortError") setError("离线渲染已取消");
      else setError(`离线渲染失败：${errText(e)}`);
    } finally {
      offStage.bgCanvas.remove();
      offStage.dispose();
      abortRef.current = null;
      setExporting(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    const engine = engineRef.current;
    const stage = stageRef.current;
    if (!engine || !stage || exporting) return;
    if (!source) {
      setError("请先载入音频文件，再导出视频");
      return;
    }
    if (exportMode === "offline") {
      await exportOffline();
      return;
    }

    setError(null);
    setExporting(true);
    setExportProgress(0);
    engine.seek(0);
    syncStage(0); // 先把画面推到 0 帧，captureStream 起手才不会抓到旧画面

    try {
      const pending = exportVideo({
        canvas: stage.canvas,
        audio: engine.destination.stream,
        durationSec: engine.duration || source.durationSec,
        fps: 30,
        onProgress: setExportProgress,
      });
      engine.play(); // 实时录制：播放驱动 tick → 逐帧 render
      const blob = await pending;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName(source.fileName)}.${pickMimeType().extension}`;
      a.click();
      // ponytail: 延迟回收；立刻 revoke 在部分浏览器会打断下载
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(`导出失败：${errText(e)}`);
    } finally {
      engine.pause();
      setExporting(false);
    }
  };

  const durationMs = source ? source.durationSec * 1000 : 0;
  const seekMax = Math.max(durationMs, 1);
  const seekValue = Math.min(Math.max(timeMs, 0), seekMax);
  const progressPct = durationMs > 0 ? Math.min(100, (timeMs / durationMs) * 100) : 0;
  const locked = busy || exporting;
  // WebCodecs 能力检测：不支持时离线模式在 UI 上禁用并回退实时录制
  const offlineSupported = isOfflineRenderSupported();
  // 只在完全空白时盖住舞台：只有歌词或只有封面时仍显示既有画面
  const stageEmpty = !source && lines.length === 0 && !coverUrl;

  return (
    <div className="app">
      {/* AMLL 流体背景的宿主：必须常驻 DOM 且尺寸为 1920×1080，
          StageRenderer 会把它的画布合成进主画布，所以这里保持不可见。 */}
      <div className="stage-bg-host" ref={bgHostRef} aria-hidden="true">
        <BackgroundRender
          album={coverImg ?? coverUrl ?? undefined}
          playing={playing}
          hasLyric={lines.length > 0}
          flowSpeed={2}
          fps={30}
        />
      </div>

      <header className="app-header">
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true">律</span>
          <span className="brand-name">Ritsu</span>
        </h1>
        <p className="tagline">歌词视频渲染器，支持 Dolby Atmos 空间摆位</p>
      </header>

      <main className="app-main">
        <aside className="panel" aria-busy={busy}>
          <section className="panel-block">
            <h2 className="block-title">素材</h2>

            <label className="file-field">
              <span className="file-label" id="audio-file-label">
                音频文件
              </span>
              <input
                type="file"
                accept={AUDIO_ACCEPT}
                disabled={locked}
                aria-labelledby="audio-file-label"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleAudio(file);
                }}
              />
              <span className="file-note">支持 WAV、BWF、FLAC、MP3、M4A</span>
            </label>

            <label className="file-field">
              <span className="file-label" id="lyric-file-label">
                歌词文件
              </span>
              <input
                type="file"
                accept={LYRIC_ACCEPT}
                disabled={locked}
                aria-labelledby="lyric-file-label"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleLyric(file);
                }}
              />
              <span className="file-note">支持 LRC、YRC、QRC、TTML</span>
            </label>

            <label className="file-field">
              <span className="file-label" id="cover-file-label">
                封面图片
              </span>
              <span className="cover-row">
                {coverUrl ? <CoverSlot url={coverUrl} /> : null}
                <input
                  type="file"
                  accept={COVER_ACCEPT}
                  disabled={locked}
                  aria-labelledby="cover-file-label"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) handleCover(file);
                  }}
                />
              </span>
              <span className="file-note">1:1 方图，PNG 或 JPG</span>
            </label>
          </section>

          <section className="panel-block">
            <h2 className="block-title">歌曲信息</h2>
            <div className="meta-row">
              <label className="file-field" htmlFor="meta-title">
                <span className="file-label">标题</span>
                <input
                  id="meta-title"
                  className="text-input"
                  type="text"
                  value={metaInput.title}
                  placeholder={metaDefault.title || META_PLACEHOLDER.title}
                  disabled={locked}
                  onChange={(e) => updateMeta({ title: e.target.value })}
                />
              </label>
              <label className="file-field" htmlFor="meta-artist">
                <span className="file-label">歌手</span>
                <input
                  id="meta-artist"
                  className="text-input"
                  type="text"
                  value={metaInput.artist}
                  placeholder={metaDefault.artist || META_PLACEHOLDER.artist}
                  disabled={locked}
                  onChange={(e) => updateMeta({ artist: e.target.value })}
                />
              </label>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={locked || autoBusy}
              onClick={() => void handleAutoFill()}
            >
              <SwapText text={autoBusy ? "补全中…" : "自动补全信息与歌词"} />
            </button>
            {autoNote ? <p className="hint">{autoNote}</p> : null}
            {autoAlbum ? <p className="hint">专辑：{autoAlbum}</p> : null}
          </section>

          {adm ? (
            <Reveal className="panel-block">
            <section className="panel-block">
              <h2 className="block-title">摆位显示</h2>
              <CheckRow
                label="隐藏未发声对象"
                checked={hideSilent}
                onChange={() => updateView({ hideSilent: !hideSilent })}
              />
              <label className="delay-row">
                <span>消失延迟</span>
                <input
                  className="text-input delay-input"
                  type="number"
                  min={0}
                  max={30}
                  step={0.5}
                  value={silentDelaySec}
                  disabled={!hideSilent || locked}
                  aria-label="消失延迟秒数"
                  onChange={(e) => {
                    const v = e.target.valueAsNumber;
                    if (Number.isFinite(v)) updateView({ silentDelaySec: v });
                  }}
                />
                <span>秒</span>
              </label>
              <CheckRow
                label="辉光轨迹"
                checked={trailOn}
                onChange={() => updateView({ trailOn: !trailOn })}
              />
              <label className="delay-row">
                <span>轨迹时长</span>
                <input
                  className="text-input delay-input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={trailSec}
                  disabled={!trailOn || locked}
                  aria-label="辉光轨迹时长秒数"
                  onChange={(e) => {
                    const v = e.target.valueAsNumber;
                    if (Number.isFinite(v)) updateView({ trailSec: v });
                  }}
                />
                <span>秒</span>
              </label>
              <CheckRow
                label="粒子云雾"
                checked={particlesOn}
                onChange={() => updateView({ particlesOn: !particlesOn })}
              />
              <p className="hint">
                对象停止发声超过「消失延迟」后淡出，重新发声立即恢复；轨迹与粒子都由时间驱动，预览与离线导出逐帧一致。
              </p>
            </section>
            </Reveal>
          ) : null}

          <section className="panel-block">
            <h2 className="block-title">播放</h2>
            <div className="transport">
              <button
                type="button"
                className="play-btn"
                onClick={togglePlay}
                disabled={!source || locked}
                aria-label={playing ? "暂停" : "播放"}
              >
                <span
                  className="t-icon-swap"
                  data-state={playing ? "b" : "a"}
                  aria-hidden="true"
                >
                  <span className="t-icon" data-icon="a">
                    <svg viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4.6 2.7 12.8 8l-8.2 5.3z" />
                    </svg>
                  </span>
                  <span className="t-icon" data-icon="b">
                    <svg viewBox="0 0 16 16" fill="currentColor">
                      <rect x="3.5" y="2.5" width="3.2" height="11" rx="1" />
                      <rect x="9.3" y="2.5" width="3.2" height="11" rx="1" />
                    </svg>
                  </span>
                </span>
              </button>
              <div className="seek-wrap">
                <span className="time-readout">
                  {formatTime(timeMs)} / {formatTime(durationMs)}
                </span>
                <input
                  className="seek"
                  type="range"
                  min={0}
                  max={seekMax}
                  step={50}
                  value={seekValue}
                  disabled={!source || exporting}
                  style={{ "--seek": `${progressPct.toFixed(2)}%` } as CSSProperties}
                  onChange={handleSeek}
                  aria-label="播放进度"
                />
              </div>
            </div>
          </section>

          <section className="panel-block">
            <h2 className="block-title">导出</h2>
            <label className="file-field" htmlFor="export-mode">
              <span className="file-label">模式</span>
              <select
                id="export-mode"
                className="text-input"
                value={exportMode}
                disabled={locked}
                onChange={(e) => setExportMode(e.target.value === "offline" ? "offline" : "realtime")}
              >
                <option value="realtime">实时录制（边播边录）</option>
                <option value="offline" disabled={!offlineSupported}>离线渲染（逐帧编码）</option>
              </select>
            </label>

            {exportMode === "offline" ? (
              <Reveal>
              <div className="meta-row">
                <label className="file-field" htmlFor="export-preset">
                  <span className="file-label">分辨率</span>
                  <select
                    id="export-preset"
                    className="text-input"
                    value={resPreset}
                    disabled={locked}
                    onChange={(e) => {
                      const id = e.target.value;
                      setResPreset(id);
                      const preset = RESOLUTION_PRESETS.find((p) => p.id === id);
                      if (preset) {
                        setOutWidth(preset.width);
                        setOutHeight(preset.height);
                      }
                    }}
                  >
                    {RESOLUTION_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                    <option value="custom">自定义</option>
                  </select>
                </label>
                <label className="file-field" htmlFor="export-fps">
                  <span className="file-label">帧率</span>
                  <select
                    id="export-fps"
                    className="text-input"
                    value={outFps}
                    disabled={locked}
                    onChange={(e) => setOutFps(Number(e.target.value))}
                  >
                    {FPS_CHOICES.map((f) => (
                      <option key={f} value={f}>
                        {f} fps
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              </Reveal>
            ) : null}

            {exportMode === "offline" && resPreset === "custom" ? (
              <Reveal>
              <div className="meta-row">
                <label className="file-field" htmlFor="export-width">
                  <span className="file-label">宽</span>
                  <input
                    id="export-width"
                    className="text-input"
                    type="number"
                    min={2}
                    max={7680}
                    step={2}
                    value={outWidth}
                    disabled={locked}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber;
                      if (Number.isFinite(v)) setOutWidth(v);
                    }}
                  />
                </label>
                <label className="file-field" htmlFor="export-height">
                  <span className="file-label">高</span>
                  <input
                    id="export-height"
                    className="text-input"
                    type="number"
                    min={2}
                    max={7680}
                    step={2}
                    value={outHeight}
                    disabled={locked}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber;
                      if (Number.isFinite(v)) setOutHeight(v);
                    }}
                  />
                </label>
              </div>
              </Reveal>
            ) : null}

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleExport()}
              disabled={!source || locked}
            >
              {exporting
                ? `${exportMode === "offline" ? "渲染中" : "导出中"}… ${Math.round(exportProgress * 100)}%`
                : exportMode === "offline"
                  ? "离线渲染导出"
                  : "导出视频"}
            </button>
            {exporting ? (
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${exportProgress * 100}%` }} />
              </div>
            ) : null}
            {exporting && exportMode === "offline" ? (
              <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
                取消渲染
              </button>
            ) : null}
            {exportMode === "offline" ? (
              <p className="hint">
                {offlineSupported
                  ? `离线渲染：${snapEvenSize(outWidth)}×${snapEvenSize(outHeight)} @ ${outFps}fps，逐帧编码、不再等实时；非 16:9 的分辨率会等比居中留黑边。`
                  : "当前浏览器不支持 WebCodecs，离线渲染不可用，请使用实时录制。"}
              </p>
            ) : (
              <p className="hint">实时导出：录制耗时约等于歌曲时长，期间请保持页面在前台。</p>
            )}
          </section>

          <div className="status-row">
            {busy ? (
              <span className="chip chip-accent t-shimmer" data-text="处理中…">
                处理中…
              </span>
            ) : null}
            {source ? <span className="chip">{source.channelCount} 声道</span> : null}
            {source ? (
              <span className="chip">{(source.sampleRate / 1000).toFixed(1)} kHz</span>
            ) : null}
            {adm ? <span className="chip chip-accent">Dolby Atmos</span> : null}
            {adm ? <span className="chip">{adm.objects.length} 个对象</span> : null}
            {lines.length > 0 ? <span className="chip">{lines.length} 行歌词</span> : null}
            {!source && lines.length === 0 && !busy ? (
              <span className="chip chip-muted">等待载入素材</span>
            ) : null}
          </div>

          {error ? (
            /* key={error} 换错误文案就重挂载一次，抖动动画从头重放（同一个串不重放） */
            <p className="error t-input is-shaking" key={error} role="alert">
              {error}
            </p>
          ) : null}
        </aside>

        <section className="stage-panel">
          <div className="stage-frame" ref={stageHostRef}>
            {stageEmpty ? <StageEmpty /> : null}
          </div>
        </section>
      </main>
    </div>
  );
}
