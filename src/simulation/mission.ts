import { campaignMission1, type CampaignMission1Config, type MissionObjectiveType } from '../config';
import type { SimEntity } from './entity';

/** 任务配置的模块级引用 */
const missionCfg: CampaignMission1Config = campaignMission1;

/** 任务运行状态 */
export type MissionStatus =
  /** 简报呈现中（等待玩家确认开始） */
  | 'briefing'
  /** 进行中 */
  | 'active'
  /** 胜利结算 */
  | 'victory'
  /** 失败结算（原因见 failureReason） */
  | 'failed';

/** 任务失败原因 */
export type MissionFailureReason =
  /** 玩家被击毁 */
  | 'player-destroyed'
  /** 任务总倒计时耗尽 */
  | 'timeout'
  /** 护卫对象全部损毁 */
  | 'allies-destroyed';

/** 单个目标的运行时进度 */
export interface ObjectiveProgress {
  /** 目标类型 */
  readonly type: MissionObjectiveType;
  /** 完成数量（protect-allies 为存活数） */
  readonly current: number;
  /** 要求数量 */
  readonly required: number;
  /** 是否完成 */
  readonly done: boolean;
}

/** 任务阶段快照（HUD 目标显示） */
export interface MissionPhaseSnapshot {
  /** 阶段标题 */
  readonly title: string;
  /** 阶段目标进度列表 */
  readonly objectives: readonly ObjectiveProgress[];
  /** 阶段剩余时间（秒；不限时为 null） */
  readonly phaseTimeRemaining: number | null;
}

/** 任务结算结果 */
export interface MissionResult {
  /** 是否胜利 */
  readonly victory: boolean;
  /** 失败原因（胜利时为 null） */
  readonly failureReason: MissionFailureReason | null;
  /** 总得分 */
  readonly score: number;
  /** 评价等级 */
  readonly grade: string;
  /** 击坠敌机数 */
  readonly enemyKills: number;
  /** 击坠轰炸机数 */
  readonly bomberKills: number;
  /** 摧毁地面目标数 */
  readonly groundKills: number;
  /** 任务用时（秒） */
  readonly timeUsed: number;
}

/**
 * 任务系统：多阶段战役任务的状态机与规则裁判
 *
 * 功能：按配置表驱动战役任务全流程——阶段推进（目标全部完成进入
 * 下一阶段）、敌人生成表按延迟触发、四种目标类型的进度统计、
 * 胜负判定（全部阶段完成=胜利；玩家坠毁/总倒计时耗尽/护卫对象
 * 全灭=失败）与结算评分（击坠分+资源剩余分+时间分→评价等级）。
 * 边界约定：本类为纯规则层，不持有渲染对象；实体生成经世界层
 * 注入的回调完成，实体统计只读取只读列表。
 */
export class MissionSystem {
  /** 任务运行状态 */
  private status: MissionStatus = 'briefing';
  /** 当前阶段索引 */
  private phaseIndex = 0;
  /** 当前阶段内经过的时间（秒） */
  private phaseTime = 0;
  /** 任务累计用时（秒，active 状态推进） */
  private missionTime = 0;
  /** 任务总剩余时间（秒） */
  private timeRemaining = missionCfg.timeLimit;
  /** 失败原因（failed 状态有效） */
  private failureReason: MissionFailureReason | null = null;
  /** 各生成条目是否已触发（按阶段索引+条目索引记录） */
  private readonly firedSpawns = new Set<string>();
  /** 击坠敌机数（战斗机，不含轰炸机） */
  private enemyKills = 0;
  /** 击坠轰炸机数 */
  private bomberKills = 0;
  /** 摧毁地面目标数 */
  private groundKills = 0;
  /** 轰炸机实体 ID 集合（拦截目标，生成时登记） */
  private readonly bomberIds = new Set<number>();
  /** 友军护卫对象实体 ID 集合（生成时登记） */
  private readonly allyIds = new Set<number>();

  /**
   * 开始任务（简报确认后调用）
   *
   * 功能：状态从 briefing 转为 active，重置计时器；
   * 首阶段的生成表由下一次 update 触发
   * @returns void
   * 异常：无
   * 注意事项：必须在玩家确认简报后调用，否则模拟不推进任务
   */
  start(): void {
    this.status = 'active';
  }

  /**
   * 登记轰炸机实体（世界层生成时回调）
   *
   * @param id 轰炸机实体 ID
   * @returns void
   */
  registerBomber(id: number): void {
    this.bomberIds.add(id);
  }

  /**
   * 登记友军护卫对象实体（世界层生成时回调）
   *
   * @param id 友军实体 ID
   * @returns void
   */
  registerAlly(id: number): void {
    this.allyIds.add(id);
  }

