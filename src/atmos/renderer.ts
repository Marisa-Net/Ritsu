import * as THREE from "three";
import {
  ACTIVITY_WINDOW_MS,
  type AdmKeyframe,
  type AdmObject,
  type AtmosRoomShape,
  type AtmosViewOptions,
} from "../types";
import { levelAt, visibilityAt } from "./activity";
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

// 单位球半径 = ADM 距离 1；对象小球半径（世界单位，固定值）。
// 房间缩到 ADM 尺度后取景距离同步变近，半径按同比例缩小才能保持上一版的屏幕观感（约 9.2px）。
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
const ROOM_COLOR = 0xc06bff;
const ROOM_LINE_OPACITY = 0.5;
// 赤道是球形空间里唯一有含义的结构线（听者平面），单独给更高的不透明度
const LISTENER_COLOR = 0x9fb0c4;
const LISTENER_OPACITY = 0.32;

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
const SPHERE_MERIDIANS = 16; // 每 22.5° 一条经线（8 条太稀，鼓包读不出来）
const SPHERE_PARALLELS = 6; // 纬线分段：越多鼓包越圆滑

// 标记与光晕
const MARKER_SAT = 0.85;
const MARKER_LIGHT = 0.58;
const HALO_SCALE = 4.5; // 相对小球半径
const HALO_OPACITY = 0.5;

// 辉光轨迹：6 个同材质 sprite 沿时间轴反向采样，只做尺寸渐隐（共享材质 → 每节点多 1 个材质）
// ponytail: 逐点 alpha 需要自定义 shader，这里尺寸渐隐 + 加色叠加已够像彗尾；要更细腻再上 Points + shader
const TRAIL_SAMPLES = 6;
const TRAIL_HEAD_SCALE = 2.6;
const TRAIL_TAIL_SCALE = 0.6;
const TRAIL_OPACITY = 0.22;
const DEFAULT_TRAIL_MS = 500;

// 房间粒子：微尘，不是星空——冷灰、极低不透明度、普通混合（不用加色）
const PARTICLE_COUNT = 240;
const PARTICLE_SEED = 0x5eed;
const PARTICLE_COLOR = 0x8b9aac;
const PARTICLE_OPACITY = 0.24;
const PARTICLE_RADIUS_FRAC = 0.0055;

// 声场驱动（ADM → 球壳定向鼓包）：CPU 侧把最强的几个对象归并成固定数量的方向槽，
// 顶点着色器按 dot(方向法线, 声源方向)^pow 推出球面。多源同时发声时鼓包自然叠加。
// ponytail: 固定槽位，超出时最弱的声源被丢弃；要全量得改成纹理传参。
const MAX_SOURCES = 6;
const BULGE_POW = 4;
const BULGE_AMP = 0.22;
// 强度平滑：时间线 100ms 一窗，取近几窗均值抹平抖动。
// 纯 timeMs 函数（不做帧间低通——那会让预览与离线导出对不上）。
const LEVEL_SMOOTH_WINDOWS = 3;

// 对象随发声强度呼吸：本体尺寸与光晕共用同一个 level
const BODY_MIN = 0.82;
const BODY_GAIN = 0.34;
const HALO_MIN = 0.6;
const HALO_GAIN = 0.8;

const ROOM_HALF_H = (ROOM_TOP_Y - FLOOR_Y) / 2;

type ObjectNode = {
  root: THREE.Mesh;
  materials: THREE.Material[];
  trail: THREE.Sprite[];
  trailGroup: THREE.Group;
  track?: AdmKeyframe[];
  /** 关键帧是否真的在动：静态对象不建拖尾（省 6 个 sprite 的绘制） */
  moving: boolean;
  /** 活动门控可见度（不含深度明暗） */
  vis: number;
  /** 发声强度 0..1（窗内 RMS 平滑后），驱动本体尺寸/光晕/球壳鼓包 */
  level: number;
  /** 发声活动位图（100ms/窗，随声道绑定取自解码期时间线）；null = 始终发声 */
  activity: Uint8Array | null;
};

// id/name → 稳定色相；末乘黄金角，让相邻 id（AO_1001 / AO_1002）色相拉开
function hueFromKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360;
  return (h * 137.508) % 360;
}

