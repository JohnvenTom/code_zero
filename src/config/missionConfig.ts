/**
 * 战役任务配置表（数据驱动）
 *
 * 功能：定义战役任务 1「破碎海岸」的多阶段编排——阶段推进、
 * 各阶段目标（击坠/地面摧毁/拦截/护卫）、敌人生成表、任务倒计时
 * 与结算评价规则；任务系统（simulation/mission.ts）按本表驱动。
 * 注意事项：本层只存放纯数据与常量，严禁包含任何逻辑代码；
 * 位置坐标沿用现有战场约定（跑道原点、-Z 为主攻方向）。
 */

/** 目标类型 */
export type MissionObjectiveType =
  /** 击坠指定数量的敌机 */
  | 'kill-enemies'
  /** 摧毁指定数量的地面/海面目标 */
  | 'destroy-ground'
  /** 拦截轰炸机（击坠全部轰炸机即完成） */
  | 'intercept-bombers'
  /** 保护友军目标（阶段时限内容活即完成，全灭则失败） */
  | 'protect-allies';

/** 单个任务目标 */
export interface MissionObjectiveConfig {
  /** 目标类型 */
  readonly type: MissionObjectiveType;
  /** 需要完成数量（protect-allies 为需存活的友军数） */
  readonly count: number;
}

/** 敌人生成条目（单个波次/编队） */
export interface EnemySpawnEntryConfig {
  /** 生成延迟（秒，相对所属阶段开始时刻） */
  readonly delay: number;
  /** 编队生成位置列表 [x, y, z]（世界坐标，米） */
  readonly positions: readonly (readonly [number, number, number])[];
  /** 是否轰炸机（更大更慢，拦截目标） */
  readonly bombers: boolean;
}

/** 任务阶段 */
export interface MissionPhaseConfig {
  /** 阶段标题（HUD 目标显示） */
  readonly title: string;
  /** 阶段目标列表（全部完成进入下一阶段） */
  readonly objectives: readonly MissionObjectiveConfig[];
  /** 阶段敌人生成表 */
  readonly spawns: readonly EnemySpawnEntryConfig[];
  /** 阶段时限（秒，超时失败；0=不限时） */
  readonly timeLimit: number;
  /** 护理目标生成位置（protect-allies 阶段用） */
  readonly allyPositions?: readonly (readonly [number, number, number])[];
}

/** 任务结算评价规则 */
export interface MissionRatingConfig {
  /** 评价等级按分数阈值降序匹配（分数>=阈值取该等级） */
  readonly thresholds: readonly { readonly grade: string; readonly minScore: number }[];
}

/** 战役任务 1 整体配置 */
export interface CampaignMission1Config {
  /** 任务名称 */
  readonly name: string;
  /** 任务简报叙事（开场逐段显示） */
  readonly briefing: readonly string[];
  /** 任务总倒计时（秒） */
  readonly timeLimit: number;
  /** 任务阶段序列（按序推进） */
  readonly phases: readonly MissionPhaseConfig[];
  /** 结算评价规则 */
  readonly rating: MissionRatingConfig;
  /** 评分规则常量 */
  readonly scoring: {
    /** 每击坠一架敌机得分 */
    readonly perEnemyKill: number;
    /** 每摧毁一个地面目标得分 */
    readonly perGroundKill: number;
    /** 每击坠一架轰炸机得分 */
    readonly perBomberKill: number;
    /** 剩余生命值每点得分 */
    readonly perHpRemaining: number;
    /** 剩余导弹每发得分 */
    readonly perMissileRemaining: number;
    /** 提前完成每秒得分 */
    readonly perSecondRemaining: number;
  };
  /** 地面目标配置 */
  readonly groundTargets: {
    /** 单个地面目标生命值 */
    readonly hp: number;
    /** 命中判定半径（米） */
    readonly hitRadius: number;
    /** 生成位置列表 [x, y, z]（世界坐标，米；y 为离地高度） */
    readonly positions: readonly (readonly [number, number, number])[];
  };
  /** 轰炸机配置 */
  readonly bombers: {
    /** 生命值 */
    readonly hp: number;
    /** 命中判定半径（米） */
    readonly hitRadius: number;
    /** 巡航速度（m/s） */
    readonly speed: number;
    /** 飞行高度（米） */
    readonly altitude: number;
    /** 航向目标点 [x, y, z]（轰炸机朝该点平飞） */
    readonly heading: readonly [number, number, number];
  };
  /** 友军护卫对象配置（慢速运输机） */
  readonly allies: {
    /** 生命值 */
    readonly hp: number;
    /** 命中判定半径（米） */
    readonly hitRadius: number;
    /** 巡航速度（m/s） */
    readonly speed: number;
    /** 航向目标点 [x, y, z] */
    readonly heading: readonly [number, number, number];
  };
}