  /**
   * 获取任务运行状态
   *
   * @returns 当前状态
   */
  getStatus(): MissionStatus {
    return this.status;
  }

  /**
   * 获取击坠敌机数（不含轰炸机）
   *
   * @returns 战斗机击坠数
   */
  getEnemyKills(): number {
    return this.enemyKills;
  }

  /**
   * 获取任务累计用时
   *
   * @returns 任务累计秒数（briefing 状态为 0）
   */
  getMissionElapsedTime(): number {
    return this.missionTime;
  }

  /**
   * 任务是否仍在进行（active 才推进模拟与计时）
   *
   * @returns 进行中返回 true
   */
  get isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * 获取结算结果（victory/failed 状态有效）
   *
   * 功能：按评分规则计算总得分并匹配评价等级——
   * 击坠分（战斗机/轰炸机/地面目标分别计分）+ 生命值剩余分 +
   * 导弹剩余分 + 提前完成时间分（仅胜利计）
   * @param playerHpRemaining 玩家剩余生命值（仅胜利时计分）
   * @param missilesRemaining 剩余导弹数（仅胜利时计分）
   * @returns 结算结果；任务未结束时返回 null
   * 异常：无
   * 注意事项：结果在调用时即时计算，重开任务前可反复读取
   */
  getResult(playerHpRemaining: number, missilesRemaining: number): MissionResult | null {
    if (this.status !== 'victory' && this.status !== 'failed') {
      return null;
    }
    const s = missionCfg.scoring;
    let score =
      this.enemyKills * s.perEnemyKill +
      this.bomberKills * s.perBomberKill +
      this.groundKills * s.perGroundKill;
    if (this.status === 'victory') {
      score += playerHpRemaining * s.perHpRemaining;
      score += missilesRemaining * s.perMissileRemaining;
      score += Math.max(0, this.timeRemaining) * s.perSecondRemaining;
    }
    let grade = 'D';
    for (const threshold of missionCfg.rating.thresholds) {
      if (score >= threshold.minScore) {
        grade = threshold.grade;
        break;
      }
    }
    return {
      victory: this.status === 'victory',
      failureReason: this.failureReason,
      score: Math.round(score),
      grade,
      enemyKills: this.enemyKills,
      bomberKills: this.bomberKills,
      groundKills: this.groundKills,
      timeUsed: Math.round(this.missionTime),
    };
  }

  /**
   * 生成当前阶段快照（HUD 目标进度显示）
   *
   * 功能：统计当前阶段各目标进度——kill-enemies/intercept-bombers
   * 按击坠数、destroy-ground 按摧毁数、protect-allies 按存活数；
   * 附带阶段剩余时间
   * @param entities 世界实体列表（统计存活目标）
   * @returns 阶段快照；任务未激活（简报/结算）时返回 null
   * 异常：无
   */
  getPhaseSnapshot(entities: readonly SimEntity[]): MissionPhaseSnapshot | null {
    if (this.status !== 'active') {
      return null;
    }
    const phase = missionCfg.phases[this.phaseIndex];
    if (phase === undefined) {
      return null;
    }

    // 统计存活目标
    let aliveBombers = 0;
    let aliveAllies = 0;
    for (const entity of entities) {
      if (!entity.alive) {
        continue;
      }
      if (this.bomberIds.has(entity.id)) {
        aliveBombers += 1;
      }
      if (this.allyIds.has(entity.id)) {
        aliveAllies += 1;
      }
    }

    const objectives: ObjectiveProgress[] = phase.objectives.map((objective) => {
      switch (objective.type) {
        case 'kill-enemies':
          return {
            type: objective.type,
            current: this.enemyKills,
            required: objective.count,
            done: this.enemyKills >= objective.count,
          };
        case 'destroy-ground':
          return {
            type: objective.type,
            current: this.groundKills,
            required: objective.count,
            done: this.groundKills >= objective.count,
          };
        case 'intercept-bombers':
          return {
            type: objective.type,
            current: this.bomberKills,
            required: objective.count,
            done: this.bomberKills >= objective.count,
          };
        case 'protect-allies':
          return {
            type: objective.type,
            current: aliveAllies,
            required: objective.count,
            done: aliveAllies >= objective.count,
          };
      }
    });

    return {
      title: phase.title,
      objectives,
      phaseTimeRemaining: phase.timeLimit > 0 ? Math.max(0, phase.timeLimit - this.phaseTime) : null,
    };
  }

