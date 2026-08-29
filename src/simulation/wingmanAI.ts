import { Quaternion, Vector3 } from 'three';
import { gameConfig } from '../config';
import type { EntityKind, SimEntity } from './entity';
import type { GameEvent } from './events';
import type { ControlInput } from './flightModel';
import { integrateAircraftFlight } from './flightModel';
import { updateGun } from './gunSystem';
import { isMissileIncoming, launchMissile, tickMissilePod } from './missileSystem';
import { releaseFlares, tickFlarePod } from './flareSystem';

/** 僚机配置的模块级引用 */
const wingmanCfg = gameConfig.wingman;
/** 机炮配置的模块级引用（前置量计算） */
const gunCfg = gameConfig.gun;

/** 僚机机炮开火锥余弦（模块级预计算） */
const GUN_CONE_COS = Math.cos((wingmanCfg.gunConeDeg * Math.PI) / 180);
/** 僚机导弹发射锥余弦（模块级预计算） */
const MISSILE_CONE_COS = Math.cos((wingmanCfg.missileConeDeg * Math.PI) / 180);

/** 模块级复用对象：编队目标点 */
const _formationPoint = new Vector3();
/** 模块级复用对象：僚机到目标向量 */
const _toTarget = new Vector3();
/** 模块级复用对象：僚机机头方向 */
const _wingmanForward = new Vector3();
/** 模块级复用对象：玩家机头方向（编队点计算） */
const _playerForward = new Vector3();
/** 模块级复用对象：玩家右方向（编队点计算） */
const _playerRight = new Vector3();
/** 模块级复用对象：期望飞行方向 */
const _desired = new Vector3();
/** 模块级复用对象：机炮瞄准方向（前置量） */
const _aimDir = new Vector3();
/** 模块级复用对象：四元数逆（局部系变换） */
const _invQuat = new Quaternion();
/** 模块级复用对象：期望方向局部坐标 */
const _local = new Vector3();

/** 僚机空控制输入模板（油门由 AI 直写组件） */
const IDLE_CONTROL: ControlInput = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttleUp: false,
  throttleDown: false,
  fire: false,
  missile: false,
  flare: false,
  special: false,
  cycleSpecial: false,
  wingmanCommand: false,
  reset: false,
};

/**
 * 更新全部僚机 AI（单个固定步）
 *
 * 功能：遍历僚机实体，按玩家指令推进——
 * 1) 规避触发：有导弹追踪自己 → 规避机动 + 释放干扰弹；
 * 2) formation：平滑飞向玩家侧后下方编队位（到达后松杆巡航）；
 * 3) attack：选取最近敌机接敌，进入包线后机炮/导弹开火；
 * 4) cover：优先选取威胁玩家的敌机（距玩家近且咬尾玩家），
 *    无威胁时回落最近敌机；
 * 5) 控制律与敌机共用（局部系分解 + 低空保护）；
 * 6) 飞行积分 + 坠地死亡播报。
 * @param entities 世界实体列表
 * @param player 玩家实体
 * @param dt 固定时间步长（秒）
 * @param spawnEntity 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns void
 * 异常：无
 * 注意事项：僚机被击毁时跳过处理（伤害系统已播报）；
 * 指令由世界层在 fixedUpdate 前统一下发到 ai.command
 */
