import { Quaternion, Vector3 } from 'three';
import { campaignMission1, gameConfig, getFighterById, DEFAULT_FIGHTER_ID } from '../config';
import type { FighterConfig } from '../config';
import { SimEntity, type EntityKind } from './entity';
import {
  createAircraftData,
  createEnemyAIState,
  createFlaresData,
  createGunData,
  createHealthData,
  createMissilesData,
  createWingmanAIState,
  type WingmanCommand,
} from './components';
import type { GameEvent } from './events';
import { integrateAircraftFlight, type ControlInput } from './flightModel';
import { updateGun, updateProjectiles } from './gunSystem';
import { updateEnemyAI } from './enemyAI';
import { updateWingmenAI } from './wingmanAI';
import { launchMissile, LockTracker, tickMissilePod, updateMissiles } from './missileSystem';
import { releaseFlares, tickFlarePod, updateFlares } from './flareSystem';
import { MissionSystem } from './mission';
import { createSpecialWeaponPod, launchSpecialWeapon, tickSpecialWeapon } from './specialWeaponSystem';

/** 飞行配置的模块级引用 */
const flightCfg = gameConfig.flight;
/** 机炮配置的模块级引用 */
const gunCfg = gameConfig.gun;
/** 导弹配置的模块级引用 */
const missileCfg = gameConfig.missile;
/** 干扰弹配置的模块级引用 */
const flareCfg = gameConfig.flare;
/** 敌机配置的模块级引用 */
const enemyCfg = gameConfig.enemy;
/** 玩家配置的模块级引用 */
const playerCfg = gameConfig.player;
/** 雷达配置的模块级引用 */
const radarCfg = gameConfig.radar;
/** 任务配置的模块级引用 */
const mCfg = campaignMission1;
/** 僚机配置的模块级引用 */
const wingmanCfg = gameConfig.wingman;
/** 武器装填基准（敌机/僚机用） */
const reloadCfg = gameConfig.weaponReload;

/** 僚机指令循环顺序 */
const WINGMAN_COMMAND_CYCLE: readonly WingmanCommand[] = ['formation', 'attack', 'cover'];

/** 玩家出生点（跑道南端，机头朝 -Z 即跑道延伸方向） */
const PLAYER_SPAWN = new Vector3(0, flightCfg.gearHeight, 600);

/** 轰炸机/友军的直线飞行输入（零杆量，仅保持油门） */
const CRUISE_INPUT: ControlInput = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttleUp: false,
  throttleDown: false,
  fire: false,
  cycleWeapon: false,
  switchTarget: false,
  flare: false,
  wingmanCommand: false,
  reset: false,
};

/** 雷达光点种类（HUD 敌我识别着色） */
export type RadarBlipKind = 'enemy' | 'bomber' | 'ally' | 'ground' | 'wingman';

/** 雷达光点（north-up 固定方位：世界东=x 右 / 世界北=-z=屏幕上方） */
export interface RadarBlip {
  /** 世界东向偏移（米，正=目标在玩家东侧；屏幕 x 轴） */
  readonly x: number;
  /** 世界北向偏移（米，正=目标在玩家北侧；屏幕 y 轴向上为负） */
  readonly y: number;
  /** 光点种类 */
  readonly kind: RadarBlipKind;
}

/** 屏幕标记种类（全目标标记系统） */
export type MarkerKind = 'enemy' | 'bomber' | 'ally' | 'wingman' | 'ground' | 'missile';

/** 屏幕标记条目（世界层输出的标记源数据，渲染层投影为屏幕坐标） */
export interface MarkerInfo {
  /** 目标实体 ID（渲染层投影用） */
  readonly id: number;
  /** 标记种类 */
  readonly kind: MarkerKind;
  /** 与玩家距离（米，标记框下显示） */
  readonly distance: number;
  /** 是否来袭导弹（追踪玩家的敌方导弹，高威胁红色标记） */
  readonly incoming: boolean;
}

/**
 * 玩家飞行快照（供 HUD 每帧读取的纯数据视图）
 *
 * 功能：将玩家实体与其组件的当前状态投影为扁平只读结构，
 * 并附带锁定状态、告警状态与雷达光点数据，
 * 避免 UI 层直接触碰实体内部字段。
 */
