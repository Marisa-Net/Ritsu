import * as THREE from "three";
import {
  ACTIVITY_WINDOW_MS,
  type AdmKeyframe,
  type AdmObject,
  type AtmosRoomShape,
  type AtmosViewOptions,
} from "../types";
import { visibilityAt } from "./activity";
import {
  boxRoomLines,
  boxRoomPoints,
  fillParticles,
  fitDistanceForPoints,
  fitDistanceForRadius,
  isMovingTrack,
  markerWorldRadius,
  sampleTrackAt,
  sphereRoomLines,
  trailSampleOffsets,
  trailWindowStart,
  updateParticles,
  type Vec3Out,
} from "./geometry";

// AtmosRenderer：ADM 摆位 3D 视图。
// 只拥有一个离屏 canvas（不挂载 DOM、不是 React 组件），由 compositor drawImage 到 1920×1080 主画布。
//
// 两条贯穿全文件的约束：
// 1. 画面必须是 timeMs 的纯函数（无滚动缓冲 / 无墙钟 / 无帧计数）——预览与离线逐帧导出共用它，
//    任何「累积型」动画都会让成片与预览不一致。粒子有随机布局，用固定 seed 保证两次运行相同。
// 2. 所有形状与取景数值都在 geometry.ts 里算（那一侧不依赖 three，可在 CI 裸 Node 下自检）。

// 单位球半径 = ADM 距离 1；对象标记的基准尺寸（世界单位，固定值）。
// 房间缩到 ADM 尺度后取景距离同步变近，尺寸按同比例缩小才能保持上一版的屏幕观感（约 9.2px）。
const OBJECT_RADIUS = 0.063;
// 需完整入镜的包围球半径下限（单位球 + 光晕余量）
const FIT_RADIUS = 1.25;
// 相机方向：原点前左上方。方位角约 30°（偏画面左）、俯角约 20°，
// 形成两点透视——最近的竖直棱落在画面中心左侧，视线略向下但无侧倾（lookAt 默认 up）
const CAMERA_DIR = new THREE.Vector3(-0.47, 0.342, 0.814).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.05, 0);
// 相机看向 CAMERA_TARGET 而非原点：球心相对画面轴的横向偏移。球形取景的解析解必须把它算进去，
// 否则球面一侧会被画幅切掉（盒形走点集迭代，本身已经算准了这个偏移）。
const TARGET_LATERAL = (() => {
  const t = CAMERA_TARGET.clone();
  t.addScaledVector(CAMERA_DIR, -t.dot(CAMERA_DIR));
  return t.length();
})();
const FOV_DEG = 40;
// 取景余量：贴边后再留 2% 呼吸空间
const FIT_MARGIN = 1.02;

// 房间线框：钢蓝灰细线，无填充/无背景，只为摆位视图提供空间参照，画布保持透明以便 alpha 合成与导出。
// 亮度刻意压在彩色对象之下（1px 细线 + 低不透明度）——它是参照物，不是主角。
const ROOM_COLOR = 0x77879b;
const ROOM_LINE_OPACITY = 0.42;
// 赤道是球形空间里唯一有含义的结构线（听者平面），单独给更高的不透明度
const EQUATOR_OPACITY = 0.6;
const LISTENER_COLOR = 0xc9d6ea;
const LISTENER_OPACITY = 0.5;

// 盒形房间 = ADM 单位立方体（±1）+ 10% 余量：声床与对象的坐标顶到 ±1 时就贴着墙与角落，
// 整个房间被声场填满；这点余量让小球不至于压在格线上。格距 0.55 → 4×4 地面格。
const FLOOR_Y = -1.1;
const ROOM_TOP_Y = 1.1;
const ROOM_HALF_W = 1.1;
const ROOM_HALF_D = 1.1;
const GRID_COLS = 4;
const GRID_ROWS = 4;