export function updateWingmenAI(
  entities: readonly SimEntity[],
  player: SimEntity,
  dt: number,
  spawnEntity: (kind: EntityKind, position: Vector3, quaternion?: Quaternion) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): void {
  // 僚机序号（编队左右侧位分配）
  let wingmanIndex = 0;

  for (const wingman of entities) {
    if (wingman.variant !== 'wingman' || !wingman.alive || wingman.wingman === undefined) {
      continue;
    }
    const ai = wingman.wingman;
    wingmanIndex += 1;

    tickMissilePod(wingman, dt);
    tickFlarePod(wingman, dt);
    ai.missileCooldown = Math.max(0, ai.missileCooldown - dt);

    // ---- 1) 规避触发：导弹来袭 ----
    const trackedByMissile = isMissileIncoming(entities, wingman.id);
    if (trackedByMissile) {
      if (ai.evadeTimer <= 0) {
        ai.evadeRollDir = Math.random() < 0.5 ? -1 : 1;
      }
      ai.evadeTimer = wingmanCfg.evadeDuration;
      releaseFlares(wingman, (kind, position) => spawnEntity(kind, position), pushEvent);
    } else {
      ai.evadeTimer = Math.max(0, ai.evadeTimer - dt);
    }

    // ---- 2) 规避机动：满杆滚转 + 拉杆 ----
    if (ai.evadeTimer > 0) {
      const evadeControl: ControlInput = {
        ...IDLE_CONTROL,
        pitch: 0.85,
        roll: ai.evadeRollDir,
      };
      integrateAircraftFlight(wingman, evadeControl, dt);
      if (wingman.aircraft !== undefined) {
        wingman.aircraft.throttle = 1;
      }
      reportCrashIfNeeded(wingman, pushEvent, 'evade');
      continue;
    }

    // ---- 3) 按指令分派行为 ----
    let control: ControlInput;
    let fireTarget: SimEntity | null = null;

    // 地面滑跑：直线满油门加速 + 起飞速度后拉杆爬升（不执行机动指令，
    // 避免滑跑阶段侧滚/俯仰失控坠毁）
    if (wingman.aircraft !== undefined && wingman.aircraft.onGround) {
      const groundSpeed = wingman.aircraft.speed;
      const rotateInput: ControlInput = {
        ...IDLE_CONTROL,
        pitch: groundSpeed >= 82 ? 0.7 : 0,
      };
      integrateAircraftFlight(wingman, rotateInput, dt);
      if (wingman.aircraft !== undefined) {
        wingman.aircraft.throttle = 1;
      }
      reportCrashIfNeeded(wingman, pushEvent, 'groundroll');
      continue;
    }

    // 离地爬升段：未达安全高度前保持直线爬升——用控制律朝
    // "当前位置 + 机头水平方向×500 + 上方 150"的目标点飞，
    // steerTowards 自动完成滚转回正与俯仰爬升（防盘旋螺旋）
    if (wingman.position.y < wingmanCfg.minAltitude + 60) {
      _wingmanForward.set(0, 0, -1).applyQuaternion(wingman.quaternion);
      if (_wingmanForward.y < 0.3) {
        _wingmanForward.y = 0;
        if (_wingmanForward.lengthSq() > 1e-6) {
          _wingmanForward.normalize();
          _desired
            .copy(wingman.position)
            .addScaledVector(_wingmanForward, 500)
            .add(new Vector3(0, 150, 0))
            .sub(wingman.position)
            .normalize();
          const climbControl = steerTowards(wingman, _desired);
          integrateAircraftFlight(wingman, climbControl, dt);
          if (wingman.aircraft !== undefined) {
            wingman.aircraft.throttle = 1;
          }
          reportCrashIfNeeded(wingman, pushEvent, 'climb');
          continue;
        }
      }
    }

    // 玩家仍在地面（或起飞初期远落后于僚机）：僚机保持缓慢爬升直线巡航
    // 等待，不回追身后的编队点（防掉头俯冲）——控制律朝水平前方
    // 500m + 上方 75m 目标点，自动滚转回正保持直线
    if (player.aircraft !== undefined && player.aircraft.onGround) {
      _wingmanForward.set(0, 0, -1).applyQuaternion(wingman.quaternion);
      _wingmanForward.y = 0;
      if (_wingmanForward.lengthSq() > 1e-6) {
        _wingmanForward.normalize();
        _desired
          .copy(wingman.position)
          .addScaledVector(_wingmanForward, 500)
          .add(new Vector3(0, 75, 0))
          .sub(wingman.position)
          .normalize();
        const waitControl = steerTowards(wingman, _desired);
        integrateAircraftFlight(wingman, waitControl, dt);
        if (wingman.aircraft !== undefined) {
          wingman.aircraft.throttle = 0.85;
        }
        reportCrashIfNeeded(wingman, pushEvent, 'wait');
        continue;
      }
    }

    if (ai.command === 'formation' || !player.alive) {
      // 编队跟随：飞向玩家侧后下方编队位
      computeFormationPoint(player, wingmanIndex, _formationPoint);
      _toTarget.subVectors(_formationPoint, wingman.position);
      const formationDistance = _toTarget.length();
      if (formationDistance > 1200) {
        // 远距追赶：朝玩家前方预判点飞（保持机头朝前，不掉头俯冲）
        _playerForward.set(0, 0, -1).applyQuaternion(player.quaternion);
        _desired
          .copy(player.position)
          .addScaledVector(_playerForward, 400)
          .sub(wingman.position)
          .normalize();
        control = steerTowards(wingman, _desired);
        if (wingman.aircraft !== undefined) {
          wingman.aircraft.throttle = 1;
        }
      } else if (
        formationDistance > wingmanCfg.formationArriveRadius
      ) {
        _desired.copy(_toTarget).normalize();
        control = steerTowards(wingman, _desired);
        if (wingman.aircraft !== undefined) {
          wingman.aircraft.throttle = 0.85;
        }
      } else {
        // 到达编队位：保持与玩家同向巡航
        _playerForward.set(0, 0, -1).applyQuaternion(player.quaternion);
        control = steerTowards(wingman, _playerForward);
        if (wingman.aircraft !== undefined) {
          wingman.aircraft.throttle = 0.75;
        }
      }
    } else {
      // attack/cover：选取目标
      const target = selectTarget(entities, player, wingman, ai.command);
      ai.targetId = target?.id ?? null;
      if (target === undefined) {
        // 无可接敌目标：回落编队跟随
        computeFormationPoint(player, wingmanIndex, _formationPoint);
        _desired.subVectors(_formationPoint, wingman.position).normalize();
        control = steerTowards(wingman, _desired);
        if (wingman.aircraft !== undefined) {
          wingman.aircraft.throttle = 0.9;
        }
      } else {
        _toTarget.subVectors(target.position, wingman.position);
        const distance = _toTarget.length();
        _wingmanForward.set(0, 0, -1).applyQuaternion(wingman.quaternion);
        const facingCos =
          distance > 1e-3 ? _toTarget.divideScalar(distance).dot(_wingmanForward) : 1;

        _desired.copy(_toTarget).normalize();
        control = steerTowards(wingman, _desired);
        if (wingman.aircraft !== undefined) {
          wingman.aircraft.throttle = 0.9;
        }
        if (facingCos > GUN_CONE_COS && distance < wingmanCfg.gunRange) {
          fireTarget = target;
        }
        // 导弹包线：冷却完成即发射
        if (
          facingCos > MISSILE_CONE_COS &&
          distance >= wingmanCfg.missileMinRange &&
          distance <= wingmanCfg.missileMaxRange &&
          ai.missileCooldown <= 0
        ) {
          if (launchMissile(wingman, target, spawnEntity, pushEvent)) {
            ai.missileCooldown = wingmanCfg.missileCooldown;
          }
        }
      }
    }

    // ---- 4) 飞行积分 ----
    integrateAircraftFlight(wingman, control, dt);

    // ---- 5) 机炮开火（带前置量） ----
    if (fireTarget !== null && wingman.alive) {
      computeLeadAim(wingman, fireTarget);
      updateGun(wingman, true, dt, spawnEntity, _aimDir);
    }

    reportCrashIfNeeded(wingman, pushEvent, ai.command);
  }
}

