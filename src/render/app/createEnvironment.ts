import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import { gameConfig } from '../../config';

/** 环境配置的模块级引用 */
const cfg = gameConfig.environment;

/** createEnvironment 返回结构 */
export interface EnvironmentBundle {
  /** 静态环境对象组（地面/跑道/边界立柱），一次性加入场景 */
  readonly group: Group;
}

/**
 * mulberry32 确定性伪随机数生成器
 *
 * 功能：以整数种子初始化的可复现 PRNG，保证地面色块纹理每次生成一致
 * @param seed 随机种子
 * @returns 返回 0..1 均匀分布随机数的函数
 * 异常：无
 * 注意事项：仅用于程序化纹理等视觉确定性场景，不用于模拟逻辑
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 数字颜色转 CSS 颜色字符串
 *
 * @param color 0xRRGGBB 数字颜色
 * @returns '#rrggbb' 字符串
 * 异常：无
 */
function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * 生成地面色块纹理
 *
 * 功能：在 1024×1024 画布上以种子随机绘制草地/耕地/沙地色块，
 * 并在配置的椭圆区域绘制水面，形成俯视可读的战场地面拼图
 * @returns 地面纹理（已设置 sRGB 色彩空间与各向异性过滤）
 * 异常：无
 * 注意事项：纹理映射到 groundSize 米见方的平面，
 * 单个色块对应数百米尺度，符合高空俯瞰的街机观感
 */
function createGroundTexture(): CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // 基底
  ctx.fillStyle = cssColor(cfg.groundBaseColor);
  ctx.fillRect(0, 0, size, size);

  // 色块拼图（带随机旋转的圆角矩形近似战场分区）
  const random = mulberry32(cfg.groundSeed);
  for (let i = 0; i < cfg.groundPatchCount; i++) {
    const paletteIndex = Math.floor(random() * cfg.groundPatchColors.length);
    const color = cfg.groundPatchColors[paletteIndex] ?? cfg.groundBaseColor;
    ctx.fillStyle = cssColor(color);
    ctx.globalAlpha = 0.45 + random() * 0.35;
    const w = 60 + random() * 180;
    const h = 60 + random() * 180;
    const x = random() * size;
    const y = random() * size;
    const rotation = random() * Math.PI;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // 水面椭圆区域（后绘制以覆盖其上的色块），叠一圈浅色岸线
  const [cx, cy] = cfg.waterCenter;
  const [rx, ry] = cfg.waterRadius;
  ctx.fillStyle = cssColor(cfg.waterColor);
  ctx.beginPath();
  ctx.ellipse(cx * size, cy * size, rx * size, ry * size, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(214, 226, 220, 0.5)';
  ctx.lineWidth = 6;
  ctx.stroke();

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * 生成跑道纹理
 *
 * 功能：绘制沥青底色、两侧边线、中央虚线与两端入口斑马条，
 * 形成 60×1400 米跑道的外观
 * @returns 跑道纹理（画布纵横比与跑道长宽比一致，约 2 像素/米）
 * 异常：无
 * 注意事项：画布尺寸 128×2800，纵向即世界 -Z 方向
 */
function createRunwayTexture(): CanvasTexture {
  const width = 128;
  const height = 2800;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // 沥青底 + 轻微颗粒噪点
  ctx.fillStyle = '#33383d';
  ctx.fillRect(0, 0, width, height);
  const random = mulberry32(cfg.groundSeed + 1);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + random() * 0.04})`;
    ctx.fillRect(random() * width, random() * height, 2, 2);
  }

  // 两侧边线
  ctx.fillStyle = 'rgba(240, 240, 235, 0.85)';
  ctx.fillRect(6, 0, 4, height);
  ctx.fillRect(width - 10, 0, 4, height);

  // 中央虚线：30 米划线 + 20 米间隔（约 2 像素/米）
  const dash = 60;
  const gap = 40;
  for (let y = 100; y < height - 100; y += dash + gap) {
    ctx.fillRect(width / 2 - 2, y, 4, dash);
  }

  // 两端入口斑马条（8 条）
  ctx.fillStyle = 'rgba(240, 240, 235, 0.85)';
  const thresholdMarks = 8;
  const markWidth = 8;
  const markHeight = 80;
  const spanStart = 18;
  const spanEnd = width - 18 - markWidth;
  for (let i = 0; i < thresholdMarks; i++) {
    const x = spanStart + ((spanEnd - spanStart) * i) / (thresholdMarks - 1);
    ctx.fillRect(x, 24, markWidth, markHeight);
    ctx.fillRect(x, height - 24 - markHeight, markWidth, markHeight);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * 创建战场环境（地面/跑道/边界提示）
 *
 * 功能：按配置组装静态环境组——
 * 1) 大地面平面（色块纹理 + 水面区域）；
 * 2) 沿 Z 轴居中的跑道（略抬升避免与地面深度冲突）；
 * 3) 战场边界环形分布的发光立柱（提示玩家活动范围）
 * 参数：无（参数来自 gameConfig.environment）
 * 返回值：环境对象组
 * 异常：无
 * 注意事项：环境为静态装饰，不参与模拟；地面高度约定为 y=0，
 * 模拟层的坠地判定与该约定一致
 */
export function createEnvironment(): EnvironmentBundle {
  const group = new Group();

  // 地面
  const ground = new Mesh(
    new PlaneGeometry(cfg.groundSize, cfg.groundSize),
    new MeshStandardMaterial({ map: createGroundTexture(), roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  // 跑道（抬升 0.5 米避免与地面平面深度冲突）
  const runway = new Mesh(
    new PlaneGeometry(cfg.runwayWidth, cfg.runwayLength),
    new MeshStandardMaterial({ map: createRunwayTexture(), roughness: 0.9, metalness: 0 }),
  );
  runway.rotation.x = -Math.PI / 2;
  runway.position.y = 0.5;
  group.add(runway);

  // 战场边界立柱：环形均布的半透明发光柱
  const pillarGeometry = new CylinderGeometry(
    cfg.boundaryPillarRadius,
    cfg.boundaryPillarRadius,
    cfg.boundaryPillarHeight,
    6,
  );
  const pillarMaterial = new MeshStandardMaterial({
    color: 0x201810,
    emissive: cfg.boundaryPillarColor,
    emissiveIntensity: 0.9,
    transparent: true,
    opacity: cfg.boundaryPillarOpacity,
    depthWrite: false,
  });
  for (let i = 0; i < cfg.boundaryPillarCount; i++) {
    const angle = (Math.PI * 2 * i) / cfg.boundaryPillarCount;
    const pillar = new Mesh(pillarGeometry, pillarMaterial);
    pillar.position.set(
      Math.cos(angle) * cfg.boundaryRadius,
      cfg.boundaryPillarHeight / 2,
      Math.sin(angle) * cfg.boundaryRadius,
    );
    group.add(pillar);
  }

  return { group };
}
