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
  fillParticles,
  fitDistanceForRadius,
  isMovingTrack,
  markerWorldRadius,
  mulberry32,
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
//    任何「累积型」动画都会让成片与预览不一致。粒子与星场有随机布局，用固定 seed 保证两次运行相同。
// 2. 所有形状与取景数值都在 geometry.ts 里算（那一侧不依赖 three，可在 CI 裸 Node 下自检）。
//
// 空间参照分三层（对齐官方 Atmos Visualizer 的观感）：
//   发光膜壳（房间本身，包住整个声场）+ 极暗线笼（ADM 边界，只当刻度）+ 星场（背景纵深）。

// 单位球半径 = ADM 距离 1；对象标记的基准尺寸（世界单位，固定值）。
const OBJECT_RADIUS = 0.063;
// 需完整入镜的包围球半径下限（单位球 + 光晕余量）
const FIT_RADIUS = 1.25;
// 相机方向：原点前左上方。方位角约 30°（偏画面左）、俯角约 20°，
// 形成两点透视——最近的竖直棱落在画面中心左侧，视线略向下但无侧倾（lookAt 默认 up）
const CAMERA_DIR = new THREE.Vector3(-0.47, 0.342, 0.814).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0.05, 0);
// 相机看向 CAMERA_TARGET 而非原点：球心相对画面轴的横向偏移。球形取景的解析解必须把它算进去，
// 否则球面一侧会被画幅切掉。
const TARGET_LATERAL = (() => {
  const t = CAMERA_TARGET.clone();
  t.addScaledVector(CAMERA_DIR, -t.dot(CAMERA_DIR));
  return t.length();
})();
const FOV_DEG = 40;
// 取景余量：贴边后再留 2% 呼吸空间
const FIT_MARGIN = 1.02;

// 房间：一团加色发光膜壳（对齐官方观感），ADM 边界另有一层极暗的线笼当刻度。
// 线笼只是参照物，亮度必须压在膜壳与对象之下，否则又变回上一版的「钢蓝灰盒子」。
const ROOM_COLOR = 0x77879b;
const ROOM_LINE_OPACITY = 0.13;
const EQUATOR_OPACITY = 0.2;
const LISTENER_COLOR = 0xc9d6ea;
const LISTENER_OPACITY = 0.5;

// 盒形 ADM 立方体（±1）+ 10% 余量：声床与对象的坐标顶到 ±1 时就贴着壁与角落。
const FLOOR_Y = -1.1;
const ROOM_TOP_Y = 1.1;
const ROOM_HALF_W = 1.1;
const ROOM_HALF_D = 1.1;
const GRID_COLS = 4;
const GRID_ROWS = 4;

// 球形 ADM 球 = 距离 1 + 10% 余量，与盒形同一套尺度。
// ponytail: 立方体角点位置（|p| > 1.1）会落在球外——球面本就不是立方体的外接面；
// 需要严格包含单位立方体时，把半径调回 √3 ≈ 1.8。
const SPHERE_RADIUS = 1.1;
const SPHERE_MERIDIANS = 8; // 每 45° 一条经线
const SPHERE_PARALLELS = 3; // → ±45° 两条纬线 + 赤道，稀疏得像地球仪而不是亮笼子

// 膜壳：半径 = 取景半径 × 它，也就是「房间」本身。相机按这层球面取景，
// 于是它永远刚好入镜、包住整个声场——官方画面正是这颗包着声场的气泡。
// 顶点由 3D 噪声起伏、片元用 fresnel 出边缘光，因此是有机的膜而不是玻璃球。
const MEMBRANE_INNER = new THREE.Color(0x4a2a9e);
const MEMBRANE_RIM = new THREE.Color(0xff63e0);
const MEMBRANE_RIM_POWER = 2.6;
const MEMBRANE_AMP = 0.075; // 噪声起伏幅度（相对半径）
const MEMBRANE_RADIUS_SCALE = 1;
const MEMBRANE_SEGMENTS_W = 128;
const MEMBRANE_SEGMENTS_H = 80;
// 线笼的顶点/球面落在膜壳半径的这个比例上：够大能当刻度，又不会戳穿膜壳
const ROOM_INNER_FRAC = 0.88;

// 对象标记：亮核 + 宽软晕 + 一圈细环（官方是「带环的行星」，不是裸圆点）。
const MARKER_SAT = 0.85;
const MARKER_LIGHT = 0.62;
const DOT_SCALE = 2.2; // sprite 边长 = OBJECT_RADIUS × 它；亮核约占边长 5%，晕一直铺到边缘
const HALO_SCALE = 3.5; // 外圈雾相对 dot 的倍数
const HALO_OPACITY = 0.2;
// 环 = 共享 Torus 几何（半径 1.05 / 管径 0.035），按 unit 缩放，倾角固定 → 透视下是薄椭圆
const RING_RADIUS = 1.05;
const RING_TUBE = 0.035;
const RING_TILT_X = -1.18;
const RING_TILT_Z = 0.3;
const RING_OPACITY = 0.75;

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