// 球形房间 = ADM 单位球（距离 1）+ 10% 余量，与盒形同一套尺度，声场同样铺满球内。
// ponytail: 立方体角点位置（|p| > 1.1）会落在球外——球面本就不是立方体的外接面；
// 需要严格包含单位立方体时，把半径调回 √3 ≈ 1.8。
const SPHERE_RADIUS = 1.1;
const SPHERE_MERIDIANS = 8; // 每 45° 一条经线
const SPHERE_PARALLELS = 3; // → ±45° 两条纬线 + 赤道，稀疏得像地球仪而不是亮笼子

// 对象标记：亮核 + 宽软晕的加色 sprite（对齐 Dolby 官方预览器的观感——一颗发光点，不是实心球）。
// 贴图本身自带 10%→100% 半径的连续衰减，所以单张就够；再叠一张更大更淡的同款做外圈雾。
const MARKER_SAT = 0.85;
const MARKER_LIGHT = 0.62;
const DOT_SCALE = 2.2; // sprite 边长 = OBJECT_RADIUS × 它；亮核约占边长 5%，晕一直铺到边缘
const HALO_SCALE = 3.5; // 外圈雾相对 dot 的倍数（官方 ring/dot ≈ 13×，这里取更含蓄的比例）
const HALO_OPACITY = 0.2;

// 辉光轨迹：若干个同材质的加色 sprite 沿时间轴反向采样，只做尺寸渐隐（共享材质 → 每节点多 1 个材质）
// ponytail: 逐点 alpha 要自定义 ribbon 几何 + shader，这里 12 个重叠软点已连成彗尾；要更锐利再上 ribbon
const TRAIL_SAMPLES = 12;
const TRAIL_HEAD_SCALE = 0.62; // 相对 DOT_SCALE
const TRAIL_TAIL_SCALE = 0.1; // 相对 DOT_SCALE
const TRAIL_OPACITY = 0.2;
const DEFAULT_TRAIL_MS = 500;

// 听者标记：中心硬边光盘 + 一圈细环（官方 head 的配方），半径按官方比例放大到约 2× 对象标记
const LISTENER_RING_RADIUS = OBJECT_RADIUS * 2;
const LISTENER_RING_TUBE = OBJECT_RADIUS * 0.1;
const LISTENER_CORE_SCALE = 1.6; // 相对 LISTENER_RING_RADIUS

// 房间背后的品牌辉光：官方用 #120e4b 实心背景 + 暗晕 + 64 道极淡光芒，
// 但 Ritsu 的画布必须保持透明（要露出流体背景），所以这里只叠一团低不透明度紫晕当「聚光」。
const ROOM_GLOW_COLOR = new THREE.Color(0x261b61);
const ROOM_GLOW_OPACITY = 0.5;
const ROOM_GLOW_OVERSCAN = 1.25; // 相对画幅高度的溢出量

// 房间粒子：微尘，不是星空——冷灰、极低不透明度、普通混合（不用加色）
const PARTICLE_COUNT = 240;
const PARTICLE_SEED = 0x5eed;
const PARTICLE_COLOR = 0x8b9aac;
const PARTICLE_OPACITY = 0.24;
const PARTICLE_RADIUS_FRAC = 0.0055;

const ROOM_HALF_H = (ROOM_TOP_Y - FLOOR_Y) / 2;

type ObjectNode = {
  root: THREE.Group;
  dotMat: THREE.SpriteMaterial;
  haloMat: THREE.SpriteMaterial;
  trail: THREE.Sprite[];
  trailGroup: THREE.Group;
  trailMat: THREE.SpriteMaterial;
  track?: AdmKeyframe[];
  /** 关键帧是否真的在动：静态对象不建拖尾（省 12 个 sprite 的绘制） */
  moving: boolean;
  /** 活动门控可见度（不含深度明暗） */
  vis: number;
  /** 发声活动位图（100ms/窗，随声道绑定取自解码期时间线）；null = 始终发声 */
  activity: Uint8Array | null;
};

// id/name → 稳定色相。色相收在 240°–358°（蓝 → 紫 → 洋红）这一带：
// 官方预览器整屏就是这个色系，按 id 散列到全色轮会把画面拉成彩虹。
function hueFromKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 1000;
  return 240 + (h / 1000) * 118;
}

