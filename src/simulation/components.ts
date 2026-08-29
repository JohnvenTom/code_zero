/**
 * 模拟实体组件（纯数据状态）
 *
 * 功能：定义挂在 SimEntity 上的可选组件——战机飞行数据、生命值、
 * 机炮/导弹/干扰弹挂载、弹体数据与敌机 AI 状态；全部为纯数据，
 * 不包含任何逻辑与渲染对象。
 * 注意事项：组件由各模拟系统（飞行模型/武器系统）读写，
 * 渲染层只读访问；严禁在本层存放 Three.js 场景对象。
 */
import { gameConfig } from '../config';
import type { FighterStatsConfig, SpecialWeaponConfig } from '../config';

/**
 * 战机飞行性能参数（挂在 aircraft 组件内的只读数据包）
 *
 * 功能：承载单架战机的性能差异参数（速度/机动/G限/起飞速度等），
 * 由机型配置表生成；飞行模型每步读取本参数包积分——
 * 缺省为 gameConfig.flight 基准值（敌机/轰炸机/友军共用基准）。
 */
export interface FlightParameters {
  /** 最大平飞速度（m/s） */
  readonly maxSpeed: number;
  /** 失速速度（m/s） */
  readonly stallSpeed: number;
  /** 满油门加速度（m/s²） */
  readonly thrustAccel: number;
  /** 气动阻力系数 */
  readonly dragCoefficient: number;
  /** 最大俯仰角速率（rad/s） */
  readonly pitchRateMax: number;
  /** 最大滚转角速率（rad/s） */
  readonly rollRateMax: number;
  /** 最大偏航角速率（rad/s） */
  readonly yawRateMax: number;
  /** 正过载限制（G） */
  readonly gLimitPositive: number;
  /** 负过载限制（G） */
  readonly gLimitNegative: number;
  /** 起飞离地速度（m/s） */
  readonly takeoffSpeed: number;
}

/**
 * 从战机配置构造飞行性能参数包
 *
 * @param stats 战机性能配置（机型配置表的 stats 字段）
 * @returns 飞行性能参数包
 * 异常：无
 */
export function createFlightParameters(stats?: FighterStatsConfig): FlightParameters {
  const base = gameConfig.flight;
  return {
    maxSpeed: stats?.maxSpeed ?? base.maxSpeed,
    stallSpeed: stats?.stallSpeed ?? base.stallSpeed,
    thrustAccel: stats?.thrustAccel ?? base.thrustAccel,
    dragCoefficient: stats?.dragCoefficient ?? base.dragCoefficient,
    pitchRateMax: stats?.pitchRateMax ?? base.pitchRateMax,
    rollRateMax: stats?.rollRateMax ?? base.rollRateMax,
    yawRateMax: stats?.yawRateMax ?? base.yawRateMax,
    gLimitPositive: stats?.gLimitPositive ?? base.gLimitPositive,
    gLimitNegative: stats?.gLimitNegative ?? base.gLimitNegative,
    takeoffSpeed: stats?.takeoffSpeed ?? base.takeoffSpeed,
  };
}

/**
 * 战机飞行数据组件（挂在 kind==='aircraft' 的实体上）
 *
 * 功能：承载街机飞行模型的全部积分状态——油门、速度标量、平滑杆量、
 * G 值、失速/接地标记与机型性能参数包等。
 */
export interface AircraftData {
  /** 油门开度 0..1 */
  throttle: number;
  /** 速度标量（m/s，沿机头方向） */
  speed: number;
  /** 平滑后的俯仰杆量 -1..1（+1 拉杆抬头） */
  pitchIn: number;
  /** 平滑后的滚转杆量 -1..1（+1 右滚） */
  rollIn: number;
  /** 平滑后的偏航脚蹬量 -1..1（+1 右偏航） */
  yawIn: number;
  /** 当前法向过载（G，含重力分量） */
  gLoad: number;
  /** 是否失速（空中且速度低于失速阈值） */
  stalled: boolean;
  /** 是否处于地面滑跑状态（起飞前/未离地） */
  onGround: boolean;
  /** 是否已坠毁（坠毁后实体存活标记一并置 false） */
  crashed: boolean;
  /** 机型性能参数包（飞行模型积分用） */
  params: FlightParameters;
}

/**
 * 创建默认战机飞行数据组件
 *
 * 功能：生成位于跑道起点、静止、油门为零的初始飞行数据；
 * 性能参数按传入战机配置覆盖（缺省使用基准参数）
 * @param onGround 是否以地面滑跑状态初始化（缺省 true）
 * @param stats 战机性能配置（缺省使用基准参数）
 * @returns 初始飞行数据组件
 * 异常：无
 * 注意事项：重置玩家时也应使用本工厂重建组件，保证状态一致
 */
export function createAircraftData(onGround: boolean = true, stats?: FighterStatsConfig): AircraftData {
  return {
    throttle: 0,
    speed: 0,
    pitchIn: 0,
    rollIn: 0,
    yawIn: 0,
    gLoad: 1,
    stalled: false,
    onGround,
    crashed: false,
    params: createFlightParameters(stats),
  };
}

