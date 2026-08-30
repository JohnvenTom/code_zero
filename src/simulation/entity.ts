import { Quaternion, Vector3 } from 'three';
import type {
  AircraftData,
  EnemyAIState,
  FlareData,
  FlaresData,
  GunData,
  HealthData,
  MissileData,
  MissilesData,
  ProjectileData,
  SpecialWeaponPod,
  WingmanAIState,
} from './components';

/**
 * 实体类别
 * - aircraft：飞行器（玩家/敌机/僚机共用，归属由 variant 与状态组件区分）
 * - projectile：弹药（机炮弹丸/导弹）
 * - ground-target：地面/海面目标
 * - effect：瞬时效果（爆炸、干扰弹等）
 */
export type EntityKind = 'aircraft' | 'projectile' | 'ground-target' | 'effect';

/**
 * 实体变体标记（同一类别下的外观/归属细分，渲染层据此选择网格）
 */
export type EntityVariant =
  | 'player'
  | 'enemy'
  | 'wingman'
  | 'practice-target'
  | 'tracer'
  | 'missile'
  | 'flare'
  | 'bomber'
  | 'ground-target-entity'
  | 'ally';

/**
 * 模拟实体：纯数据状态容器
 *
 * 功能：承载一个游戏实体的全部模拟状态（位置/姿态/速度/存活标记），
 * 并保存上一固定步的状态快照供渲染层插值。
 * 注意事项：本类严禁持有任何 Three.js 场景对象（Mesh/Object3D/Scene），
 * 渲染表现统一由 render 层的 RenderBridge 负责映射；
 * 项目姿态约定：前向 = 本体 -Z 轴（与 three 相机前向约定一致）。
 */
export class SimEntity {
  /** 实体唯一 ID（由 SimulationWorld 分配） */
  readonly id: number;
  /** 实体类别 */
  readonly kind: EntityKind;
  /** 当前固定步位置（米，世界坐标） */
  readonly position: Vector3;
  /** 当前固定步姿态（四元数，前向 = -Z） */
  readonly quaternion: Quaternion;
  /** 上一固定步位置（渲染插值用） */
  readonly prevPosition: Vector3;
  /** 上一固定步姿态（渲染插值用） */
  readonly prevQuaternion: Quaternion;
  /** 速度向量（米/秒，世界坐标） */
  readonly velocity: Vector3;
  /** 存活标记；false 表示待渲染层移除并回收 */
  alive: boolean;
  /** 实体变体标记（渲染层选择网格外观的纯数据标签；undefined 表示类别默认外观） */
  variant: EntityVariant | undefined;
  /** 战机飞行数据组件（仅飞行器实体持有） */
  aircraft: AircraftData | undefined;
  /** 生命值组件（可被击毁的实体持有：靶标/敌机等） */
  health: HealthData | undefined;
  /** 机炮组件（具备机炮武器的实体持有） */
  gun: GunData | undefined;
  /** 弹丸数据组件（仅弹丸实体持有） */
  projectile: ProjectileData | undefined;
  /** 导弹挂载组件（具备导弹武器的飞机实体持有） */
  missiles: MissilesData | undefined;
  /** 导弹弹体组件（仅导弹弹体实体持有） */
  missile: MissileData | undefined;
  /** 干扰弹挂载组件（具备干扰弹的飞机实体持有） */
  flares: FlaresData | undefined;
  /** 干扰弹弹体组件（仅干扰弹实体持有） */
  flare: FlareData | undefined;
  /** 敌机 AI 状态组件（仅敌机实体持有） */
  ai: EnemyAIState | undefined;
  /** 特殊武器挂载组件（仅玩家实体持有） */
  specialPod: SpecialWeaponPod | undefined;
  /** 僚机 AI 状态组件（仅僚机实体持有） */
  wingman: WingmanAIState | undefined;
  /** 弹丸范围伤害半径（米；undefined=单体命中。集束破片用） */
  blastRadius: number | undefined;
  /** 机型标识（敌机/轰炸机的虚构型号名，HUD 锁定框显示用） */
  designation: string | undefined;

  /**
   * 构造模拟实体
   *
   * @param id 实体唯一 ID
   * @param kind 实体类别
   * @param position 初始位置（米），内部拷贝存储
   * @param quaternion 初始姿态，内部拷贝存储；缺省为单位姿态
   */
  constructor(id: number, kind: EntityKind, position: Vector3, quaternion: Quaternion = new Quaternion()) {
    this.id = id;
    this.kind = kind;
    this.position = position.clone();
    this.quaternion = quaternion.clone();
    this.prevPosition = position.clone();
    this.prevQuaternion = quaternion.clone();
    this.velocity = new Vector3();
    this.alive = true;
    this.variant = undefined;
    this.aircraft = undefined;
    this.health = undefined;
    this.gun = undefined;
    this.projectile = undefined;
    this.missiles = undefined;
    this.missile = undefined;
    this.flares = undefined;
    this.flare = undefined;
    this.ai = undefined;
    this.specialPod = undefined;
    this.wingman = undefined;
    this.blastRadius = undefined;
    this.designation = undefined;
  }

  /**
   * 将当前状态快照到 prev* 字段
   *
   * 功能：每个固定步积分开始前调用，为渲染插值保留上一固定步的状态
   * 参数：无
   * 返回值：void
   * 异常：无
   * 注意事项：必须在位置/姿态被本步积分修改之前调用，否则插值基准错误
   */
  snapshotPrev(): void {
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
  }
}
