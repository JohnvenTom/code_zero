import {
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { campaignMission1, gameConfig } from '../../config';

/** 任务配置的模块级引用（昼夜进度按任务时间/总时长） */
const missionCfg = campaignMission1;

/** 实体云共享材质（受光照/雾影响，昼夜氛围自动染色） */
let cloudMaterial: MeshStandardMaterial | null = null;

/** 实体云 Mesh（位置/漂移速度） */
interface CloudMesh {
  /** 云团网格（多球体合并几何） */
  readonly mesh: Mesh;
  /** 水平漂移速度（m/s，世界 X 向） */
  readonly driftSpeed: number;
}

/**
 * 生成单朵云团的合并几何
 *
 * 功能：以低分段二十面体球堆叠成扁平整块云——主球居中 +
 * count 个子球沿椭圆散布（x 宽 z 窄 y 压低），全部平移后
 * merge 为单一 BufferGeometry（一朵云一个 draw call）
 * @param baseRadius 主球半径（米）
 * @param count 子球数量
 * @param seed 每朵云的随机因子（由调用方递增保证形态差异）
 * @returns 合并后的云团几何（世界原点为中心）
 * 异常：无
 * 注意事项：仅用 IcosahedronGeometry(r, 1)（80 面），
 * flatShading 呈现低模积云观感；几何不共享（每朵独立）
 */
function createCloudGeometry(baseRadius: number, count: number, seed: number): BufferGeometry {
  // 简易确定性伪随机（seed 驱动，形态稳定）
  let state = Math.floor(seed * 9301 + 49297) % 233280;
  const random = (): number => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };

  const parts: IcosahedronGeometry[] = [];
  // 主球
  const main = new IcosahedronGeometry(baseRadius, 1);
  main.scale(1, 0.42, 0.72);
  parts.push(main);

  // 子球：沿 x 长轴散布，形成绵延云底
  for (let i = 0; i < count; i++) {
    const radius = baseRadius * (0.45 + random() * 0.4);
    const blob = new IcosahedronGeometry(radius, 1);
    blob.scale(1, 0.4 + random() * 0.15, 0.65 + random() * 0.3);
    const angle = random() * Math.PI * 2;
    const spread = baseRadius * (0.55 + random() * 1.15);
    blob.translate(
      Math.cos(angle) * spread,
      (random() - 0.35) * baseRadius * 0.28,
      Math.sin(angle) * spread * 0.55,
    );
    parts.push(blob);
  }

  return mergeGeometries(parts)!;
}

/**
 * 创建多层实体几何云层
 *
 * 功能：三层高度带（低 900m / 中 1600m / 高 2600m）分布共
 * count 朵几何实体云——每朵由 6-10 个低分段球体堆叠合并为
 * 单一网格（一朵一个 draw call），共享一个受光照的
 * MeshStandardMaterial（昼夜氛围变化自动染色）；
 * 云环绕战场中心 ±9km 铺开并缓慢漂移
 * @param count 云朵总数（缺省 66）
 * @returns 云层组与云 Mesh 列表（漂移更新用）
 * 异常：无
 * 注意事项：材质为模块级单例（全云共享，黄昏时被日光/
 * 半球光自然染色）；远景雾效自动衰减云的存在感；
 * 每朵云约 7×80≈560 三角形，66 朵≈3.7 万面，性能无压力
 */
export function createClouds(count: number = 66): {
  group: Group;
  clouds: CloudMesh[];
} {
  const group = new Group();
  if (cloudMaterial === null) {
    cloudMaterial = new MeshStandardMaterial({
      color: 0xf2f6f9,
      flatShading: true,
      roughness: 1,
      metalness: 0,
    });
  }
  const clouds: CloudMesh[] = [];

  // 三层高度带与各层参数：[高度, 主球尺度区间, 数量占比]
  const layers: readonly [number, readonly [number, number], number][] = [
    [900, [130, 210], 0.3],
    [1600, [190, 300], 0.4],
    [2600, [260, 400], 0.3],
  ];

  let cloudIndex = 0;
  for (const [altitude, [minRadius, maxRadius], ratio] of layers) {
    const layerCount = Math.max(1, Math.round(count * ratio));
    for (let i = 0; i < layerCount; i++) {
      cloudIndex += 1;
      const baseRadius = minRadius + Math.random() * (maxRadius - minRadius);
      const geometry = createCloudGeometry(baseRadius, 6 + Math.floor(Math.random() * 4), cloudIndex * 1.618 + i);
      const mesh = new Mesh(geometry, cloudMaterial);
      // 环形随机分布（避开机场正上空低空区，减少起飞干扰）
      const angle = Math.random() * Math.PI * 2;
      const radius = 1400 + Math.random() * 7600;
      mesh.position.set(
        Math.cos(angle) * radius,
        altitude + (Math.random() * 2 - 1) * 160,
        Math.sin(angle) * radius,
      );
      group.add(mesh);
      clouds.push({ mesh, driftSpeed: 3 + Math.random() * 5 });
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
 * 营造任务由白昼推进至黄昏的氛围变化；
 * 实体几何云受光照渲染，黄昏时自动被暖色光染色
 * 注意事项：光照/雾/天空对象由 createScene 创建后注入本控制器，
 * 本类不创建场景对象；progress 钳制 0..1
 */
export class AtmosphereController {
  /** 云层列表（漂移用） */
  private readonly clouds: CloudMesh[];
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
    clouds: CloudMesh[],
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
      cloud.mesh.position.x += cloud.driftSpeed * dtc;
      if (cloud.mesh.position.x > 9000) {
        cloud.mesh.position.x = -9000;
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