/**
 * 计算僚机编队目标点（私有）
 *
 * 功能：以玩家机体坐标系构造侧后下方编队位——
 * 1 号僚机（奇数）左侧、2 号僚机（偶数）右侧
 * @param player 玩家实体
 * @param wingmanIndex 僚机序号（1 起）
 * @param out 输出向量（写入世界坐标编队点）
 * @returns void
 * 异常：无
 */
function computeFormationPoint(player: SimEntity, wingmanIndex: number, out: Vector3): void {
  _playerForward.set(0, 0, -1).applyQuaternion(player.quaternion);
  _playerRight.set(1, 0, 0).applyQuaternion(player.quaternion);
  const side = wingmanIndex % 2 === 1 ? -1 : 1;
  out.copy(player.position);
  out.addScaledVector(_playerRight, side * wingmanCfg.formationSideOffset);
  out.addScaledVector(_playerForward, -wingmanCfg.formationBackOffset);
  out.y -= wingmanCfg.formationDownOffset;
}

/**
 * 选取僚机接敌目标（私有）
 *
 * 功能：attack 模式选最近敌机；cover 模式优先选"距玩家近且
 * 机头对准玩家"的威胁敌机（距玩家 coverThreatRange 内），
 * 无威胁回落最近敌机
 * @param entities 世界实体列表
 * @param player 玩家实体
 * @param wingman 僚机实体
 * @param command 当前指令
 * @returns 目标敌机；无可接敌目标时返回 undefined
 * 异常：无
 * 注意事项：cover 判定用敌机机头与"敌机→玩家"方向点积
 */