export interface PlayerFlightSnapshot {
  /** 玩家是否存活（坠毁后为 false，HUD 据此显示重置提示） */
  readonly alive: boolean;
  /** 是否处于地面滑跑状态 */
  readonly onGround: boolean;
  /** 是否失速 */
  readonly stalled: boolean;
  /** 空速（km/h） */
  readonly speedKmh: number;
  /** 高度（米） */
  readonly altitudeM: number;
  /** 法向过载（G） */
  readonly gLoad: number;
  /** 油门开度 0..1 */
  readonly throttle: number;
  /** 机体剩余生命值 */
  readonly hp: number;
  /** 机体生命值上限 */
  readonly hpMax: number;
  /** 机炮剩余弹药 */
  readonly ammo: number;
  /** 机炮弹药基数 */
  readonly ammoMax: number;
  /** 导弹剩余数量 */
  readonly missileAmmo: number;
  /** 导弹弹药基数 */
  readonly missileAmmoMax: number;
  /** 干扰弹剩余数量 */
  readonly flareCount: number;
  /** 干扰弹携带基数 */
  readonly flareCountMax: number;
  /** 特殊武器名称（机型专属，HUD 显示） */
  readonly specialName: string;
  /** 特殊武器剩余弹药 */
  readonly specialAmmo: number;
  /** 特殊武器弹药基数 */
  readonly specialAmmoMax: number;
  /** 特殊武器类型（HUD 图标/提示用） */
  readonly specialType: string;
  /** 机炮装填剩余秒数（装填中为正数；未装填为 null） */
  readonly gunReloadRemain: number | null;
  /** 导弹装填剩余秒数（装填中为正数；未装填为 null） */
  readonly missileReloadRemain: number | null;
  /** 干扰弹装填剩余秒数（装填中为正数；未装填为 null） */
  readonly flareReloadRemain: number | null;
  /** 特殊武器装填剩余秒数（装填中为正数；未装填为 null） */
  readonly specialReloadRemain: number | null;
  /** 最佳机动速度 corner speed（km/h，HUD CNR 指示显示） */
  readonly bestManeuverSpeedKmh: number;
  /** 当前选中武器类型（R 循环切换，HUD 武器面板高亮） */
  readonly selectedWeapon: 'gun' | 'missile' | 'special';
  /** 机型代号（HUD/结算展示） */
  readonly fighterName: string;
  /** 僚机指令（HUD 指令显示） */
  readonly wingmanCommand: WingmanCommand;
  /** 存活僚机数量 */
  readonly wingmenAlive: number;
  /** 僚机总数 */
  readonly wingmenTotal: number;
  /** 锁定状态：none=锥内无目标 / locking=锁定中 / locked=锁定完成 */
  readonly lockState: 'none' | 'locking' | 'locked';
  /** 锁定进度 0..1 */
  readonly lockProgress: number;
  /** 锁定目标实体 ID（HUD 屏幕锁定框定位用；无目标为 null） */
  readonly lockTargetId: number | null;
  /** 锁定目标机型名（敌机/轰炸机型号，锁定框显示；无目标为空串） */
  readonly lockTargetName: string;
  /** 锁定目标距离（米；无目标为 0） */
  readonly lockTargetDistance: number;
  /** 导弹来袭告警（有敌方导弹正追踪玩家） */
  readonly missileWarning: boolean;
  /** 被敌机瞄准告警（有敌机在包线内机头对准玩家） */
  readonly lockWarning: boolean;
  /** 累计击毁练习靶标数 */
  readonly kills: number;
  /** 累计击坠敌机数 */
  readonly enemyKills: number;
  /** 雷达光点列表（north-up 固定方位：东=x 右 / 北=y 上） */
  readonly radarBlips: readonly RadarBlip[];
  /** 玩家航向角（度，0=正北顺时针，雷达航向箭头旋转用） */
  readonly playerHeadingDeg: number;
  /** 全目标屏幕标记列表（敌机/轰炸机/地面/友军/僚机/来袭导弹） */
  readonly markers: readonly MarkerInfo[];
}

/**
 * 模拟世界：全部模拟实体与规则推进的宿主
 *
 * 功能：管理实体生命周期（生成/回收），按固定步长编排子系统
 * （玩家飞行 → 敌机 AI → 任务系统 → 锁定追踪 → 玩家武器 →
 * 导弹制导 → 干扰弹步进 → 机炮弹丸 → 死亡播报 → 回收），
 * 并维护事件队列、击坠统计与玩家锁定追踪器；
 * 敌方目标由任务系统按生成表动态入场，任务结束停止模拟推进。
 * 边界约定：本层不持有任何渲染对象；仅使用 three 的纯数学类
 * （Vector3/Quaternion）承载与计算状态，不触碰场景图/WebGL。
 */
export class SimulationWorld {
  /** 实体列表（渲染桥遍历与同步用） */
  private readonly entities: SimEntity[] = [];
  /** 下一个待分配的实体 ID */
  private nextId = 1;
  /** 模拟累计时间（秒） */
  private elapsed = 0;
  /** 玩家实体引用（生成后常驻；坠毁后实体死亡但引用保留供重置） */
  private player: SimEntity | null = null;
  /** 待消费的模拟事件队列（渲染帧取走） */
  private events: GameEvent[] = [];
  /** 玩家导弹锁定追踪器 */
  private readonly lockTracker = new LockTracker();
  /** 任务系统 */
  readonly mission = new MissionSystem();
  /** 累计击毁练习靶标数 */
  private kills = 0;
  /** 玩家死亡事件是否已播报（防止撞地/被击落路径重复播报 player-crash） */
  private playerDeathReported = false;
  /** 轰炸机/友军朝向目标点复用向量 */
  private readonly _headingTarget = new Vector3();

  /** 玩家所选战机配置（spawnPlayer 时确定） */
  private playerFighter: FighterConfig | null = null;

