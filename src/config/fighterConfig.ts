/**
 * 战机与特殊武器配置表（数据驱动）
 *
 * 功能：定义 3 架可选战机的完整属性——代号/定位描述、飞行性能
 * （速度/机动/装甲三围）、武器基数与各自专属的特殊武器；
 * 机库选择界面展示本表，世界层生成玩家时按所选战机初始化
 * 飞行数据与全部武器挂载。
 * 注意事项：本层只存放纯数据与常量，严禁包含任何逻辑代码；
 * 飞行性能字段与 gameConfig.flight 的基准参数同名，
 * 由飞行模型按机型覆盖（敌机仍使用基准参数）。
 */

/** 特殊武器类型 */
export type SpecialWeaponType =
  /** 多目标导弹：锁定锥内全体目标同时齐射 */
  | 'multi-missile'
  /** 对地集束炸弹：机腹抛撒破片，地面/低空目标范围伤害 */
  | 'cluster-bomb'
  /** 远程导弹：超远射程高速导弹，锁定距离加成 */
  | 'long-range-missile';

/** 特殊武器配置 */
export interface SpecialWeaponConfig {
  /** 特殊武器类型 */
  readonly type: SpecialWeaponType;
  /** 显示名称 */
  readonly name: string;
  /** 弹药基数 */
  readonly ammo: number;
  /** 单发伤害（集束为单破片伤害） */
  readonly damage: number;

  // ---- 多目标导弹参数 ----
  /** 多目标齐射最大同时锁定数 */
  readonly maxTargets?: number;
  /** 多目标导弹转向速率（rad/s） */
  readonly turnRate?: number;

  // ---- 对地集束参数 ----
  /** 集束破片数量 */
  readonly bombletCount?: number;
  /** 破片抛撒角（rad，相对机头前下方） */
  readonly spreadRad?: number;
  /** 破片初速（m/s） */
  readonly bombletSpeed?: number;
  /** 破片存活时间（秒） */
  readonly bombletLife?: number;
  /** 范围伤害半径（米） */
  readonly blastRadius?: number;

  // ---- 远程导弹参数 ----
  /** 远程导弹最大飞行速度（m/s） */
  readonly maxSpeed?: number;
  /** 远程导弹转向速率（rad/s） */
  readonly longTurnRate?: number;
  /** 远程导弹锁定距离加成（米，叠加在标准锁定距离上） */
  readonly lockRangeBonus?: number;
}

/** 战机飞行性能参数（缺省字段回落 gameConfig.flight 基准值） */
export interface FighterStatsConfig {
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
  /** 机体生命值（装甲） */
  readonly hp: number;
  /** 机炮弹药基数 */
  readonly gunAmmo: number;
  /** 标准导弹基数 */
  readonly missileAmmo: number;
  /** 干扰弹基数 */
  readonly flareCount: number;
}

/** 单架战机配置 */
export interface FighterConfig {
  /** 机型 ID（机库选择与出生装配的键） */
  readonly id: string;
  /** 机型代号 */
  readonly name: string;
  /** 定位描述（机库展示） */
  readonly role: string;
  /** 机型描述文案（机库展示） */
  readonly description: string;
  /** 机体主色（渲染网格配色，0xRRGGBB） */
  readonly bodyColor: number;
  /** 强调色（机翼/垂尾） */
  readonly accentColor: number;
  /** 飞行性能与武器基数 */
  readonly stats: FighterStatsConfig;
  /** 专属特殊武器 */
  readonly special: SpecialWeaponConfig;
}

/**
 * 3 架可选战机：迅捷（高机动）→ 堡垒（高装甲）→ 猎鹰（高速远程）
 */
export const fighters: readonly FighterConfig[] = [
  {
    id: 'kestrel',
    name: 'KF-03 红隼',
    role: '高机动制空',
    description: '轻量机体极限机动：转向凌厉、G 限宽裕，狗斗缠斗之王；装甲薄，容错低。',
    bodyColor: 0x7f96a8,
    accentColor: 0x2fb999,
    stats: {
      maxSpeed: 300,
      stallSpeed: 66,
      thrustAccel: 52,
      dragCoefficient: 0.00058,
      pitchRateMax: 2.25,
      rollRateMax: 4.1,
      yawRateMax: 0.55,
      gLimitPositive: 11,
      gLimitNegative: 4,
      takeoffSpeed: 78,
      hp: 80,
      gunAmmo: 550,
      missileAmmo: 10,
      flareCount: 6,
    },
    special: {
      type: 'multi-missile',
      name: '多目标导弹',
      ammo: 3,
      damage: 85,
      maxTargets: 4,
      turnRate: 2.3,
    },
  },
  {
    id: 'bastion',
    name: 'BT-08 堡垒',
    role: '重装突击',
    description: '厚重装甲承受火力：机体生命值傲视群雄，对地弹药充沛；机动迟缓，避免缠斗。',
    bodyColor: 0x8d8a80,
    accentColor: 0xd9a441,
    stats: {
      maxSpeed: 265,
      stallSpeed: 78,
      thrustAccel: 40,
      dragCoefficient: 0.00045,
      pitchRateMax: 1.3,
      rollRateMax: 2.4,
      yawRateMax: 0.38,
      gLimitPositive: 7.5,
      gLimitNegative: 3,
      takeoffSpeed: 90,
      hp: 160,
      gunAmmo: 750,
      missileAmmo: 12,
      flareCount: 8,
    },
    special: {
      type: 'cluster-bomb',
      name: '对地集束炸弹',
      ammo: 4,
      damage: 30,
      bombletCount: 14,
      spreadRad: 0.35,
      bombletSpeed: 240,
      bombletLife: 2.4,
      blastRadius: 26,
    },
  },
  {
    id: 'falcon',
    name: 'LR-11 猎鹰',
    role: '高速狙击',
    description: '极速掠袭：平飞速度最快，远程导弹先敌开火；中庸机动，保持能量作战。',
    bodyColor: 0x6f88a6,
    accentColor: 0xe0744a,
    stats: {
      maxSpeed: 340,
      stallSpeed: 72,
      thrustAccel: 55,
      dragCoefficient: 0.00048,
      pitchRateMax: 1.7,
      rollRateMax: 3.2,
      yawRateMax: 0.45,
      gLimitPositive: 9,
      gLimitNegative: 3.5,
      takeoffSpeed: 84,
      hp: 100,
      gunAmmo: 600,
      missileAmmo: 12,
      flareCount: 6,
    },
    special: {
      type: 'long-range-missile',
      name: '远程导弹',
      ammo: 5,
      damage: 120,
      maxSpeed: 680,
      longTurnRate: 1.7,
      lockRangeBonus: 2400,
    },
  },
] as const;

/**
 * 按机型 ID 查找战机配置
 *
 * @param id 机型 ID（'kestrel' | 'bastion' | 'falcon'）
 * @returns 战机配置；ID 不存在时返回 null
 */
export function getFighterById(id: string): FighterConfig | null {
  return fighters.find((f) => f.id === id) ?? null;
}

/** 缺省机型 ID（机库未选择时的兜底） */
export const DEFAULT_FIGHTER_ID = 'kestrel';