  /**
   * 固定步长推进任务（单个模拟步）
   *
   * 功能：active 状态下推进任务计时（总/阶段）→ 触发到期生成条目 →
   * 判定失败（超时/护卫全灭，玩家坠毁由世界层显式通知）→
   * 判定阶段完成（目标全部 done → 推进下一阶段或胜利）
   * @param dt 固定时间步长（秒）
   * @param entities 世界实体列表（目标统计）
   * @param spawnEnemies 生成敌机回调（世界层实现，参数：生成位置列表、是否轰炸机）
   * @param spawnGroundTargets 生成地面目标回调（阶段开始时一次性调用）
   * @param spawnAllies 生成友军护卫对象回调（阶段开始时一次性调用）
   * @returns void
   * 异常：无
   * 注意事项：阶段切换时一次性生成该阶段的地面目标/友军；
   * 生成条目按“阶段索引:条目索引”去重，每条只触发一次
   */
  update(
    dt: number,
    entities: readonly SimEntity[],
    spawnEnemies: (positions: readonly (readonly [number, number, number])[], bombers: boolean) => void,
    spawnGroundTargets: (positions: readonly (readonly [number, number, number])[]) => void,
    spawnAllies: (positions: readonly (readonly [number, number, number])[]) => void,
  ): void {
    if (this.status !== 'active') {
      return;
    }

    // 计时推进
    this.missionTime += dt;
    this.phaseTime += dt;
    this.timeRemaining -= dt;

    const phase = missionCfg.phases[this.phaseIndex];
    if (phase === undefined) {
      return;
    }

    // 阶段首步：一次性生成地面目标与友军护卫对象
    const phaseKey = `phase-${this.phaseIndex}`;
    if (!this.firedSpawns.has(phaseKey)) {
      this.firedSpawns.add(phaseKey);
      const groundObjective = phase.objectives.find((o) => o.type === 'destroy-ground');
      if (groundObjective !== undefined) {
        spawnGroundTargets(missionCfg.groundTargets.positions);
      }
      if (phase.allyPositions !== undefined) {
        spawnAllies(phase.allyPositions);
      }
    }

    // 生成表：到期条目触发敌机生成
    for (let i = 0; i < phase.spawns.length; i++) {
      const entry = phase.spawns[i]!;
      const key = `${this.phaseIndex}:${i}`;
      if (!this.firedSpawns.has(key) && this.phaseTime >= entry.delay) {
        this.firedSpawns.add(key);
        spawnEnemies(entry.positions, entry.bombers);
      }
    }

    // 失败判定：任务总超时
    if (this.timeRemaining <= 0) {
      this.fail('timeout');
      return;
    }
    // 失败判定：阶段时限耗尽（当前阶段未完成）
    if (phase.timeLimit > 0 && this.phaseTime >= phase.timeLimit) {
      this.fail('timeout');
      return;
    }
    // 失败判定：护卫对象全部损毁（存在护卫目标且已生成过后）
    const protectObjective = phase.objectives.find((o) => o.type === 'protect-allies');
    if (protectObjective !== undefined && this.allyIds.size > 0) {
      let aliveAllies = 0;
      for (const entity of entities) {
        if (entity.alive && this.allyIds.has(entity.id)) {
          aliveAllies += 1;
          break;
        }
      }
      if (aliveAllies === 0) {
        this.fail('allies-destroyed');
        return;
      }
    }

    // 阶段完成判定：目标全部完成 → 下一阶段或胜利
    const snapshot = this.getPhaseSnapshot(entities);
    if (snapshot !== null && snapshot.objectives.every((o) => o.done)) {
      if (this.phaseIndex + 1 < missionCfg.phases.length) {
        this.phaseIndex += 1;
        this.phaseTime = 0;
      } else {
        this.status = 'victory';
      }
    }
  }

  /**
   * 播报目标摧毁（世界层消费 target-destroyed 事件后转发）
   *
   * 功能：按被摧毁实体变体分类累计击坠/摧毁计数——
   * enemy=战斗机击坠、bomber=轰炸机击坠、ground-target=地面摧毁；
   * 其他变体（练习靶标等）不计数
   * @param variant 被摧毁实体变体
   * @returns void
   * 异常：无
   */
  reportDestroy(variant: SimEntity['variant']): void {
    if (variant === 'enemy') {
      this.enemyKills += 1;
    } else if (variant === 'bomber') {
      this.bomberKills += 1;
    } else if (variant === 'ground-target-entity') {
      this.groundKills += 1;
    }
  }

  /**
   * 通知玩家被击毁（世界层检测玩家死亡后调用）
   *
   * 功能：active 状态下判定任务失败并记录原因
   * @returns void
   * 异常：无
   * 注意事项：多次调用安全（非 active 状态忽略）
   */
  reportPlayerDestroyed(): void {
    if (this.status === 'active') {
      this.fail('player-destroyed');
    }
  }

  /**
   * 置任务为失败状态（私有）
   *
   * @param reason 失败原因
   */
  private fail(reason: MissionFailureReason): void {
    this.status = 'failed';
    this.failureReason = reason;
  }
}

/** 任务配置只读导出（世界层生成实体用） */
export const missionConfig = missionCfg;