  /** 当前选中武器类型（R 键循环：gun→missile→special→gun） */
  private selectedWeapon: 'gun' | 'missile' | 'special' = 'gun';

  /** 敌机机型名轮询计数器（生成敌机时依次取 typeNames） */
  private enemyTypeIndex = 0;

  /**
   * 生成玩家战机（按所选机型装配属性与武器）
   *
   * 功能：在跑道南端生成玩家实体（机头沿跑道方向 -Z），
   * 按机型配置表初始化——飞行性能参数包（速度/机动/G限/起飞速度）、
   * 生命值（装甲）、机炮/标准导弹/干扰弹基数与专属特殊武器挂载
   * @param fighterId 机型 ID（'kestrel' | 'bastion' | 'falcon'；
   *        未知 ID 回落缺省机型）
   * @returns 玩家实体
   * 异常：无
   * 注意事项：重复调用会生成多个玩家实体，调用方保证仅一次；
   * 机型配置同时记录在 playerFighter 供渲染层配色与快照读取
   */
  spawnPlayer(fighterId: string = DEFAULT_FIGHTER_ID): SimEntity {
    const fighter = getFighterById(fighterId) ?? getFighterById(DEFAULT_FIGHTER_ID)!;
    this.playerFighter = fighter;
    const entity = this.spawn('aircraft', PLAYER_SPAWN);
    entity.variant = 'player';
    entity.aircraft = createAircraftData(true, fighter.stats);
    entity.health = createHealthData(fighter.stats.hp, playerCfg.hitRadius);
    entity.gun = createGunData(fighter.stats.gunAmmo, fighter.stats.gunReloadTime);
    entity.missiles = createMissilesData(fighter.stats.missileAmmo, fighter.stats.missileReloadTime);
    entity.flares = createFlaresData(fighter.stats.flareCount, fighter.stats.flareReloadTime);
    entity.specialPod = createSpecialWeaponPod(fighter);
    this.player = entity;
    return entity;
  }

  /**
   * 获取玩家所选战机配置
   *
   * @returns 机型配置；玩家未生成时返回 null
   */
  getPlayerFighter(): FighterConfig | null {
    return this.playerFighter;
  }

  /** 当前僚机指令（全局，下发到全部僚机） */
  private wingmanCommand: WingmanCommand = 'formation';

  /**
   * 生成僚机编队（随玩家起飞入场）
   *
   * 功能：在跑道上玩家两侧后方生成配置数量的僚机实体——
   * 挂载飞行数据（地面滑跑态）、生命值、机炮/导弹/干扰弹
   * 与僚机 AI 状态（formation 指令）
   * @returns 生成的僚机实体数组
   * 异常：无
   * 注意事项：在 spawnPlayer 之后调用（僚机跟随玩家）；
   * 僚机使用基准飞行参数（与敌机一致）
   */
  spawnWingmen(): SimEntity[] {
    const created: SimEntity[] = [];
    const player = this.player;
    if (player === null) {
      return created;
    }
    for (let i = 0; i < wingmanCfg.count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const position = new Vector3(
        PLAYER_SPAWN.x + side * 30,
        PLAYER_SPAWN.y,
        PLAYER_SPAWN.z + 40 + i * 25,
      );
      const entity = this.spawn('aircraft', position);
      entity.variant = 'wingman';
      entity.aircraft = createAircraftData(true);
      entity.health = createHealthData(wingmanCfg.hp, wingmanCfg.hitRadius);
      entity.gun = createGunData(wingmanCfg.gunAmmo, reloadCfg.gun);
      entity.missiles = createMissilesData(wingmanCfg.missileAmmo, reloadCfg.missile);
      entity.flares = createFlaresData(flareCfg.count, reloadCfg.flare);
      entity.wingman = createWingmanAIState();
      entity.wingman.command = this.wingmanCommand;
      created.push(entity);
    }
    return created;
  }

  /**
   * 循环僚机指令（玩家按键边沿触发时调用）
   *
   * 功能：按 formation → attack → cover → formation 顺序切换全局指令，
   * 并立即下发到全部僚机 AI 状态
   * @returns void
   * 异常：无
   */
  cycleWingmanCommand(): void {
    const index = WINGMAN_COMMAND_CYCLE.indexOf(this.wingmanCommand);
    this.wingmanCommand = WINGMAN_COMMAND_CYCLE[(index + 1) % WINGMAN_COMMAND_CYCLE.length]!;
    for (const entity of this.entities) {
      if (entity.variant === 'wingman' && entity.wingman !== undefined) {
        entity.wingman.command = this.wingmanCommand;
      }
    }
    this.events.push({ type: 'wingman-command', command: this.wingmanCommand });
  }

  /**
   * 获取当前僚机指令
   *
   * @returns 指令模式
   */
  getWingmanCommand(): WingmanCommand {
    return this.wingmanCommand;
  }