// 对象标记贴图：亮核 + 宽软晕（官方 dot 的渐变停点，逐字照搬）。
// 中心 10% 半径纯白实心，40% 处降到半透明灰，到边缘完全消失——观感是「发光点」而非「中空环」。
function makeDotTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.1, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(100,100,100,0.5)");
  g.addColorStop(1, "rgba(100,100,100,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 听者中心光盘：0.4 半径处硬边（内盘纯白、外面瞬暗），官方 head 的写法
function makeListenerTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.399, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 房间背后的紫晕：亮心很淡、边缘完全透明，叠在流体背景上像一束打向房间的聚光
function makeRoomGlowTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(56,42,120,0.55)");
  g.addColorStop(0.45, "rgba(38,27,97,0.30)");
  g.addColorStop(0.75, "rgba(24,18,64,0.10)");
  g.addColorStop(1, "rgba(18,14,60,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// 线框：positions 为成对线段端点。WebGL 忽略 linewidth，天然 1px 细线
function makeLineSegments(positions: number[], opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: ROOM_COLOR,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
}

export class AtmosRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly nodes = new Map<string, ObjectNode>();
  private readonly nodeList: ObjectNode[] = [];
  private readonly dotTexture: THREE.CanvasTexture;
  private readonly listenerTexture: THREE.CanvasTexture;
  private readonly roomGlowTexture: THREE.CanvasTexture;
  private readonly listener: THREE.Group;
  private readonly roomGlow: THREE.Sprite;
  // 房间线框：形状可变（盒形/球形），由 rebuildRoom 重建；尺寸靠 scale 跟随 fitRadius
  private room: THREE.LineSegments;
  private equator: THREE.LineSegments | null = null;
  /** 取景点集（基准尺度）：盒形为 8 角点，球形为球面网格点 */
  private roomPoints: number[];
  private readonly fitScratch: number[] = [];
  // 房间粒子：基座与参数一次算好，每帧只按 timeMs 重算位置
  private readonly particleGeometry: THREE.BufferGeometry;
  private readonly particleMaterial: THREE.PointsMaterial;
  private readonly particles: THREE.Points;
  private readonly particleBase: Float32Array;
  private readonly particleParams: Float32Array;
  private readonly particlePositions: Float32Array;
  private readonly tmp: Vec3Out = { x: 0, y: 0, z: 0 };

  private timeMs = 0;
  // 取景半径：按实际对象/关键帧范围计算，FIT_RADIUS 为下限
  private fitRadius = FIT_RADIUS;
  /** 房间缩放：房间与粒子都按它跟随取景半径 */
  private roomScale = 1;
  /** 相机到取景中心的距离（深度明暗的基准） */
  private cameraDistance = FIT_RADIUS;
  private viewW = 1;
  private viewH = 1;

  // ── 视图选项（由 setViewOptions 下发） ──
  private roomShape: AtmosRoomShape = "box";
  private trailMs = DEFAULT_TRAIL_MS;
  private trailOffsets: number[] = trailSampleOffsets(DEFAULT_TRAIL_MS, TRAIL_SAMPLES);
  private particlesOn = true;
  private activityEnabled = false;
  private activityDelayMs = 2000;

  constructor(width: number, height: number) {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    // 透明底：合成时露出 compositor 的背景
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 50);
    this.dotTexture = makeDotTexture();
    this.listenerTexture = makeListenerTexture();
    this.roomGlowTexture = makeRoomGlowTexture();

    // 房间背后的紫晕：不写深度、不测深度，永远画在最底层当聚光；尺寸由 fitCamera 按画幅换算
    this.roomGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.roomGlowTexture,
        color: ROOM_GLOW_COLOR,
        transparent: true,
        opacity: ROOM_GLOW_OPACITY,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.roomGlow.renderOrder = -1;
    this.roomGlow.position.copy(CAMERA_TARGET);
    this.scene.add(this.roomGlow);

    // 原点听者标记：中心硬边光盘 + 一圈细环，标示听者位置；环转平落在 XZ 平面（水平面）。
    // 既不是音频对象也不是测距标尺，所以用中性冷白而不是对象色。
    this.listener = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(LISTENER_RING_RADIUS, LISTENER_RING_TUBE, 8, 48),
      new THREE.MeshBasicMaterial({
        color: LISTENER_COLOR,
        transparent: true,
        opacity: LISTENER_OPACITY,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    this.listener.add(ring);
    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.listenerTexture,
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    core.renderOrder = 2;
    core.scale.setScalar(LISTENER_RING_RADIUS * LISTENER_CORE_SCALE);
    this.listener.add(core);
    this.scene.add(this.listener);

    // 粒子的基座/参数在 rebuildRoom 里按形状填；这里先准备好缓冲与对象
    this.particleBase = new Float32Array(PARTICLE_COUNT * 3);
    this.particleParams = new Float32Array(PARTICLE_COUNT * 3);
    this.particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    this.particleGeometry = new THREE.BufferGeometry();
    this.particleGeometry.setAttribute("position", new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleMaterial = new THREE.PointsMaterial({
      map: this.dotTexture,
      color: PARTICLE_COLOR,
      size: 0.01,
      sizeAttenuation: true,
      transparent: true,
      opacity: PARTICLE_OPACITY,
      depthWrite: false,
    });
    this.particles = new THREE.Points(this.particleGeometry, this.particleMaterial);
    // 位置每帧变，包围盒会过期 → 关掉视锥剔除
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    // 默认盒形房间（与 roomShape 字段一致）
    this.room = makeLineSegments(
      boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
      ROOM_LINE_OPACITY,
    );
    this.roomPoints = boxRoomPoints(ROOM_HALF_W, ROOM_HALF_D, FLOOR_Y, ROOM_TOP_Y);
    this.scene.add(this.room);
    this.rebuildParticles();

    this.resize(width, height);
  }

  setObjects(objects: AdmObject[], channelActivity?: Uint8Array[] | null): void {
    const live = new Set<string>();
    objects.forEach((obj, i) => {
      const key = obj.id || obj.name || String(i);
      live.add(key);
      let node = this.nodes.get(key);
      if (!node) {
        node = this.createNode(key);
        this.nodes.set(key, node);
        this.scene.add(node.root);
      }
      node.track = obj.track;
      node.moving = isMovingTrack(obj.track);
      // 发声活动位图：按对象绑定的声道号取对应声道的时间线；未绑定/越界 → null（始终发声）
      const bound =
        obj.channelIndex !== undefined && channelActivity
          ? channelActivity[obj.channelIndex]
          : undefined;
      node.activity = bound ?? null;
      // ADM → Three：three.x = adm.x，three.y = adm.z（上），three.z = -adm.y（前方朝屏幕内）
      node.root.position.set(obj.x, obj.z, -obj.y);
    });

    for (const [key, node] of this.nodes) {
      if (!live.has(key)) {
        this.scene.remove(node.root);
        this.scene.remove(node.trailGroup);
        node.dotMat.dispose();
        node.haloMat.dispose();
        node.trailMat.dispose();
        this.nodes.delete(key);
      }
    }

    // 取景半径覆盖所有对象的静态点与全部关键帧轨迹（角落对象 |p|=√3 不再出画）
    let maxDist = 0;
    for (let i = 0; i < objects.length; i += 1) {
      const obj = objects[i];
      const track = obj.track;
      if (track) {
        for (let k = 0; k < track.length; k += 1) {
          const d = Math.hypot(
            track[k].x - CAMERA_TARGET.x,
            track[k].z - CAMERA_TARGET.y,
            -track[k].y - CAMERA_TARGET.z,
          );
          if (d > maxDist) maxDist = d;
        }
      }
      const d0 = Math.hypot(obj.x - CAMERA_TARGET.x, obj.z - CAMERA_TARGET.y, -obj.y - CAMERA_TARGET.z);
      if (d0 > maxDist) maxDist = d0;
    }
    this.fitRadius = Math.max(FIT_RADIUS, maxDist + 0.25);
    // 房间与粒子随 fitRadius 等比缩放：对象云越散、相机后撤多少，房间就放大多少，
    // 于是任何取景半径下房间都保持同样的相对尺度。取景按房间轮廓收紧（见 fitCamera），
    // 所以房间在画幅里占得比「按外接球保守取景」时更满。
    this.roomScale = this.fitRadius / FIT_RADIUS;
    this.applyRoomScale();
    this.fitCamera(this.viewW, this.viewH);
    this.refreshParticles(this.timeMs);

    // setTime 用索引扫描，避免每帧分配迭代器/闭包
    this.nodeList.length = 0;
    for (const node of this.nodes.values()) this.nodeList.push(node);
    this.updateNodeLooks();
  }

  setTime(currentTimeMs: number): void {
    if (currentTimeMs === this.timeMs) return;
    this.timeMs = currentTimeMs;
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      // 活动门控对全部节点生效（含无轨迹的静态对象），置于轨迹处理之前
      if (this.activityEnabled) {
        node.vis = visibilityAt(node.activity, currentTimeMs, this.activityDelayMs, ACTIVITY_WINDOW_MS);
      }
      const track = node.track;
      if (track && track.length >= 2) {
        sampleTrackAt(track, currentTimeMs, this.tmp);
        node.root.position.set(this.tmp.x, this.tmp.z, -this.tmp.y);
      }
    }
    this.refreshParticles(currentTimeMs);
    this.updateNodeLooks();
  }

  /**
   * 视图选项：活动门控 + 空间形状 + 辉光轨迹时长 + 房间粒子。
   * 关闭门控时立即把所有节点复位为可见，等价于该功能 no-op。
   */
  setViewOptions(opts: AtmosViewOptions): void {
    if (opts.activityEnabled !== undefined) this.activityEnabled = opts.activityEnabled;
    if (opts.activityDelayMs !== undefined && opts.activityDelayMs >= 0) {
      this.activityDelayMs = opts.activityDelayMs;
    }
    if (opts.trailMs !== undefined && opts.trailMs >= 0 && opts.trailMs !== this.trailMs) {
      this.trailMs = opts.trailMs;
      this.trailOffsets = trailSampleOffsets(this.trailMs, TRAIL_SAMPLES);
    }
    if (opts.particles !== undefined && opts.particles !== this.particlesOn) {
      this.particlesOn = opts.particles;
      this.particles.visible = opts.particles;
    }
    if (opts.roomShape !== undefined && opts.roomShape !== this.roomShape) {
      this.roomShape = opts.roomShape;
      this.rebuildRoom();
    }
    if (!this.activityEnabled) {
      for (const node of this.nodes.values()) node.vis = 1;
    }
    this.updateNodeLooks();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
    this.renderer.setSize(Math.max(width, 1), Math.max(height, 1), false);
    this.fitCamera(width, height);
    this.updateNodeLooks();
  }

  dispose(): void {
    // 对象节点：材质各自持有；贴图全局共享，统一在下面释放
    for (const node of this.nodes.values()) {
      node.dotMat.dispose();
      node.haloMat.dispose();
      node.trailMat.dispose();
      this.scene.remove(node.trailGroup);
    }
    this.nodes.clear();
    this.nodeList.length = 0;
    this.disposeRoom();
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    // 听者标记：环的几何独立，material 各自持有。中心光盘是 Sprite（children[1]），
    // 它的 geometry 是 three 内部所有 Sprite 共享的同一份三角形，dispose 会打断之后新建的任何 Sprite。
    (this.listener.children[0] as THREE.Mesh).geometry.dispose();
    for (const child of this.listener.children) {
      const mat = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) mat.dispose();
    }
    (this.roomGlow.material as THREE.Material).dispose();
    this.dotTexture.dispose();
    this.listenerTexture.dispose();
    this.roomGlowTexture.dispose();
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // ── 房间与粒子 ─────────────────────────────────────────

  /** 房间线框 / 赤道 / 粒子统一按 roomScale 缩放：取景半径变大时三者同步放大，相对尺度不变。 */
  private applyRoomScale(): void {
    this.room.scale.setScalar(this.roomScale);
    if (this.equator) this.equator.scale.setScalar(this.roomScale);
    this.particles.scale.setScalar(this.roomScale);
  }

  private disposeRoom(): void {
    this.scene.remove(this.room);
    this.room.geometry.dispose();
    (this.room.material as THREE.Material).dispose();
    if (this.equator) {
      this.scene.remove(this.equator);
      this.equator.geometry.dispose();
      (this.equator.material as THREE.Material).dispose();
      this.equator = null;
    }
  }

  /** 切换空间形状：重建线框 + 取景点集 + 粒子基座，然后重新取景。 */
  private rebuildRoom(): void {
    this.disposeRoom();
    if (this.roomShape === "sphere") {
      const globe = sphereRoomLines(SPHERE_RADIUS, SPHERE_MERIDIANS, SPHERE_PARALLELS);
      this.room = makeLineSegments(globe.lines, ROOM_LINE_OPACITY);
      this.equator = makeLineSegments(globe.equator, EQUATOR_OPACITY);
      this.scene.add(this.equator);
      // 球形的取景走解析解（fitDistanceForRadius），不需要点集；保留盒形的那份避免 roomPoints 悬空
    } else {
      this.room = makeLineSegments(
        boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
        ROOM_LINE_OPACITY,
      );
      this.roomPoints = boxRoomPoints(ROOM_HALF_W, ROOM_HALF_D, FLOOR_Y, ROOM_TOP_Y);
    }
    this.applyRoomScale();
    this.scene.add(this.room);
    this.rebuildParticles();
    this.fitCamera(this.viewW, this.viewH);
  }

  private rebuildParticles(): void {
    fillParticles(
      PARTICLE_COUNT,
      this.roomShape,
      ROOM_HALF_W,
      ROOM_HALF_D,
      ROOM_HALF_H,
      SPHERE_RADIUS,
      PARTICLE_SEED,
      this.particleBase,
      this.particleParams,
    );
    this.refreshParticles(this.timeMs);
  }

  private refreshParticles(tMs: number): void {
    if (!this.particlesOn) return;
    updateParticles(
      this.particleBase,
      this.particleParams,
      PARTICLE_COUNT,
      tMs,
      this.particlePositions,
    );
    (this.particleGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  // ── 取景 ───────────────────────────────────────────────

  /**
   * 按宽高比沿视线后移相机，保证房间（而非外接球）完整入镜。
   * 盒形用角点投影迭代收紧；球形用解析解（透视下可见轮廓是切线圆）。
   */
  private fitCamera(width: number, height: number): void {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.aspect = aspect;
    let distance: number;
    if (this.roomShape === "sphere") {
      distance = fitDistanceForRadius(SPHERE_RADIUS * this.roomScale, FOV_DEG, aspect, FIT_MARGIN, TARGET_LATERAL);
    } else {
      const pts = this.roomPoints;
      const scratch = this.fitScratch;
      scratch.length = pts.length;
      for (let i = 0; i < pts.length; i += 1) scratch[i] = pts[i] * this.roomScale;
      distance = fitDistanceForPoints(
        scratch,
        CAMERA_DIR.x,
        CAMERA_DIR.y,
        CAMERA_DIR.z,
        CAMERA_TARGET.x,
        CAMERA_TARGET.y,
        CAMERA_TARGET.z,
        FOV_DEG,
        aspect,
        FIT_MARGIN,
      );
    }
    this.cameraDistance = Math.max(distance, FIT_RADIUS);
    this.camera.position.copy(CAMERA_DIR).multiplyScalar(this.cameraDistance);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();
    // 粒子屏幕尺寸随取景距离：微尘在放大后的房间里依旧是同样的视觉大小
    this.particleMaterial.size = markerWorldRadius(PARTICLE_RADIUS_FRAC, FOV_DEG, this.cameraDistance);
    // 紫晕按画幅高度换算世界尺寸：取景怎么变，它总是刚好铺满并略溢出画面
    const frameHalf = Math.tan((FOV_DEG * Math.PI) / 360) * this.cameraDistance;
    this.roomGlow.scale.setScalar(frameHalf * 2 * ROOM_GLOW_OVERSCAN);
  }

  // ── 逐帧外观 ───────────────────────────────────────────

  /**
   * 每帧统一结算外观：活动可见度 → 亮核 / 外圈雾 / 拖尾。位置变化与相机变化都走这里。
   * 标记用固定世界尺寸（与上一版一致），不随取景距离缩放。
   */
  private updateNodeLooks(): void {
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const vis = node.vis;

      node.root.visible = vis > 0.001;
      node.dotMat.opacity = vis;
      node.haloMat.opacity = HALO_OPACITY * vis;
      // 拖尾不吃深度明暗：否则尾端更暗，反而读不出运动方向
      node.trailMat.opacity = TRAIL_OPACITY * vis;

      const showTrail = this.trailMs > 0 && node.moving && node.vis > 0.001;
      node.trailGroup.visible = showTrail;
      if (showTrail) this.placeTrail(node);
      else for (let i = 0; i < node.trail.length; i += 1) node.trail[i].visible = false;
    }
  }

  /** 沿时间轴反向采样出拖尾：不早于 trailMs 窗口，且不跨越 jump（否则会拉出假轨迹）。 */
  private placeTrail(node: ObjectNode): void {
    const track = node.track;
    const trail = node.trail;
    if (!track || track.length < 2) {
      for (let i = 0; i < trail.length; i += 1) trail[i].visible = false;
      return;
    }
    const start = trailWindowStart(track, this.timeMs, this.trailMs);
    const offsets = this.trailOffsets;
    const span = TRAIL_HEAD_SCALE - TRAIL_TAIL_SCALE;
    const unit = OBJECT_RADIUS * DOT_SCALE;
    for (let i = 0; i < trail.length; i += 1) {
      const sprite = trail[i];
      const tt = this.timeMs + offsets[i];
      if (tt < start) {
        sprite.visible = false;
        continue;
      }
      sampleTrackAt(track, tt, this.tmp);
      sprite.position.set(this.tmp.x, this.tmp.z, -this.tmp.y);
      const k = trail.length > 1 ? 1 - i / (trail.length - 1) : 1;
      sprite.scale.setScalar(unit * (TRAIL_TAIL_SCALE + span * k));
      sprite.visible = true;
    }
  }

  private createNode(key: string): ObjectNode {
    // 哑光色：饱和 0.85、明度 0.62 —— 蓝紫色系内凭色相区分对象，但不互相抢戏
    const color = new THREE.Color().setHSL(hueFromKey(key) / 360, MARKER_SAT, MARKER_LIGHT);
    // 亮核：加色混合，transparent 常开以便活动门控逐帧改 opacity
    const dotMat = new THREE.SpriteMaterial({
      map: this.dotTexture,
      color,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dot = new THREE.Sprite(dotMat);
    dot.renderOrder = 2;
    dot.scale.setScalar(OBJECT_RADIUS * DOT_SCALE);

    // 外圈雾：同贴图、更大更淡，把亮核裹进一层宽晕
    const haloMat = new THREE.SpriteMaterial({
      map: this.dotTexture,
      color,
      transparent: true,
      opacity: HALO_OPACITY,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.renderOrder = 2;
    halo.scale.setScalar(OBJECT_RADIUS * DOT_SCALE * HALO_SCALE);

    const root = new THREE.Group();
    root.add(halo);
    root.add(dot);

    // 拖尾 sprite 独立挂在场景上（不挂在 root 下，否则会跟着 root 的屏幕尺寸缩放二重放大）
    const trailMat = new THREE.SpriteMaterial({
      map: this.dotTexture,
      color,
      transparent: true,
      opacity: TRAIL_OPACITY,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const trailGroup = new THREE.Group();
    const trail: THREE.Sprite[] = [];
    for (let i = 0; i < TRAIL_SAMPLES; i += 1) {
      const blob = new THREE.Sprite(trailMat);
      blob.renderOrder = 2;
      blob.visible = false;
      trailGroup.add(blob);
      trail.push(blob);
    }
    trailGroup.visible = false;
    this.scene.add(trailGroup);

    return {
      root,
      dotMat,
      haloMat,
      trail,
      trailGroup,
      trailMat,
      moving: false,
      vis: 1,
      activity: null,
    };
  }
}