/** 战役任务 1「破碎海岸」：空战 → 地面目标 → 拦截/护卫高潮 */
export const campaignMission1: CampaignMission1Config = {
  name: '战役任务 1 · 破碎海岸',
  briefing: [
    '指挥官：敌方舰队已突破外围防线，正向海岸补给线推进。',
    '你的中队将从海岸机场紧急起飞，夺取登陆场上空的制空权。',
    '第一阶段：肃清登陆场附近的敌战斗机编队。',
    '第二阶段：敌方在海岸公路布设了防空阵地，全部拔除。',
    '最终阶段：轰炸机群将袭击我们的运输船队——拦截它们，并护送友军运输机撤离战区。',
    '祝好运，CODER-ZERO。',
  ],
  timeLimit: 600,
  phases: [
    {
      title: '阶段一：夺取制空权',
      objectives: [{ type: 'kill-enemies', count: 4 }],
      spawns: [
        {
          delay: 0,
          positions: [
            [-1200, 800, -6200],
            [1200, 850, -6600],
          ],
          bombers: false,
        },
        {
          delay: 25,
          positions: [
            [-2000, 900, -7000],
            [2000, 950, -7200],
          ],
          bombers: false,
        },
      ],
      timeLimit: 0,
    },
    {
      title: '阶段二：拔除防空阵地',
      objectives: [{ type: 'destroy-ground', count: 5 }],
      spawns: [
        {
          delay: 0,
          positions: [
            [1800, 750, -5200],
            [-1600, 800, -4800],
          ],
          bombers: false,
        },
      ],
      timeLimit: 0,
    },
    {
      title: '阶段三：拦截轰炸机 · 护卫运输队',
      objectives: [
        { type: 'intercept-bombers', count: 2 },
        { type: 'protect-allies', count: 2 },
      ],
      spawns: [
        {
          delay: 0,
          positions: [
            [-500, 2200, -11000],
            [500, 2300, -11400],
          ],
          bombers: true,
        },
        {
          delay: 8,
          positions: [
            [-2500, 1000, -7800],
            [2500, 1100, -8200],
          ],
          bombers: false,
        },
      ],
      timeLimit: 150,
      allyPositions: [
        [-300, 600, -2200],
        [300, 640, -2400],
      ],
    },
  ],
  rating: {
    thresholds: [
      { grade: 'S', minScore: 2600 },
      { grade: 'A', minScore: 2200 },
      { grade: 'B', minScore: 1800 },
      { grade: 'C', minScore: 1400 },
      { grade: 'D', minScore: 0 },
    ],
  },
  scoring: {
    perEnemyKill: 150,
    perGroundKill: 100,
    perBomberKill: 250,
    perHpRemaining: 5,
    perMissileRemaining: 20,
    perSecondRemaining: 8,
  },
  groundTargets: {
    hp: 50,
    hitRadius: 16,
    positions: [
      [900, 6, -3600],
      [-900, 6, -3800],
      [1400, 6, -4400],
      [-1500, 6, -4600],
      [500, 6, -5000],
      [-400, 6, -5200],
    ],
  },
  bombers: {
    hp: 130,
    hitRadius: 22,
    speed: 120,
    altitude: 2200,
    heading: [0, 2200, 2600],
  },
  allies: {
    hp: 80,
    hitRadius: 18,
    speed: 110,
    heading: [0, 600, 3200],
  },
} as const;