  /**
   * 生成空中静态练习靶标群（自由飞行模式用，任务模式不生成）
   *
   * 功能：按固定布点生成练习靶标实体（挂生命值组件）
   * @returns 生成的靶标实体数组
   * 异常：无
   * 注意事项：靶标为静态实体（不参与飞行积分），仅被弹丸命中系统消费
   */
  spawnPracticeTargets(): SimEntity[] {
    const created: SimEntity[] = [];
    for (const [x, y, z] of [
      [0, 500, -1500],
      [-600, 350, -2200],
      [700, 450, -2600],
      [-1200, 700, -3200],
      [900, 900, -3600],
      [0, 1100, -4200],
      [-1800, 550, -4800],
      [1500, 1200, -5200],
    ] as const) {
      const entity = this.spawn('aircraft', new Vector3(x, y, z));
      entity.variant = 'practice-target';
      entity.health = createHealthData(40, 14);
      created.push(entity);
    }
    return created;
  }

  /**
   * 生成敌机编队（任务系统生成表回调）
   *
   * 功能：按位置列表生成敌机实体——战斗机（AI 状态机驱动）或
   * 轰炸机（直线巡航），初始朝向玩家，挂载对应组件并登记任务系统
   * @param positions 生成位置列表 [x, y, z]
   * @param bombers 是否轰炸机（true=拦截目标直线巡航，false=战斗机 AI）
   * @returns 生成的实体数组
   * 异常：无
   * 注意事项：轰炸机无 AI/武器组件，仅挂生命值与飞行数据直线飞行；
   * 战斗机初始姿态水平朝向玩家出生点
   */
  spawnEnemyWave(
    positions: readonly (readonly [number, number, number])[],
    bombers: boolean,
  ): SimEntity[] {
    const created: SimEntity[] = [];
    for (const [x, y, z] of positions) {
      const position = new Vector3(x, y, z);
      const entity = this.spawn('aircraft', position);
      if (bombers) {
        entity.variant = 'bomber';
        entity.aircraft = createAircraftData(false);
        if (entity.aircraft !== undefined) {
          entity.aircraft.speed = mCfg.bombers.speed;
          entity.aircraft.throttle = 0.5;
        }
        entity.health = createHealthData(mCfg.bombers.hp, mCfg.bombers.hitRadius);
        entity.designation = enemyCfg.bomberTypeName;
        const [bx, by, bz] = mCfg.bombers.heading;
        this.faceTowards(entity, this._headingTarget.set(bx, by, bz));
        this.mission.registerBomber(entity.id);
      } else {
        entity.variant = 'enemy';
        entity.aircraft = createAircraftData(false);
        if (entity.aircraft !== undefined) {
          entity.aircraft.speed = enemyCfg.initialSpeed;
          entity.aircraft.throttle = 0.8;
        }
        entity.health = createHealthData(enemyCfg.hp, enemyCfg.hitRadius);
        entity.gun = createGunData(enemyCfg.gunAmmo, reloadCfg.gun);
        entity.missiles = createMissilesData(enemyCfg.missileAmmo, reloadCfg.missile);
        entity.flares = createFlaresData(flareCfg.count, reloadCfg.flare);
        entity.ai = createEnemyAIState();
        entity.designation =
          enemyCfg.typeNames[this.enemyTypeIndex % enemyCfg.typeNames.length] ?? 'Foe';
        this.enemyTypeIndex += 1;
        this.faceTowards(entity, PLAYER_SPAWN);
      }
      entity.prevQuaternion.copy(entity.quaternion);
      created.push(entity);
    }
    return created;
  }

  /**
   * 生成地面防空阵地目标（任务系统回调）
   *
   * 功能：按位置列表生成地面目标实体（kind='ground-target'，
   * 挂生命值组件，可被机炮/导弹摧毁）
   * @param positions 生成位置列表 [x, y, z]（y 为离地高度）
   * @returns 生成的实体数组
   * 异常：无
   * 注意事项：地面目标为静态实体，命中判定半径与配置一致
   */
  spawnGroundTargets(positions: readonly (readonly [number, number, number])[]): SimEntity[] {
    const created: SimEntity[] = [];
    for (const [x, y, z] of positions) {
      const entity = this.spawn('ground-target', new Vector3(x, y, z));
      entity.variant = 'ground-target-entity';
      entity.health = createHealthData(mCfg.groundTargets.hp, mCfg.groundTargets.hitRadius);
      created.push(entity);
    }
    return created;
  }

  /**
   * 生成友军护卫运输机（任务系统回调）
   *
   * 功能：按位置列表生成友军实体——直线巡航朝配置目标点，
   * 挂生命值组件并登记任务系统（护卫目标全灭判负）
   * @param positions 生成位置列表 [x, y, z]
   * @returns 生成的实体数组
   * 异常：无
   * 注意事项：友军无敌方 AI 行为，仅直线飞行等待玩家护航
   */
  spawnAllies(positions: readonly (readonly [number, number, number])[]): SimEntity[] {
    const created: SimEntity[] = [];
    for (const [x, y, z] of positions) {
      const position = new Vector3(x, y, z);
      const entity = this.spawn('aircraft', position);
      entity.variant = 'ally';
      entity.aircraft = createAircraftData(false);
      if (entity.aircraft !== undefined) {
        entity.aircraft.speed = mCfg.allies.speed;
        entity.aircraft.throttle = 0.5;
      }
      entity.health = createHealthData(mCfg.allies.hp, mCfg.allies.hitRadius);
      const [ax, ay, az] = mCfg.allies.heading;
      this.faceTowards(entity, this._headingTarget.set(ax, ay, az));
      entity.prevQuaternion.copy(entity.quaternion);
      this.mission.registerAlly(entity.id);
      created.push(entity);
    }
    return created;
  }