function selectTarget(
  entities: readonly SimEntity[],
  player: SimEntity,
  wingman: SimEntity,
  command: 'attack' | 'cover',
): SimEntity | undefined {
  let best: SimEntity | undefined;
  let bestScore = Infinity;

  for (const candidate of entities) {
    if (candidate.variant !== 'enemy' || !candidate.alive) {
      continue;
    }
    const toWingman = candidate.position.distanceTo(wingman.position);
    if (toWingman > wingmanCfg.engageRange) {
      continue;
    }
    let score = toWingman;
    if (command === 'cover') {
      const toPlayer = candidate.position.distanceTo(player.position);
      if (toPlayer < wingmanCfg.coverThreatRange) {
        // 威胁敌机：按玩家距离优先（咬尾权重）
        _wingmanForward.set(0, 0, -1).applyQuaternion(candidate.quaternion);
        _toTarget.subVectors(player.position, candidate.position).normalize();
        const tailing = _toTarget.dot(_wingmanForward);
        score = toPlayer - tailing * 500;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * 朝期望方向生成控制杆量（僚机版，与敌机控制律一致）
 *
 * 功能：期望方向→局部系分解→俯仰/滚转杆量，
 * 后半球拉杆掉头、低空满杆拉起保护
 * @param wingman 僚机实体
 * @param desired 期望方向（世界坐标单位向量）
 * @returns 控制输入快照
 * 异常：无
 */
function steerTowards(wingman: SimEntity, desired: Vector3): ControlInput {
  _invQuat.copy(wingman.quaternion).invert();
  _local.copy(desired).applyQuaternion(_invQuat);
  const frontness = -_local.z;

  let pitch = Math.min(Math.max(_local.y * 2.2, -1), 1);
  let roll = Math.min(Math.max(_local.x * 2.2, -1), 1);

  if (frontness < 0.1) {
    // 后半球：拉杆掉头（保持正俯仰爬升转弯，绝不俯冲掉头）
    pitch = Math.max(pitch, 0.9);
    roll = _local.x >= 0 ? 0.6 : -0.6;
  }
  // 低空保护：仅在期望方向不强烈向下时拉起（跟随玩家俯冲时尊重指令）
  if (wingman.position.y < wingmanCfg.minAltitude && _local.y > -0.2) {
    pitch = Math.max(pitch, 0.8);
  }
  // 俯仰下限：任何指令下僚机俯仰不低于小负值（防长时间俯冲积累下沉）
  pitch = Math.max(pitch, -0.35);

  return { ...IDLE_CONTROL, pitch, roll };
}

/**
 * 计算僚机机炮前置瞄准方向（私有）
 *
 * @param wingman 开火僚机
 * @param target 目标实体
 * @returns void（结果写入 _aimDir）
 * 异常：无
 */
function computeLeadAim(wingman: SimEntity, target: SimEntity): void {
  const distance = wingman.position.distanceTo(target.position);
  const timeToHit = distance / Math.max(gunCfg.muzzleSpeed, 1);
  _aimDir
    .copy(target.position)
    .addScaledVector(target.velocity, timeToHit)
    .sub(wingman.position)
    .normalize();
}

/**
 * 僚机坠地死亡播报（私有）
 *
 * @param wingman 僚机实体
 * @param pushEvent 事件回调
 * @param phase 坠毁时所处阶段标记（语义化调用点）
 * @returns void
 */
function reportCrashIfNeeded(
  wingman: SimEntity,
  pushEvent: (event: GameEvent) => void,
  _phase: string,
): void {
  if (!wingman.alive && wingman.aircraft !== undefined && wingman.aircraft.crashed) {
    pushEvent({
      type: 'target-destroyed',
      position: wingman.position.clone(),
      variant: 'wingman',
    });
  }
}
