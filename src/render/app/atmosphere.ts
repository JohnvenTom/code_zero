import {
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { campaignMission1, gameConfig } from '../../config';

/** 任务配置的模块级引用（昼夜进度按任务时间/总时长） */
const missionCfg = campaignMission1;

/**
 * 生成程序化云团纹理
 *
 * 功能：在 256×256 画布上叠加多个径向渐变白斑形成一团柔和的云，
 * 输出为可复用的 CanvasTexture（多层云 Sprite 共享）
 * @param seed 随机种子（保证纹理确定性，可选）
 * @returns 云纹理（已设置线性过滤）
 * 异常：无
 * 注意事项：纹理为白色云团，实际色调由 SpriteMaterial.color 调制
 * （昼夜氛围变化时统一调色）
 */
function createCloudTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // 多个径向渐变白斑叠加成云团
  const blobs = 7;
  for (let i = 0; i < blobs; i++) {
    const cx = size * (0.3 + Math.random() * 0.4);
    const cy = size * (0.35 + Math.random() * 0.3);
    const radius = size * (0.12 + Math.random() * 0.16);
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.22)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/** 云层 Sprite（位置/尺度/漂移速度） */
interface CloudSprite {
  /** Sprite 对象 */
  readonly sprite: Sprite;
  /** 水平漂移速度（m/s，世界 X 向） */
  readonly driftSpeed: number;
}

/**
 * 创建多层云层
 *
 * 功能：三层高度带（低 900m / 中 1600m / 高 2600m）分布共
 * count 朵 billboard 云 Sprite——低层小而稀疏、高层大而绵延；
 * 云共享程序化纹理，环绕战场中心 ±9km 铺开
 * @param count 云朵总数（缺省 34）
 * @returns 云层组与 Sprite 列表（漂移更新用）
 * 异常：无
 * 注意事项：云材质关闭深度写入、开启透明，确保空战可读性；
 * 远景雾效会自然衰减云的存在感，无需额外剔除
 */
export function createClouds(count: number = 34): {
  group: Group;
  clouds: CloudSprite[];
} {
  const group = new Group();
  const texture = createCloudTexture();
  const clouds: CloudSprite[] = [];

  // 三层高度带与各层参数：[高度, 尺度区间, 数量占比]
  const layers: readonly [number, readonly [number, number], number][] = [
    [900, [380, 620], 0.3],
    [1600, [600, 950], 0.4],
    [2600, [900, 1400], 0.3],
  ];

  for (const [altitude, [minScale, maxScale], ratio] of layers) {
    const layerCount = Math.max(1, Math.round(count * ratio));
    for (let i = 0; i < layerCount; i++) {
      const material = new SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.42 + Math.random() * 0.2,
        depthWrite: false,
        fog: true,
      });
      const sprite = new Sprite(material);
      const scale = minScale + Math.random() * (maxScale - minScale);
      sprite.scale.set(scale, scale * 0.42, 1);
      // 环形随机分布（避开机场正上空低空区，减少起飞干扰）
      const angle = Math.random() * Math.PI * 2;
      const radius = 1200 + Math.random() * 7800;
      sprite.position.set(
        Math.cos(angle) * radius,
        altitude + (Math.random() * 2 - 1) * 160,
        Math.sin(angle) * radius,
      );
      group.add(sprite);
      clouds.push({ sprite, driftSpeed: 3 + Math.random() * 5 });
    }
  }

  return { group, clouds };
}

/** 正午光照预设（任务开始） */
const NOON_PRESET = {
  sunColor: new Color(0xfff4e0),
  sunIntensity: gameConfig.lighting.sunIntensity,
  hemiSky: new Color(gameConfig.lighting.hemiSkyColor),
  hemiIntensity: gameConfig.lighting.hemiIntensity,
  fogColor: new Color(gameConfig.sky.fogColor),
  skyTint: new Color(0xffffff),
};

/** 黄昏光照预设（任务后期） */
const DUSK_PRESET = {
  sunColor: new Color(0xff9c5a),
  sunIntensity: 1.05,
  hemiSky: new Color(0xd9a87c),
  hemiIntensity: 0.65,
  fogColor: new Color(0xd9b48f),
  skyTint: new Color(0xffc9a0),
};