// 中空环状白色光晕贴图（加色混合）：中心 alpha=0，小球本色从中心透出；
// 能量集中在半径中段（约 1.25 倍小球半径处，正好落在小球轮廓外侧），内外两侧平滑衰减，无硬环边。
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("AtmosRenderer: 2D canvas context unavailable");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.22, "rgba(255,255,255,0.10)");
  gradient.addColorStop(0.42, "rgba(255,255,255,0.30)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.34)");
  gradient.addColorStop(0.72, "rgba(255,255,255,0.15)");
  gradient.addColorStop(0.88, "rgba(255,255,255,0.04)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
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

// 球形空间壳：把声源方向投射到球面做定向鼓包。
// 球面上 normalize(position) 就是法线，权重 dot(dir)^pow 让鼓包集中在声源那一侧。
// 盒形房间仍用普通线条材质（盒子没有法线，且强透视下鼓起反而读不出方位）。
const SHELL_VERT = `
uniform vec3 uDir[${MAX_SOURCES}];
uniform float uEnergy[${MAX_SOURCES}];
uniform float uAmp;
varying float vPush;
void main() {
  vec3 dir = normalize(position);
  float push = 0.0;
  for (int i = 0; i < ${MAX_SOURCES}; i++) {
    push += pow(max(dot(dir, uDir[i]), 0.0), ${BULGE_POW}.0) * uEnergy[i];
  }
  // 多源叠加会超过 1：夹住，保证最坏情况也不超过取景用的 (1 + BULGE_AMP) 半径
  push = min(push, 1.0);
  // 鼓得越厉害越亮：扁平画风下靠亮度而不是立体光影读方位
  vPush = push;
  vec3 p = position + dir * push * uAmp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const SHELL_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vPush;
void main() {
  // 鼓得越厉害越亮：扁平画风下靠亮度读方位，不靠立体光影
  float glow = 0.55 + 1.15 * vPush;
  gl_FragColor = vec4(uColor * glow, uOpacity * glow);
}
`;

function makeShellLines(positions: number[], material: THREE.ShaderMaterial): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(geometry, material);
}

export class AtmosRenderer {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly nodes = new Map<string, ObjectNode>();
  private readonly nodeList: ObjectNode[] = [];
  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly listener: THREE.Mesh;
  // 房间线框：形状可变（盒形/球形），由 rebuildRoom 重建；尺寸靠 scale 跟随 fitRadius
  private room: THREE.LineSegments;
  private equator: THREE.LineSegments | null = null;
  /** 球形壳的鼓包材质；盒形为 null（Equator 与外壳共用同一材质，一起鼓） */
  private shellMaterial: THREE.ShaderMaterial | null = null;
  /** 声源方向槽：uniform 数组直接持有这批 Vector3，每帧原地改写，不重新分配 */
  private readonly shellDirs: THREE.Vector3[] = [];
  private readonly shellEnergy: number[] = [];
  /** 与 shellEnergy 平行的权重，仅用于挑选最响的槽位 */
  private readonly shellWeight: number[] = [];
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
    for (let i = 0; i < MAX_SOURCES; i += 1) {
      this.shellDirs.push(new THREE.Vector3(0, 1, 0));
      this.shellEnergy.push(0);
      this.shellWeight.push(0);
    }
    this.sphereGeometry = new THREE.SphereGeometry(OBJECT_RADIUS, 16, 12);
    this.glowTexture = makeGlowTexture();

    // 原点听者标记：细环，标示听者位置；转平落在 XZ 平面（水平面），既不是音频对象也不是测距标尺
    this.listener = new THREE.Mesh(
      new THREE.TorusGeometry(0.063, 0.0088, 8, 40),
      new THREE.MeshBasicMaterial({
        color: LISTENER_COLOR,
        transparent: true,
        opacity: LISTENER_OPACITY,
        depthWrite: false,
      }),
    );
    this.listener.rotation.x = -Math.PI / 2;
    this.scene.add(this.listener);