// 星场：铺满整个画面的背景纵深。放在一个大球壳上，关深度测试、最先绘制。
const STAR_COUNT = 560;
const STAR_SEED = 0x51a2;
const STAR_COLOR = 0xdbe4ff;
const STAR_OPACITY = 0.55;
const STAR_SIZE_FRAC = 0.0018;
const STAR_SHELL = 2.6; // 球壳半径 = 相机距离 × 它

// 房间粒子：膜壳内部的微尘——冷灰、极低不透明度、普通混合（不用加色）
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
  ringMat: THREE.MeshBasicMaterial;
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

// 膜壳着色器：顶点做 3D 正弦叠加噪声起伏，片元按 fresnel 出边缘光。
// 全部输入是 position / uTime / uEnergy，因此仍是 timeMs 的纯函数。
const MEMBRANE_VERT = `
uniform float uTime;
uniform float uEnergy;
uniform float uAmp;
varying float vNoise;
varying vec3 vNormalW;
varying vec3 vWorldPos;

// 三组不同频率的乘积正弦：便宜、连续、无纹理查表，起伏像被吹动的薄膜
float wobble(vec3 p, float t) {
  float n = sin(p.x * 2.7 + t * 0.70) * sin(p.y * 3.1 - t * 0.50) * sin(p.z * 2.3 + t * 0.60);
  n += 0.50 * sin(p.x * 5.3 - t * 1.10) * sin(p.y * 4.7 + t * 0.90) * sin(p.z * 6.1 - t * 0.80);
  n += 0.25 * sin(p.x * 9.1 + t * 1.70) * sin(p.y * 8.3 - t * 1.30) * sin(p.z * 10.7 + t * 1.50);
  return n;
}

void main() {
  vec3 dir = normalize(position);
  float n = wobble(dir, uTime * 0.35);
  // 声场能量越满，膜壳抖得越开
  float disp = 1.0 + n * uAmp * (0.55 + uEnergy * 0.90);
  vNoise = n;
  vec4 world = modelMatrix * vec4(dir * disp, 1.0);
  vWorldPos = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * dir);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const MEMBRANE_FRAG = `