  /**
   * 生成实体
   *
   * 功能：创建模拟实体并加入世界实体列表
   * @param kind 实体类别
   * @param position 初始位置（米）
   * @param quaternion 初始姿态（可选，缺省为单位姿态）
   * @returns 新生成的实体
   * 异常：无
   * 注意事项：ID 自增分配，不回收复用；武器系统经回调间接调用本方法
   */
  spawn(kind: EntityKind, position: Vector3, quaternion?: Quaternion): SimEntity {
    const entity = new SimEntity(this.nextId++, kind, position, quaternion);
    this.entities.push(entity);
    return entity;
  }

  /**
   * 固定步长推进模拟
   *
   * 功能：任务未激活时仅推进玩家飞行（简报阶段可自由试飞）；
   * active 状态下按固定顺序编排——全实体插值快照 → 玩家重置判定 →
   * 玩家飞行积分 → 敌机 AI → 任务系统（生成表/目标/胜负）→
   * 玩家锁定追踪 → 玩家武器 → 导弹制导 → 干扰弹步进 →
   * 机炮弹丸步进 → 玩家死亡统一播报 → 死亡回收
   * @param dt 固定时间步长（秒），由主循环保证恒定
   * @param input 本固定步的玩家控制输入快照
   * @returns void
   * @throws 无（各子系统应自行处理内部异常，保持模拟循环稳定）
   * 注意事项：dt 必须恒定以保证模拟确定性与手感一致；
   * 任务结束后（victory/failed）除快照与回收外全部跳过，画面冻结
   */
  fixedUpdate(dt: number, input: ControlInput): void {
    // 1) 快照上一固定步状态（渲染插值基准）
    for (const entity of this.entities) {
      entity.snapshotPrev();
    }
    this.elapsed += dt;

    const player = this.player;
    const pushEvent = (event: GameEvent): void => {
      if (event.type === 'target-destroyed') {
        this.mission.reportDestroy(event.variant);
        if (event.variant === 'practice-target') {
          this.kills += 1;
        }
      }
      this.events.push(event);
    };

    // 玩家坠毁后按 R 重置（仅死亡状态响应；任务模式下 R 无效，
    // 任务失败由结算界面的重开按钮处理）
    if (input.reset && player !== null && !player.alive && !this.mission.isActive) {
      this.resetPlayer();
    }

    // 2) 玩家飞行积分（撞地死亡立即播报并置标记，被击落路径由步骤 9 补充检查）
    if (player !== null && player.alive) {
      integrateAircraftFlight(player, input, dt);
      if (!player.alive) {
        pushEvent({ type: 'player-crash', position: player.position.clone() });
        this.playerDeathReported = true;
        this.lockTracker.reset();
      }
    }

    if (!this.mission.isActive) {
      // 任务结束/未开始：跳过战斗模拟，仅回收死亡实体
      this.reapDeadEntities();
      return;
    }

    // 3) 敌机 AI（状态机 + 飞行积分 + 敌机武器 + 坠地播报）
    if (player !== null) {
      updateEnemyAI(
        this.entities,
        player,
        this.lockTracker.currentTargetId,
        this.lockTracker.isLocked,
        dt,
        (kind, position, quaternion) => this.spawn(kind, position, quaternion),
        pushEvent,
      );
      // 僚机 AI（编队/进攻/掩护 + 开火规避）
      updateWingmenAI(
        this.entities,
        player,
        dt,
        (kind, position, quaternion) => this.spawn(kind, position, quaternion),
        pushEvent,
      );
    }

    // 僚机指令循环（按键边沿）
    if (input.wingmanCommand) {
      this.cycleWingmanCommand();
    }

    // 4) 轰炸机与友军直线巡航（复用飞行模型，零杆量输入）
    for (const entity of this.entities) {
      if (
        entity.alive &&
        (entity.variant === 'bomber' || entity.variant === 'ally') &&
        entity.aircraft !== undefined
      ) {
        integrateAircraftFlight(entity, CRUISE_INPUT, dt);
        if (!entity.alive) {
          pushEvent({
            type: 'target-destroyed',
            position: entity.position.clone(),
            variant: entity.variant,
          });
        }
      }
    }

    // 5) 任务系统（生成表触发/目标统计/胜负判定）
    this.mission.update(
      dt,
      this.entities,
      (positions, bombers) => this.spawnEnemyWave(positions, bombers),
      (positions) => this.spawnGroundTargets(positions),
      (positions) => this.spawnAllies(positions),
    );

    // 玩家死亡 → 任务失败判定
    if (player !== null && !player.alive) {
      this.mission.reportPlayerDestroyed();
    }

    // 6) 玩家锁定追踪
    if (player !== null && player.alive) {
      this.lockTracker.update(player, this.entities, dt, pushEvent);
    }

    // 7) 玩家武器：R 循环切换选中武器 + 空格发射当前选中武器
    if (player !== null && player.alive) {
      tickMissilePod(player, dt);
      tickFlarePod(player, dt);
      if (player.specialPod !== undefined) {
        tickSpecialWeapon(player.specialPod, dt);
      }
      // R 键：循环切换武器类型 gun→missile→special→gun
      if (input.cycleWeapon) {
        this.selectedWeapon =
          this.selectedWeapon === 'gun'
            ? 'missile'
            : this.selectedWeapon === 'missile'
              ? 'special'
              : 'gun';
        pushEvent({ type: 'weapon-switched', weapon: this.selectedWeapon });
      }
      // X 键：手动循环切换锁定目标（锥内候选）
      if (input.switchTarget) {
        if (this.lockTracker.cycleTarget(player, this.entities)) {
          pushEvent({ type: 'lock-target-switched' });
        }
      }
      // 空格：按当前选中武器分派发射
      if (this.selectedWeapon === 'gun') {
        updateGun(player, input.fire, dt, (kind, position, quaternion) =>
          this.spawn(kind, position, quaternion),
        );
      } else if (this.selectedWeapon === 'missile') {
        if (input.fire && this.lockTracker.isLocked) {
          const targetId = this.lockTracker.currentTargetId;
          const target = targetId !== null ? this.findById(targetId) : undefined;
          if (target !== undefined) {
            launchMissile(
              player,
              target,
              (kind, position, quaternion) => this.spawn(kind, position, quaternion),
              pushEvent,
            );
          }
        }
      } else if (input.fire && player.specialPod !== undefined) {
        launchSpecialWeapon(
          player,
          this.lockTracker.currentTargetId,
          this.entities,
          (kind, position, quaternion) => this.spawn(kind, position, quaternion),
          pushEvent,
        );
      }
      // 干扰弹释放：按键边沿
      if (input.flare) {
        releaseFlares(
          player,
          (kind, position) => this.spawn(kind, position),
          pushEvent,
        );
      }
    }

    // 8) 导弹制导（追踪/诱偏/近炸/自毁）
    updateMissiles(this.entities, dt, pushEvent);

    // 9) 干扰弹步进
    updateFlares(this.entities, dt);

    // 10) 机炮弹丸步进与命中（可能击落玩家 → 统一播报）
    updateProjectiles(this.entities, dt, pushEvent);
    if (player !== null && !player.alive && !this.playerDeathReported) {
      pushEvent({ type: 'player-crash', position: player.position.clone() });
      this.playerDeathReported = true;
      this.mission.reportPlayerDestroyed();
    }
    if (player !== null && player.alive) {
      this.playerDeathReported = false;
    }

    // 11) 倒序回收死亡实体，保持列表紧凑
    this.reapDeadEntities();
  }