    // 粒子的基座/参数在 rebuildRoom 里按形状填；这里先准备好缓冲与对象
    this.particleBase = new Float32Array(PARTICLE_COUNT * 3);
    this.particleParams = new Float32Array(PARTICLE_COUNT * 3);
    this.particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    this.particleGeometry = new THREE.BufferGeometry();
    this.particleGeometry.setAttribute("position", new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleMaterial = new THREE.PointsMaterial({
      map: this.glowTexture,
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
        for (const m of node.materials) m.dispose();
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
    this.room.scale.setScalar(this.roomScale);
    this.particles.scale.setScalar(this.roomScale);
    this.fitCamera(this.viewW, this.viewH);
    this.refreshParticles(this.timeMs);

    // setTime 用索引扫描，避免每帧分配迭代器/闭包
    this.nodeList.length = 0;
    for (const node of this.nodes.values()) {
      node.level = this.smoothLevel(node.activity, this.timeMs, ACTIVITY_WINDOW_MS);
      this.nodeList.push(node);
    }
    this.updateSoundField();
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
      // 强度独立于门控：门控只管藏不藏，强度一直跟着声场走
      node.level = this.smoothLevel(node.activity, currentTimeMs, ACTIVITY_WINDOW_MS);
      const track = node.track;
      if (track && track.length >= 2) {
        sampleTrackAt(track, currentTimeMs, this.tmp);
        node.root.position.set(this.tmp.x, this.tmp.z, -this.tmp.y);
      }
    }
    this.updateSoundField();
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
    // 对象节点：材质各自持有；球几何为所有节点共享，只释放一次
    for (const node of this.nodes.values()) {
      for (const m of node.materials) m.dispose();
      this.scene.remove(node.trailGroup);
    }
    this.nodes.clear();
    this.nodeList.length = 0;
    this.sphereGeometry.dispose();
    this.disposeRoom();
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    this.listener.geometry.dispose();
    (this.listener.material as THREE.Material).dispose();
    this.glowTexture.dispose();
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // ── 房间与粒子 ─────────────────────────────────────────

  private disposeRoom(): void {
    this.scene.remove(this.room);
    this.room.geometry.dispose();
    (this.room.material as THREE.Material).dispose();
    if (this.equator) {
      this.scene.remove(this.equator);
      this.equator.geometry.dispose();
      // 材质与外壳共用（球形的 ShaderMaterial）→ 由 this.room 那边释放，这里不能重复 dispose
      this.equator = null;
    }
  }

  /** 切换空间形状：重建线框 + 取景点集 + 粒子基座，然后重新取景。 */
  private rebuildRoom(): void {
    this.disposeRoom();
    if (this.roomShape === "sphere") {
      const globe = sphereRoomLines(SPHERE_RADIUS, SPHERE_MERIDIANS, SPHERE_PARALLELS);
      const shell = new THREE.ShaderMaterial({
        uniforms: {
          uDir: { value: this.shellDirs },
          uEnergy: { value: this.shellEnergy },
          uAmp: { value: BULGE_AMP },
          uColor: { value: new THREE.Color(ROOM_COLOR) },
          uOpacity: { value: ROOM_LINE_OPACITY },
        },
        vertexShader: SHELL_VERT,
        fragmentShader: SHELL_FRAG,
        transparent: true,
        depthWrite: false,
        // 加色混合：线条互相交叠处更亮，读起来像发光网格
        blending: THREE.AdditiveBlending,
      });
      this.shellMaterial = shell;
      this.room = makeShellLines(globe.lines, shell);
      // 赤道共用同一材质 → 跟壳一起鼓，不会浮在球面上
      this.equator = makeShellLines(globe.equator, shell);
      this.equator.scale.setScalar(this.roomScale);
      this.scene.add(this.equator);
    } else {
      this.shellMaterial = null;
      this.room = makeLineSegments(
        boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
        ROOM_LINE_OPACITY,
      );
      this.roomPoints = boxRoomPoints(ROOM_HALF_W, ROOM_HALF_D, FLOOR_Y, ROOM_TOP_Y);
    }
    this.room.scale.setScalar(this.roomScale);
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
      // 鼓包会把壳推出原半径 → 取景按最大鼓包后的半径算，否则鼓起侧会被裁掉
      // 按最大鼓包后的半径取景：鼓到极限也不出画
      const outer = SPHERE_RADIUS * (1 + BULGE_AMP) * this.roomScale;
      distance = fitDistanceForRadius(outer, FOV_DEG, aspect, FIT_MARGIN, TARGET_LATERAL);
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
  }

  /** 近几窗的强度均值：抹平 100ms 窗边界的跳变 */
  private smoothLevel(timeline: Uint8Array | null, tMs: number, windowMs: number): number {
    if (!timeline) return 1;
    let sum = 0;
    for (let i = 0; i < LEVEL_SMOOTH_WINDOWS; i += 1) {
      sum += levelAt(timeline, tMs - i * windowMs, windowMs);
    }
    return sum / LEVEL_SMOOTH_WINDOWS;
  }

  /**
   * 声场 → 球壳鼓包：按「可见度 × 强度」挑最响的几个方向写进 uniform 槽位，
   * 幅度取这些槽位的能量和（越响越鼓、越多人同时响越鼓）。
   * ponytail: 槽位插入排序在 6 个槽上做，节点多时是 O(N×6)；真要上百个对象再换成堆。
   */
  private updateSoundField(): void {
    const nodes = this.nodeList;
    const dirs = this.shellDirs;
    const energy = this.shellEnergy;
    const weight = this.shellWeight;
    for (let k = 0; k < MAX_SOURCES; k += 1) {
      weight[k] = 0;
      energy[k] = 0;
    }

    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const w = node.level * node.vis;
      if (w <= 0.001) continue;
      const px = node.root.position.x - CAMERA_TARGET.x;
      const py = node.root.position.y - CAMERA_TARGET.y;
      const pz = node.root.position.z - CAMERA_TARGET.z;
      const len = Math.hypot(px, py, pz);
      if (len < 1e-4) continue; // 正落在听者位置：没有方位可言
      let slot = MAX_SOURCES;
      while (slot > 0 && weight[slot - 1] < w) slot -= 1;
      if (slot >= MAX_SOURCES) continue;
      for (let k = MAX_SOURCES - 1; k > slot; k -= 1) {
        weight[k] = weight[k - 1];
        dirs[k].copy(dirs[k - 1]);
        energy[k] = energy[k - 1];
      }
      weight[slot] = w;
      dirs[slot].set(px / len, py / len, pz / len);
      energy[slot] = node.level;
    }
  }

  // ── 逐帧外观 ───────────────────────────────────────────

  /**
   * 每帧统一结算外观：活动可见度 → 小球 / 光晕 / 拖尾。位置变化与相机变化都走这里。
   * 小球用固定世界半径（与上一版一致），不随取景距离缩放。
   */
  private updateNodeLooks(): void {
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const vis = node.vis;

      node.root.visible = vis > 0.001;
      const body = node.materials[0] as THREE.MeshBasicMaterial;
      const halo = node.materials[1] as THREE.SpriteMaterial;
      const trailMat = node.materials[2] as THREE.SpriteMaterial;
      const level = node.level;
      body.opacity = vis;
      // 本体与光晕一起跟着发声强度胀缩（光晕是 root 的子节点，会一起被 root.scale 放大）
      node.root.scale.setScalar(BODY_MIN + BODY_GAIN * level);
      halo.opacity = HALO_OPACITY * vis * (HALO_MIN + HALO_GAIN * level);
      // 拖尾不吃深度明暗：否则尾端更暗，反而读不出运动方向
      trailMat.opacity = TRAIL_OPACITY * node.vis;

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
      sprite.scale.setScalar(OBJECT_RADIUS * (TRAIL_TAIL_SCALE + span * k));
      sprite.visible = true;
    }
  }