/**
 * 生命值组件（挂在可被击毁的实体上：靶标/敌机/护卫对象等）
 */
export interface HealthData {
  /** 当前生命值 */
  hp: number;
  /** 生命值上限 */
  maxHp: number;
  /** 命中判定半径（米，球体碰撞检测用） */
  hitRadius: number;
}

/**
 * 创建生命值组件
 *
 * @param hp 初始与上限生命值
 * @param hitRadius 命中判定半径（米）
 * @returns 生命值组件
 * 异常：无
 * 注意事项：hitRadius 应与渲染网格的视觉尺寸匹配，保证命中判定与画面一致
 */
export function createHealthData(hp: number, hitRadius: number): HealthData {
  return { hp, maxHp: hp, hitRadius };
}

/**
 * 机炮组件（挂在具备机炮武器的实体上）
 */
export interface GunData {
  /** 剩余弹药数 */
  ammo: number;
  /** 距离下一发可发射的冷却剩余时间（秒） */
  cooldown: number;
}

/**
 * 创建满弹药的机炮组件
 *
 * @param ammo 初始弹药数（来自武器配置表）
 * @returns 机炮组件
 * 异常：无
 * 注意事项：冷却初始为 0，生成后立即可开火
 */
export function createGunData(ammo: number): GunData {
  return { ammo, cooldown: 0 };
}

/**
 * 弹丸数据组件（挂在 kind==='projectile' 的实体上）
 */
export interface ProjectileData {
  /** 单发伤害 */
  damage: number;
  /** 剩余存活时间（秒，归零后消亡） */
  remainingLife: number;
  /** 发射者实体 ID（命中判定时跳过自身） */
  ownerId: number;
  /** 是否敌方发射（敌机弹丸只命中玩家，避免误伤友机） */
  byEnemy: boolean;
}

/**
 * 创建弹丸数据组件
 *
 * @param damage 单发伤害
 * @param life 存活时间（秒）
 * @param ownerId 发射者实体 ID
 * @param byEnemy 是否敌方发射（命中阵营判定用）
 * @returns 弹丸数据组件
 * 异常：无
 * 注意事项：曳光弹寿命同时决定最大射程（≈初速×寿命）
 */
export function createProjectileData(
  damage: number,
  life: number,
  ownerId: number,
  byEnemy: boolean,
): ProjectileData {
  return { damage, remainingLife: life, ownerId, byEnemy };
}

/**
 * 导弹挂载组件（挂在具备导弹武器的飞机实体上）
 *
 * 功能：承载导弹弹药计数与发射冷却状态
 */
export interface MissilesData {
  /** 剩余导弹数 */
  ammo: number;
  /** 距下一发可发射的冷却剩余时间（秒） */
  cooldown: number;
}

/**
 * 创建满弹药的导弹挂载组件
 *
 * @param ammo 初始导弹数（来自导弹配置表）
 * @returns 导弹挂载组件
 * 异常：无
 * 注意事项：冷却初始为 0，生成后立即可发射（锁定完成后）
 */
export function createMissilesData(ammo: number): MissilesData {
  return { ammo, cooldown: 0 };
}

/**
 * 导弹弹体组件（挂在 kind==='projectile' 且 variant==='missile' 的实体上）
 *
 * 功能：承载导弹制导状态——追踪目标、当前速度、诱偏标记与
 * 性能覆盖参数（特殊武器导弹的转向/极速）
 */
export interface MissileData {
  /** 追踪目标实体 ID（被诱偏后为干扰弹实体 ID） */
  targetId: number;
  /** 当前飞行速度标量（m/s） */
  speed: number;
  /** 是否已被干扰弹诱偏 */
  decoyed: boolean;
  /** 是否已做过诱偏判定（单次判定，避免概率随步数累积） */
  decoyChecked: boolean;
  /** 转向角速率覆盖（rad/s；undefined=使用标准配置值） */
  turnRateOverride: number | undefined;
  /** 最大速度覆盖（m/s；undefined=使用标准配置值） */
  maxSpeedOverride: number | undefined;
}

/**
 * 创建导弹弹体组件
 *
 * @param targetId 追踪目标实体 ID
 * @param speed 初始速度（m/s）
 * @returns 导弹弹体组件
 * 异常：无
 * 注意事项：诱偏标记初始均为 false，由导弹步进系统维护
 */
export function createMissileData(targetId: number, speed: number): MissileData {
  return {
    targetId,
    speed,
    decoyed: false,
    decoyChecked: false,
    turnRateOverride: undefined,
    maxSpeedOverride: undefined,
  };
}

/**
 * 干扰弹挂载组件（挂在具备干扰弹的飞机实体上）
 */
export interface FlaresData {
  /** 剩余干扰弹数 */
  count: number;
  /** 距下一次可释放的冷却剩余时间（秒） */
  cooldown: number;
}

/**
 * 创建满载干扰弹挂载组件
 *
 * @param count 初始干扰弹数（来自干扰弹配置表）
 * @returns 干扰弹挂载组件
 * 异常：无
 */