/**
 * 大气控制器：云层漂移 + 昼夜光照氛围
 *
 * 功能：每渲染帧推进云层水平漂移；按任务进度（0..1）在正午与黄昏
 * 两套光照预设间平滑插值——调节日光颜色/强度与角度（太阳西沉）、
 * 半球光、雾色与天空穹顶色调（顶点色 × 材质色调制），
 * 营造任务由白昼推进至黄昏的氛围变化
 * 注意事项：光照/雾/天空对象由 createScene 创建后注入本控制器，
 * 本类不创建场景对象；progress 钳制 0..1
 */
export class AtmosphereController {
  /** 云层列表（漂移用） */
  private readonly clouds: CloudSprite[];
  /** 日光（注入） */
  private readonly sunLight: DirectionalLight;
  /** 半球光（注入） */
  private readonly hemiLight: HemisphereLight;
  /** 场景雾（注入） */
  private readonly fog: Fog;
  /** 天空穹顶（注入，材质 color 调制顶点色） */
  private readonly skyDome: Mesh;
  /** 插值复用颜色 */
  private readonly _color = new Color();
  /** 日光基准方向（正午） */
  private readonly sunBase = new Vector3(...gameConfig.lighting.sunDirection);
  /** 黄昏日光方向（太阳西沉低角度） */
  private readonly sunDusk = new Vector3(-5200, 1500, 2600);

  /**
   * 构造大气控制器
   *
   * @param clouds 云层列表（createClouds 返回）
   * @param sunLight 日光（createScene 返回）
   * @param hemiLight 半球光
   * @param fog 场景雾
   * @param skyDome 天空穹顶网格（MeshBasicMaterial + vertexColors）
   * 异常：无
   */
  constructor(
    clouds: CloudSprite[],
    sunLight: DirectionalLight,
    hemiLight: HemisphereLight,
    fog: Fog,
    skyDome: Mesh,
  ) {
    this.clouds = clouds;
    this.sunLight = sunLight;
    this.hemiLight = hemiLight;
    this.fog = fog;
    this.skyDome = skyDome;
  }

  /**
   * 每渲染帧推进大气
   *
   * 功能：云层沿世界 X 正向缓慢漂移（超界回绕）；按任务进度
   * 插值光照预设并更新日光方向/颜色/强度、半球光色/强度、
   * 雾色与天空穹顶色调
   * @param dt 帧间隔（秒）
   * @param missionProgress 任务进度 0..1（任务时间/总时限）
   * @returns void
   * 异常：无
   * 注意事项：任务未开始时 progress=0（正午氛围）；
   * 云漂移回绕半径 9000m 与战场边界一致
   */
  update(dt: number, missionProgress: number): void {
    // 云层漂移
    const dtc = Math.min(Math.max(dt, 0), 0.1);
    for (const cloud of this.clouds) {
      cloud.sprite.position.x += cloud.driftSpeed * dtc;
      if (cloud.sprite.position.x > 9000) {
        cloud.sprite.position.x = -9000;
      }
    }

    // 昼夜插值（任务后半程渐入黄昏）
    const t = Math.min(Math.max(missionProgress, 0), 1);
    const duskWeight = t < 0.5 ? 0 : (t - 0.5) / 0.5;

    this.sunLight.color.copy(NOON_PRESET.sunColor).lerp(DUSK_PRESET.sunColor, duskWeight);
    this.sunLight.intensity =
      NOON_PRESET.sunIntensity +
      (DUSK_PRESET.sunIntensity - NOON_PRESET.sunIntensity) * duskWeight;
    this.sunLight.position
      .copy(this.sunBase)
      .lerp(this.sunDusk, duskWeight);

    this.hemiLight.color.copy(NOON_PRESET.hemiSky).lerp(DUSK_PRESET.hemiSky, duskWeight);
    this.hemiLight.intensity =
      NOON_PRESET.hemiIntensity +
      (DUSK_PRESET.hemiIntensity - NOON_PRESET.hemiIntensity) * duskWeight;

    this.fog.color.copy(NOON_PRESET.fogColor).lerp(DUSK_PRESET.fogColor, duskWeight);

    // 天空穹顶：材质 color 与顶点色相乘整体调色
    const domeMaterial = this.skyDome.material;
    if (domeMaterial instanceof MeshBasicMaterial) {
      this._color.copy(NOON_PRESET.skyTint).lerp(DUSK_PRESET.skyTint, duskWeight);
      domeMaterial.color.copy(this._color);
    }
  }
}

/** 任务总时长导出（进度计算用，秒） */
export const MISSION_TOTAL_TIME = missionCfg.timeLimit;