  private createNode(key: string): ObjectNode {
    // 哑光色：饱和压到 0.44、明度 0.63 —— 相邻对象仍凭色相可分辨，但不再互相抢戏
    const color = new THREE.Color().setHSL(hueFromKey(key) / 360, MARKER_SAT, MARKER_LIGHT);
    // transparent 常开：活动门控逐帧改 opacity（=1 时外观与不透明一致）
    const body = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const halo = new THREE.SpriteMaterial({
      map: this.glowTexture,
      color,
      transparent: true,
      opacity: HALO_OPACITY,
      depthTest: false, // 光晕始终叠在小球上，形成柔和外发光
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const root = new THREE.Mesh(this.sphereGeometry, body);
    const sprite = new THREE.Sprite(halo);
    sprite.scale.setScalar(OBJECT_RADIUS * HALO_SCALE);
    sprite.renderOrder = 1;
    root.add(sprite);

    // 拖尾 sprite 独立挂在场景上（不挂在 root 下，否则会跟着 root 的屏幕尺寸缩放二重放大）
    const trailMat = new THREE.SpriteMaterial({
      map: this.glowTexture,
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
      const dot = new THREE.Sprite(trailMat);
      dot.visible = false;
      trailGroup.add(dot);
      trail.push(dot);
    }
    trailGroup.visible = false;
    this.scene.add(trailGroup);

    return {
      root,
      materials: [body, halo, trailMat],
      trail,
      trailGroup,
      moving: false,
      vis: 1,
      level: 1,
      activity: null,
    };
  }
}