export function createFlaresData(count: number): FlaresData {
  return { count, cooldown: 0 };
}

/**
 * 干扰弹弹体组件（挂在 kind==='effect' 且 variant==='flare' 的实体上）
 *
 * 功能：标记干扰弹归属与寿命，供导弹诱偏系统检索
 */
export interface FlareData {
  /** 释放者实体 ID（诱偏判定时须与被攻击目标一致） */
  ownerId: number;
  /** 剩余存活时间（秒，归零后消亡） */
  remainingLife: number;
}

/**
 * 创建干扰弹弹体组件
 *
 * @param ownerId 释放者实体 ID
 * @param life 存活时间（秒）
 * @returns 干扰弹弹体组件
 * 异常：无
 */
export function createFlareData(ownerId: number, life: number): FlareData {
  return { ownerId, remainingLife: life };
}

/**
 * 敌机 AI 状态机模式
 * - chase：追击（占位玩家尾后）
 * - attack：攻击（进入包线后开火）
 * - evade：规避（被锁定/导弹来袭时机动+释放干扰弹）
 */
export type EnemyAIMode = 'chase' | 'attack' | 'evade';

/**
 * 僚机指令（玩家循环下达）
 * - formation：集合/默认编队跟随
 * - attack：进攻（主动接敌最近目标）
 * - cover：掩护（优先攻击威胁玩家的敌机）
 */
export type WingmanCommand = 'formation' | 'attack' | 'cover';

/**
 * 僚机 AI 状态组件（挂在僚机实体上）
 *
 * 功能：承载僚机 AI 的全部运行时状态——玩家指令、规避计时、
 * 导弹冷却、侧滑换向计时与选中目标
 */
export interface WingmanAIState {
  /** 玩家当前指令（全局指令由世界层下发到每架僚机） */
  command: WingmanCommand;
  /** 规避剩余时间（秒，>0 时执行规避机动） */
  evadeTimer: number;
  /** 规避滚转方向（±1，进入规避时随机） */
  evadeRollDir: number;
  /** 导弹发射冷却剩余时间（秒） */
  missileCooldown: number;
  /** 侧滑机动换向计时（秒） */
  weaveTimer: number;
  /** 当前侧滑方向（±1） */
  weaveDir: number;
  /** 选中目标实体 ID（attack/cover 模式缓存；null=未选） */
  targetId: number | null;
}

/**
 * 创建僚机 AI 状态组件
 *
 * @returns 僚机 AI 状态组件（formation 模式）
 * 异常：无
 * 注意事项：僚机不使用 EnemyAIState（行为集不同），
 * 单独的状态结构承载指令与机动状态
 */
export function createWingmanAIState(): WingmanAIState {
  return {
    command: 'formation',
    evadeTimer: 0,
    evadeRollDir: 1,
    missileCooldown: 0,
    weaveTimer: 0,
    weaveDir: 1,
    targetId: null,
  };
}

/**
 * 特殊武器挂载组件（挂在玩家实体上）
 *
 * 功能：承载特殊武器弹药与发射冷却、当前特殊武器配置引用
 * （由所选机型决定，见 specialWeaponSystem.ts）
 */
export interface SpecialWeaponPod {
  /** 剩余弹药数（多目标导弹按"次"计，一次齐射消耗 1） */
  ammo: number;
  /** 发射冷却剩余时间（秒） */
  cooldown: number;
  /** 特殊武器配置（机型专属） */
  config: SpecialWeaponConfig;
}

/**
 * 敌机 AI 状态组件（挂在敌机实体上）
 *
 * 功能：承载 AI 状态机模式、计时器与机动随机方向等全部 AI 状态
 */
export interface EnemyAIState {
  /** 当前 AI 模式 */
  mode: EnemyAIMode;
  /** 规避剩余时间（秒，evade 模式递减） */
  evadeTimer: number;
  /** 规避滚转方向（±1，进入规避时随机选取） */
  evadeRollDir: number;
  /** 导弹发射冷却剩余时间（秒） */
  missileCooldown: number;
  /** 侧滑机动换向计时（秒） */
  weaveTimer: number;
  /** 当前侧滑方向（±1） */
  weaveDir: number;
  /** 脱离机动剩余时间（秒，过顶交错后拉开距离） */
  breakAwayTimer: number;
  /** 交战目标实体 ID（玩家或僚机；null=玩家） */
  targetId: number | null;
}

/**
 * 创建敌机 AI 状态组件
 *
 * 功能：生成初始处于追击模式、导弹冷却中的 AI 状态
 * @returns 敌机 AI 状态组件（chase 模式）
 * 异常：无
 * 注意事项：导弹冷却初始为配置冷却值的一半，避免开局立即齐射；
 * 狗斗计时器（weave/breakAway）初始为零，进入对应机动时启动
 */
export function createEnemyAIState(): EnemyAIState {
  return {
    mode: 'chase',
    evadeTimer: 0,
    evadeRollDir: 1,
    missileCooldown: gameConfig.enemy.missileCooldown * 0.5,
    weaveTimer: 0,
    weaveDir: 1,
    breakAwayTimer: 0,
    targetId: null,
  };
}