  /**
   * 倒序回收死亡实体（私有）
   *
   * 功能：遍历实体列表移除 alive=false 的实体，保持列表紧凑
   * @returns void
   */
  private reapDeadEntities(): void {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const entity = this.entities[i]!;
      if (!entity.alive) {
        this.entities.splice(i, 1);
      }
    }
  }

  /**
   * 重置玩家到跑道起点
   *
   * 功能：复活玩家实体并重建全部组件（飞行数据/生命值/机炮/导弹/
   * 干扰弹），位置姿态回到出生点，同步刷新 prev 快照避免渲染插值
   * 从旧坠毁点回扫，并重置锁定追踪器
   * @returns void
   * 异常：无
   * 注意事项：仅重置玩家（其他实体与任务计数保持现状），
   * 便于自由模式连续验证坠毁/重置流程
   */
  resetPlayer(): void {
    const player = this.player;
    if (player === null) {
      return;
    }
    const fighter = this.playerFighter;
    player.alive = true;
    player.position.copy(PLAYER_SPAWN);
    player.quaternion.identity();
    player.prevPosition.copy(PLAYER_SPAWN);
    player.prevQuaternion.identity();
    player.velocity.set(0, 0, 0);
    player.aircraft = createAircraftData(true, fighter?.stats);
    player.health = createHealthData(fighter?.stats.hp ?? playerCfg.hp, playerCfg.hitRadius);
    player.gun = createGunData(
      fighter?.stats.gunAmmo ?? gunCfg.ammo,
      fighter?.stats.gunReloadTime ?? reloadCfg.gun,
    );
    player.missiles = createMissilesData(
      fighter?.stats.missileAmmo ?? missileCfg.ammo,
      fighter?.stats.missileReloadTime ?? reloadCfg.missile,
    );
    player.flares = createFlaresData(
      fighter?.stats.flareCount ?? flareCfg.count,
      fighter?.stats.flareReloadTime ?? reloadCfg.flare,
    );
    if (fighter !== null) {
      player.specialPod = createSpecialWeaponPod(fighter);
    }
    this.lockTracker.reset();
    this.playerDeathReported = false;
  }

  /**
   * 获取实体只读列表
   *
   * @returns 全部存活实体的只读引用
   */
  getEntities(): readonly SimEntity[] {
    return this.entities;
  }

  /**
   * 获取玩家实体
   *
   * @returns 玩家实体；尚未生成时返回 null（含坠毁死亡的引用，供相机/ HUD 判断）
   */
  getPlayer(): SimEntity | null {
    return this.player;
  }

  /**
   * 获取模拟累计时间
   *
   * @returns 自世界创建以来的模拟时间（秒）
   */
  getElapsedTime(): number {
    return this.elapsed;
  }

  /**
   * 获取任务总剩余时间
   *
   * @returns 剩余秒数（任务未开始时返回配置总时长）
   */
  getMissionTimeRemaining(): number {
    return this.mission.isActive || this.mission.getStatus() !== 'briefing'
      ? Math.max(0, mCfg.timeLimit - this.missionElapsed())
      : mCfg.timeLimit;
  }

  /**
   * 获取任务已用时间（私有桥接）
   *
   * @returns 任务累计秒数
   */
  private missionElapsed(): number {
    return this.mission.getMissionElapsedTime();
  }

  /**
   * 生成玩家飞行快照（HUD 视图数据）
   *
   * 功能：将玩家实体与组件状态投影为扁平只读结构；计算锁定状态
   * （含锁定目标机型名与距离）、导弹来袭/被瞄准告警、玩家航向角、
   * 各武器装填剩余倒计时（装填中为秒数，否则 null）与最佳机动速度
   * （km/h）；遍历全部敌方/友方目标生成 north-up 固定方位雷达光点
   * （世界东=x 右 / 世界北=y 上，不随玩家航向滚转）与
   * 全目标屏幕标记列表（含来袭导弹）
   * @returns 玩家飞行快照；玩家未生成时返回 null
   * 异常：无
   * 注意事项：每渲染帧调用一次；雷达/标记坐标为平面投影
   * （忽略高度差），超出雷达半径的目标按方向钉在边缘；
   * 标记仅含追踪玩家的敌方导弹（incoming），玩家自射导弹不标
   */
  getPlayerFlightData(): PlayerFlightSnapshot | null {
    const player = this.player;
    if (player === null) {
      return null;
    }

    const blips: RadarBlip[] = [];
    const markers: MarkerInfo[] = [];
    let missileWarning = false;
    let lockWarning = false;
    let wingmenAlive = 0;

    const forward = new Vector3(0, 0, -1).applyQuaternion(player.quaternion);
    const rel = new Vector3();
    const enemyForward = new Vector3();

    // 玩家航向角（north-up 雷达航向箭头用：0=正北，顺时针为正）
    const playerHeadingDeg = (Math.atan2(forward.x, -forward.z) * 180) / Math.PI;

    for (const entity of this.entities) {
      if (!entity.alive) {
        continue;
      }

      // 雷达光点 + 屏幕标记：敌机/轰炸机/友军/僚机/地面目标
      if (
        entity.variant === 'enemy' ||
        entity.variant === 'bomber' ||
        entity.variant === 'ally' ||
        entity.variant === 'wingman' ||
        entity.variant === 'ground-target-entity'
      ) {
        if (entity.variant === 'wingman') {
          wingmenAlive += 1;
        }
        // north-up 固定方位：世界东(+x)=屏幕右，世界北(-z)=屏幕上
        rel.subVectors(entity.position, player.position);
        let x = rel.x;
        let y = -rel.z;
        const planarDistance = Math.hypot(x, y);
        if (planarDistance > radarCfg.range) {
          const scale = radarCfg.range / planarDistance;
          x *= scale;
          y *= scale;
        }
        const kind: RadarBlipKind =
          entity.variant === 'enemy'
            ? 'enemy'
            : entity.variant === 'bomber'
              ? 'bomber'
              : entity.variant === 'ally'
                ? 'ally'
                : entity.variant === 'wingman'
                  ? 'wingman'
                  : 'ground';
        blips.push({ x, y, kind });
        markers.push({
          id: entity.id,
          kind,
          distance: rel.length(),
          incoming: false,
        });
      }

      // 来袭导弹标记 + 告警：追踪玩家的敌方导弹（高威胁）
      if (
        entity.missile !== undefined &&
        entity.missile.targetId === player.id &&
        entity.projectile !== undefined &&
        entity.projectile.byEnemy
      ) {
        missileWarning = true;
        markers.push({
          id: entity.id,
          kind: 'missile',
          distance: entity.position.distanceTo(player.position),
          incoming: true,
        });
      }

      // 被瞄准告警：敌机在包线内且机头对准玩家
      if (entity.variant === 'enemy' && player.alive) {
        rel.subVectors(player.position, entity.position);
        const distance = rel.length();
        if (distance < enemyCfg.attackRange && distance > 1e-3) {
          enemyForward.set(0, 0, -1).applyQuaternion(entity.quaternion);
          if (rel.divideScalar(distance).dot(enemyForward) > 0.97) {
            lockWarning = true;
          }
        }
      }
    }

    const lockTargetId = this.lockTracker.currentTargetId;
    const lockState = this.lockTracker.isLocked
      ? 'locked'
      : lockTargetId !== null
        ? 'locking'
        : 'none';

    // 锁定目标机型名与距离（真实战机风格锁定框显示）
    let lockTargetName = '';
    let lockTargetDistance = 0;
    if (lockTargetId !== null) {
      const lockTarget = this.findById(lockTargetId);
      if (lockTarget !== undefined) {
        lockTargetName = lockTarget.designation ?? '';
        lockTargetDistance = lockTarget.position.distanceTo(player.position);
      }
    }

    return {
      alive: player.alive,
      onGround: player.aircraft?.onGround ?? true,
      stalled: player.aircraft?.stalled ?? false,
      speedKmh: (player.aircraft?.speed ?? 0) * 3.6,
      altitudeM: player.position.y,
      gLoad: player.aircraft?.gLoad ?? 1,
      throttle: player.aircraft?.throttle ?? 0,
      hp: player.health?.hp ?? 0,
      hpMax: player.health?.maxHp ?? playerCfg.hp,
      ammo: player.gun?.ammo ?? 0,
      ammoMax: this.playerFighter?.stats.gunAmmo ?? gunCfg.ammo,
      missileAmmo: player.missiles?.ammo ?? 0,
      missileAmmoMax: this.playerFighter?.stats.missileAmmo ?? missileCfg.ammo,
      flareCount: player.flares?.count ?? 0,
      flareCountMax: this.playerFighter?.stats.flareCount ?? flareCfg.count,
      specialName: player.specialPod?.config.name ?? '',
      specialAmmo: player.specialPod?.ammo ?? 0,
      specialAmmoMax: player.specialPod?.config.ammo ?? 0,
      specialType: player.specialPod?.config.type ?? '',
      gunReloadRemain: player.gun !== undefined && player.gun.reloadRemain > 0 ? player.gun.reloadRemain : null,
      missileReloadRemain:
        player.missiles !== undefined && player.missiles.reloadRemain > 0
          ? player.missiles.reloadRemain
          : null,
      flareReloadRemain:
        player.flares !== undefined && player.flares.reloadRemain > 0
          ? player.flares.reloadRemain
          : null,
      specialReloadRemain:
        player.specialPod !== undefined && player.specialPod.reloadRemain > 0
          ? player.specialPod.reloadRemain
          : null,
      bestManeuverSpeedKmh: (player.aircraft?.params.bestManeuverSpeed ?? gameConfig.flight.bestManeuverSpeed) * 3.6,
      selectedWeapon: this.selectedWeapon,
      fighterName: this.playerFighter?.name ?? '',
      wingmanCommand: this.wingmanCommand,
      wingmenAlive,
      wingmenTotal: wingmanCfg.count,
      lockState,
      lockProgress: this.lockTracker.progress,
      lockTargetId,
      lockTargetName,
      lockTargetDistance,
      missileWarning,
      lockWarning,
      kills: this.kills,
      enemyKills: this.mission.getEnemyKills(),
      radarBlips: blips,
      playerHeadingDeg,
      markers,
    };
  }

  /**
   * 消费模拟事件队列
   *
   * 功能：取走并清空自上次消费以来累积的全部模拟事件
   * （命中/击毁/坠毁/导弹/干扰弹/锁定），供 HUD 反馈与
   * 后续特效系统使用
   * @returns 事件数组（调用方获得所有权）
   * 异常：无
   * 注意事项：每渲染帧调用一次；事件仅在模拟步中产生，
   * 若渲染帧间无模拟步则返回空数组
   */
  consumeEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /**
   * 按 ID 查找存活实体（私有）
   *
   * @param id 实体 ID
   * @returns 实体；不存在或已死亡时返回 undefined
   */
  private findById(id: number): SimEntity | undefined {
    for (const entity of this.entities) {
      if (entity.id === id && entity.alive) {
        return entity;
      }
    }
    return undefined;
  }

  /** faceTowards 复用：水平朝向向量 */
  private readonly _faceDir = new Vector3();
  /** faceTowards 复用：Y 轴常量 */
  private static readonly _Y_AXIS = new Vector3(0, 1, 0);

  /**
   * 将实体机头水平指向目标点（私有）
   *
   * 功能：构造使实体 -Z 轴水平指向目标点的偏航四元数（俯仰/滚转归零），
   * 用于敌机/轰炸机/友军生成时的初始朝向
   * @param entity 目标实体
   * @param targetPoint 注视点（世界坐标）
   * @returns void
   */
  private faceTowards(entity: SimEntity, targetPoint: Vector3): void {
    this._faceDir.subVectors(targetPoint, entity.position);
    this._faceDir.y = 0;
    if (this._faceDir.lengthSq() < 1e-6) {
      return;
    }
    this._faceDir.normalize();
    // 期望前向（-Z = faceDir）对应的四元数：绕 Y 轴旋转
    const angle = Math.atan2(-this._faceDir.x, -this._faceDir.z);
    entity.quaternion.setFromAxisAngle(SimulationWorld._Y_AXIS, angle);
  }
}