uniform vec3 uInner;
uniform vec3 uRim;
uniform float uRimPower;
uniform float uEnergy;
varying float vNoise;
varying vec3 vNormalW;
varying vec3 vWorldPos;

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float facing = clamp(abs(dot(normalize(vNormalW), viewDir)), 0.0, 1.0);
  float fres = pow(1.0 - facing, uRimPower);
  // 内部：暗紫底 + 噪声带来的层次，能量越高越亮
  vec3 inner = uInner * (0.55 + 0.35 * vNoise + 0.45 * uEnergy);
  vec3 col = mix(inner, uRim, fres);
  // 中心薄、边缘厚：fresnel 那圈才是品红亮边
  float alpha = (0.09 + 0.16 * uEnergy) * (1.0 - 0.35 * facing) + fres * 0.80;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

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
  private readonly listener: THREE.Group;

  // 膜壳：几何/材质只建一次，半径靠 scale 跟随取景半径
  private readonly membrane: THREE.Mesh;
  private readonly membraneMat: THREE.ShaderMaterial;
  // 环：所有对象共享一份 Torus 几何，每个对象只多一个材质
  private readonly ringGeometry: THREE.BufferGeometry;
  // 星场：静态，不参与逐帧更新
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;

  // 房间线笼：形状可变（盒形/球形），由 rebuildRoom 重建
  private room: THREE.LineSegments;
  private equator: THREE.LineSegments | null = null;
  // 房间粒子：基座与参数一次算好，每帧只按 timeMs 重算位置
  private readonly particleGeometry: THREE.BufferGeometry;
  private readonly particleMaterial: THREE.PointsMaterial;
  private readonly particles: THREE.Points;
  private readonly particleBase: Float32Array;
  private readonly particleParams: Float32Array;
  private readonly particlePositions: Float32Array;
  private readonly tmp: Vec3Out = { x: 0, y: 0, z: 0 };

  private timeMs = 0;
  /** 声场能量 0..1：驱动膜壳起伏与边缘光强度（由每帧可见度聚合而来，仍是 timeMs 的函数） */
  private energy = 0.6;
  // 取景半径：按实际对象/关键帧范围计算，FIT_RADIUS 为下限
  private fitRadius = FIT_RADIUS;
  /** 膜壳半径（世界单位）= 取景半径 × MEMBRANE_RADIUS_SCALE */
  private membraneRadius = FIT_RADIUS;
  /** 线笼与粒子的缩放：让它们落在膜壳半径的 ROOM_INNER_FRAC 处 */
  private roomScale = 1;
  /** 相机到取景中心的距离 */
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

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 80);
    this.dotTexture = makeDotTexture();
    this.listenerTexture = makeListenerTexture();

    // 星场：单位球壳上均匀撒点（固定 seed），scale 在 fitCamera 里按取景距离放大。
    // depthTest 关掉 + 最先绘制 → 永远在最后面，不会被膜壳或对象挡出「穿帮」。
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const rand = mulberry32(STAR_SEED);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const u = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      starPositions[i * 3] = r * Math.cos(th);
      starPositions[i * 3 + 1] = u;
      starPositions[i * 3 + 2] = r * Math.sin(th);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      map: this.dotTexture,
      color: STAR_COLOR,
      size: 0.01,
      sizeAttenuation: true,
      transparent: true,
      opacity: STAR_OPACITY,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.stars.renderOrder = -2;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // 膜壳：单位球几何 + 顶点噪声位移，半径由 fitCamera 设置
    this.membraneMat = new THREE.ShaderMaterial({
      vertexShader: MEMBRANE_VERT,
      fragmentShader: MEMBRANE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: this.energy },
        uAmp: { value: MEMBRANE_AMP },
        uInner: { value: MEMBRANE_INNER },
        uRim: { value: MEMBRANE_RIM },
        uRimPower: { value: MEMBRANE_RIM_POWER },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.membrane = new THREE.Mesh(
      new THREE.SphereGeometry(1, MEMBRANE_SEGMENTS_W, MEMBRANE_SEGMENTS_H),
      this.membraneMat,
    );
    this.membrane.renderOrder = 1;
    this.membrane.position.copy(CAMERA_TARGET);
    this.membrane.frustumCulled = false;
    this.scene.add(this.membrane);

    this.ringGeometry = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 6, 96);

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
        node.ringMat.dispose();
        node.trailMat.dispose();
        this.nodes.delete(key);
      }
    }

    // 取景半径覆盖所有对象的静态点与全部关键帧轨迹
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
    // 膜壳就是取景的那层球面：对象云越散，气泡越大，相机同步后撤，画面密度不变。
    this.fitCamera(this.viewW, this.viewH);
    this.refreshParticles(this.timeMs);

    // setTime 用索引扫描，避免每帧分配迭代器/闭包
    this.nodeList.length = 0;
    for (const node of this.nodes.values()) this.nodeList.push(node);
    this.updateEnergy();
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
    this.updateEnergy();
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
    this.updateEnergy();
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
    // 对象节点：材质各自持有；贴图与环几何全局共享，统一在下面释放
    for (const node of this.nodes.values()) {
      node.dotMat.dispose();
      node.haloMat.dispose();
      node.ringMat.dispose();
      node.trailMat.dispose();
      this.scene.remove(node.trailGroup);
    }
    this.nodes.clear();
    this.nodeList.length = 0;
    this.disposeRoom();
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.ringGeometry.dispose();
    this.membrane.geometry.dispose();
    this.membraneMat.dispose();
    // 听者标记：环的几何独立，material 各自持有。中心光盘是 Sprite（children[1]），
    // 它的 geometry 是 three 内部所有 Sprite 共享的同一份三角形，dispose 会打断之后新建的任何 Sprite。
    (this.listener.children[0] as THREE.Mesh).geometry.dispose();
    for (const child of this.listener.children) {
      const mat = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) mat.dispose();
    }
    this.dotTexture.dispose();
    this.listenerTexture.dispose();
    this.renderer.dispose();
    // ponytail: 只释放 renderer；若频繁创建/销毁实例（浏览器 GL 上下文上限 ~16），再加 forceContextLoss()
  }

  // ── 房间与粒子 ─────────────────────────────────────────

  /** 线笼 / 赤道 / 粒子统一按 roomScale 缩放，使它们落在膜壳内侧的固定比例处。 */
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

  /** 切换线笼形状：重建线段 + 粒子基座，然后重新取景。膜壳不吃形状（它永远是球）。 */
  private rebuildRoom(): void {
    this.disposeRoom();
    if (this.roomShape === "sphere") {
      const globe = sphereRoomLines(SPHERE_RADIUS, SPHERE_MERIDIANS, SPHERE_PARALLELS);
      this.room = makeLineSegments(globe.lines, ROOM_LINE_OPACITY);
      this.equator = makeLineSegments(globe.equator, EQUATOR_OPACITY);
      this.scene.add(this.equator);
    } else {
      this.room = makeLineSegments(
        boxRoomLines(ROOM_HALF_W, ROOM_HALF_D, GRID_COLS, GRID_ROWS, FLOOR_Y, ROOM_TOP_Y),
        ROOM_LINE_OPACITY,
      );
    }
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

  /**
   * 声场能量：取所有对象当前可见度的均值。可见度由声道活动位图算出，
   * 所以这条曲线就是「此刻有多少对象在发声」，仍是 timeMs 的纯函数。
   * 门控关闭或没有位图时退回一个确定性的缓慢呼吸，避免膜壳死成一张静态图。
   */
  private updateEnergy(): void {
    const nodes = this.nodeList;
    if (this.activityEnabled && nodes.length > 0) {
      let sum = 0;
      for (let i = 0; i < nodes.length; i += 1) sum += nodes[i].vis;
      this.energy = sum / nodes.length;
    } else {
      this.energy = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(this.timeMs * 0.0009));
    }
    this.membraneMat.uniforms.uEnergy.value = this.energy;
    this.membraneMat.uniforms.uTime.value = this.timeMs / 1000;
  }

  // ── 取景 ───────────────────────────────────────────────

  /**
   * 按宽高比沿视线后移相机，让膜壳（= 房间本身）完整入镜。
   * 透视下可见轮廓是切线圆，所以用解析解（fitDistanceForRadius），把球心的横向偏移算进去。
   */
  private fitCamera(width: number, height: number): void {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    this.camera.aspect = aspect;

    this.membraneRadius = this.fitRadius * MEMBRANE_RADIUS_SCALE;
    const distance = fitDistanceForRadius(
      this.membraneRadius,
      FOV_DEG,
      aspect,
      FIT_MARGIN,
      TARGET_LATERAL,
    );
    this.cameraDistance = Math.max(distance, FIT_RADIUS);
    this.camera.position.copy(CAMERA_DIR).multiplyScalar(this.cameraDistance);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();

    this.membrane.scale.setScalar(this.membraneRadius);

    // 线笼 / 粒子的缩放：顶点（盒形取角点、球形取球面）落到膜壳半径的 ROOM_INNER_FRAC 处
    const innerExtent =
      this.roomShape === "sphere" ? SPHERE_RADIUS : ROOM_HALF_W * Math.sqrt(3);
    this.roomScale = (this.membraneRadius * ROOM_INNER_FRAC) / innerExtent;
    this.applyRoomScale();

    // 星场：球壳放在相机之外很远，尺寸按壳距换算 → 屏幕上是恒定的微尘
    const shellDistance = this.cameraDistance * STAR_SHELL;
    this.stars.scale.setScalar(shellDistance);
    this.starMaterial.size = markerWorldRadius(STAR_SIZE_FRAC, FOV_DEG, shellDistance);

    // 粒子屏幕尺寸随取景距离：微尘在放大后的房间里依旧是同样的视觉大小
    this.particleMaterial.size = markerWorldRadius(PARTICLE_RADIUS_FRAC, FOV_DEG, this.cameraDistance);
  }

  // ── 逐帧外观 ───────────────────────────────────────────

  /**
   * 每帧统一结算外观：活动可见度 → 亮核 / 外圈雾 / 细环 / 拖尾。位置变化与相机变化都走这里。
   * 标记用固定世界尺寸，不随取景距离缩放。
   */
  private updateNodeLooks(): void {
    const nodes = this.nodeList;
    for (let n = 0; n < nodes.length; n += 1) {
      const node = nodes[n];
      const vis = node.vis;

      node.root.visible = vis > 0.001;
      node.dotMat.opacity = vis;
      node.haloMat.opacity = HALO_OPACITY * vis;
      node.ringMat.opacity = RING_OPACITY * vis;
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

    // 细环：官方对象是「带环行星」——一圈与球核分离的薄环，透视下自然成椭圆。
    // 几何共享（this.ringGeometry 半径 1.05/管径 0.035），这里只按 unit 缩放。
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: RING_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(this.ringGeometry, ringMat);
    ring.renderOrder = 2;
    ring.rotation.x = RING_TILT_X;
    ring.rotation.z = RING_TILT_Z;
    ring.scale.setScalar(OBJECT_RADIUS * DOT_SCALE);

    const root = new THREE.Group();
    root.add(ring);
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
      ringMat,
      trail,
      trailGroup,
      trailMat,
      moving: false,
      vis: 1,
      activity: null,
    };
  }
}
