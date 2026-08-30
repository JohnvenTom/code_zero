import { Quaternion, Vector3 } from 'three';
import { gameConfig } from '../config';
import type { EntityKind, SimEntity } from './entity';
import type { GameEvent } from './events';
import type { ControlInput } from './flightModel';
import { integrateAircraftFlight } from './flightModel';
import { updateGun } from './gunSystem';
import { isMissileIncoming, launchMissile, tickMissilePod } from './missileSystem';
import { releaseFlares, tickFlarePod } from './flareSystem';

/** 敌机配置的模块级引用 */
const enemyCfg = gameConfig.enemy;
/** 机炮配置的模块级引用（前置量计算用弹速） */
const gunCfg = gameConfig.gun;
/** 狗斗优化配置的模块级引用 */
const dogfightCfg = gameConfig.dogfight;

/** 机炮开火锥余弦（模块级预计算） */
const GUN_CONE_COS = Math.cos((enemyCfg.gunConeDeg * Math.PI) / 180);
/** 导弹发射锥余弦（模块级预计算） */
const MISSILE_CONE_COS = Math.cos((enemyCfg.missileConeDeg * Math.PI) / 180);

/** 模块级复用对象：期望飞行方向 */
const _desired = new Vector3();
/** 模块级复用对象：敌机到目标向量 */
const _toTarget = new Vector3();
/** 模块级复用对象：敌机机头方向 */
const _enemyForward = new Vector3();
/** 模块级复用对象：目标机头方向（咬尾判定/编队点） */
const _targetForward = new Vector3();
/** 模块级复用对象：追击占位点 */
const _standoffPoint = new Vector3();
/** 模块级复用对象：机炮瞄准方向（含前置量） */
const _aimDir = new Vector3();
/** 模块级复用对象：四元数逆（局部系变换） */
const _invQuat = new Quaternion();
/** 模块级复用对象：期望方向的局部坐标 */
const _local = new Vector3();

/** 空控制输入模板（油门由 AI 直写组件） */
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
 * 更新全部敌机 AI（单个固定步，狗斗强化版）
 *
 * 功能：遍历敌机实体，按状态机推进——
 * 1) 目标选择：交战对象在玩家与僚机间动态选取（距自身最近者，
 *    带粘性防抖 margin 防频繁切换）；
 * 2) 规避触发：被锁定/导弹来袭 → evade（滚转+拉杆+干扰弹）；
 * 3) 能量机动：attack 降油门保能量 / chase 全力追击；
 * 4) 近距格斗（merge 距离内）：侧滑规避机动（周期换向 weave）；
 * 5) 过顶脱离：交错后 breakAway 拉开距离再回转（防无限缠斗）；
 * 6) 被咬尾紧急规避：目标在正后锥内且近距 → 强规避权重；
 * 7) 包线开火：机炮锥+距离、导弹锥+包线；
 * 8) 飞行积分 + 坠地播报。
 * @param entities 世界实体列表
 * @param player 玩家实体（存活状态由调用方保证）
 * @param lockedTargetId 玩家锁定追踪器的当前目标 ID（无则 null）
 * @param playerLockCompleted 玩家锁定是否完成
 * @param dt 固定时间步长（秒）
 * @param spawnEntity 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns void
 * 异常：无
 * 注意事项：敌机被击毁时跳过本步处理，
 * 击毁事件由伤害结算系统统一播报
 */
export function updateEnemyAI(
  entities: readonly SimEntity[],
  player: SimEntity,
  lockedTargetId: number | null,
  playerLockCompleted: boolean,
  dt: number,
  spawnEntity: (kind: EntityKind, position: Vector3, quaternion?: Quaternion) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): void {
  for (const enemy of entities) {
    if (enemy.variant !== 'enemy' || !enemy.alive || enemy.ai === undefined) {
      continue;
    }
    const ai = enemy.ai;

    tickMissilePod(enemy, dt);
    tickFlarePod(enemy, dt);
    ai.missileCooldown = Math.max(0, ai.missileCooldown - dt);
    ai.breakAwayTimer = Math.max(0, ai.breakAwayTimer - dt);

    // ---- 1) 目标选择：玩家与僚机中最近者（带粘性） ----
    const target = selectCombatTarget(entities, player, enemy, ai);
    const targetAlive = target.alive;

    // ---- 距离与方位预计算 ----
    _toTarget.subVectors(target.position, enemy.position);
    const distance = _toTarget.length();
    _enemyForward.set(0, 0, -1).applyQuaternion(enemy.quaternion);
    const facingCos =
      distance > 1e-3 ? _toTarget.divideScalar(distance).dot(_enemyForward) : 1;

    // ---- 2) 规避触发：被玩家锁定或导弹来袭 ----
    const trackedByMissile = isMissileIncoming(entities, enemy.id);
    const lockedByPlayer =
      playerLockCompleted && lockedTargetId === enemy.id && player.alive;
    if (targetAlive && (trackedByMissile || lockedByPlayer)) {
      if (ai.mode !== 'evade') {
        ai.mode = 'evade';
        ai.evadeTimer = enemyCfg.evadeDuration;
        ai.evadeRollDir = Math.random() < 0.5 ? -1 : 1;
      } else {
        ai.evadeTimer = Math.max(ai.evadeTimer, enemyCfg.evadeDuration * 0.6);
      }
      releaseFlares(enemy, (kind, position) => spawnEntity(kind, position), pushEvent);
    }

    // ---- 3) 状态转移 ----
    if (ai.mode === 'evade') {
      ai.evadeTimer -= dt;
      if (ai.evadeTimer <= 0 && !trackedByMissile && !lockedByPlayer) {
        ai.mode = 'chase';
      }
    } else if (targetAlive) {
      if (distance < enemyCfg.breakOffRange) {
        ai.mode = 'chase'; // 过近脱离重新占位
      } else if (distance < enemyCfg.attackRange) {
        ai.mode = 'attack';
      } else {
        ai.mode = 'chase';
      }
    } else {
      ai.mode = 'chase'; // 目标死亡后恢复巡逻
    }

    // ---- 4) 控制律：按模式计算机动 ----
    let control: ControlInput;
    let aimAtTarget = false;

    if (ai.mode === 'evade') {
      // 规避：满杆滚转 + 拉杆的剧烈机动
      control = { ...IDLE_CONTROL, pitch: 0.85, roll: ai.evadeRollDir };
      if (enemy.aircraft !== undefined) {
        enemy.aircraft.throttle = 1;
      }
    } else if (ai.breakAwayTimer > 0) {
      // 过顶脱离：满杆滚转脱离交错区，保持一段时间后回转
      control = { ...IDLE_CONTROL, pitch: 0.4, roll: ai.evadeRollDir * 0.9 };
      if (enemy.aircraft !== undefined) {
        enemy.aircraft.throttle = dogfightCfg.chaseThrottle;
      }
    } else {
      // 追击：占位目标尾后上方；攻击：直指目标
      if (ai.mode === 'attack') {
        _desired.subVectors(target.position, enemy.position).normalize();
      } else {
        _targetForward.set(0, 0, -1).applyQuaternion(target.quaternion);
        _standoffPoint
          .copy(target.position)
          .addScaledVector(_targetForward, -enemyCfg.chaseStandoff);
        _standoffPoint.y += 180;
        _desired.subVectors(_standoffPoint, enemy.position).normalize();
      }
      control = steerTowards(enemy, _desired);

      // 近距格斗强化：merge 距离内叠加侧滑机动（周期换向）
      if (ai.mode === 'attack' && distance < dogfightCfg.mergeRange) {
        ai.weaveTimer -= dt;
        if (ai.weaveTimer <= 0) {
          ai.weaveTimer = dogfightCfg.weaveInterval * (0.7 + Math.random() * 0.6);
          ai.weaveDir = -ai.weaveDir;
        }
        control = {
          ...control,
          roll: Math.max(-1, Math.min(1, control.roll + ai.weaveDir * dogfightCfg.weaveAmount)),
          pitch: Math.max(-1, Math.min(1, control.pitch + 0.15)),
        };
      }

      // 被咬尾紧急规避：目标在敌机正后锥内且近距 → 强侧滑+拉杆
      if (distance < dogfightCfg.mergeRange) {
        _targetForward.set(0, 0, -1).applyQuaternion(target.quaternion);
        const targetFacingMe = _toTarget.clone().negate().normalize().dot(_targetForward);
        if (targetFacingMe > dogfightCfg.tailThreatCos) {
          control = {
            ...control,
            pitch: 0.95,
            roll: ai.weaveDir,
          };
        }
      }

      // 过顶交错触发脱离：距离极近且目标从侧/后方掠过
      if (distance < dogfightCfg.overshootRange && facingCos < 0.1) {
        ai.breakAwayTimer = dogfightCfg.breakAwayDuration;
        ai.evadeRollDir = Math.random() < 0.5 ? -1 : 1;
      }

      // 能量机动油门（低于最佳机动速度时全油门补能量，向 corner speed 收敛）
      if (enemy.aircraft !== undefined) {
        enemy.aircraft.throttle =
          enemy.aircraft.speed < enemy.aircraft.params.bestManeuverSpeed
            ? 1
            : ai.mode === 'attack'
              ? dogfightCfg.attackThrottle
              : dogfightCfg.chaseThrottle;
      }
      aimAtTarget = ai.mode === 'attack' && targetAlive;
    }

    // ---- 5) 飞行积分 ----
    integrateAircraftFlight(enemy, control, dt);

    // ---- 6) 武器：attack 模式进入包线后开火 ----
    if (aimAtTarget && enemy.alive && target.alive) {
      // 机炮：锥内且距离内，带前置量瞄准
      if (distance < enemyCfg.gunRange && facingCos > GUN_CONE_COS) {
        computeLeadAim(enemy, target);
        updateGun(enemy, true, dt, spawnEntity, _aimDir);
      }
      // 导弹：包线内且冷却完成
      if (
        distance >= enemyCfg.missileMinRange &&
        distance <= enemyCfg.missileMaxRange &&
        facingCos > MISSILE_CONE_COS &&
        ai.missileCooldown <= 0
      ) {
        if (launchMissile(enemy, target, spawnEntity, pushEvent)) {
          ai.missileCooldown = enemyCfg.missileCooldown;
        }
      }
    }

    // ---- 7) 坠地/积分死亡播报 ----
    if (!enemy.alive && enemy.aircraft !== undefined && enemy.aircraft.crashed) {
      pushEvent({
        type: 'target-destroyed',
        position: enemy.position.clone(),
        variant: 'enemy',
      });
    }
  }
}

/**
 * 选取敌机交战目标（私有）
 *
 * 功能：在玩家与僚机中选取距敌机最近的存活目标；
 * 带粘性——当前目标比新候选近 margin 米以内时不切换
 * （防止频繁抖动切换目标）
 * @param entities 世界实体列表
 * @param player 玩家实体
 * @param enemy 敌机实体
 * @param ai 敌机 AI 状态
 * @returns 交战目标实体（玩家或僚机）
 * 异常：无
 * 注意事项：僚机全灭时恒定返回玩家（即使玩家已坠毁，
 * 由调用方的 targetAlive 分支处理巡逻）
 */
function selectCombatTarget(
  entities: readonly SimEntity[],
  player: SimEntity,
  enemy: SimEntity,
  ai: NonNullable<SimEntity['ai']>,
): SimEntity {
  // 当前目标仍存活且粘性有效 → 保持
  if (ai.targetId !== null) {
    for (const entity of entities) {
      if (entity.id === ai.targetId && entity.alive) {
        const currentDistance = entity.position.distanceTo(enemy.position);
        // 粘性：无更近候选超 margin 时不切换
        let switchCandidate: SimEntity | null = null;
        let bestOther = Infinity;
        for (const other of entities) {
          if (other.id === ai.targetId || !other.alive) {
            continue;
          }
          if (other.variant !== 'player' && other.variant !== 'wingman') {
            continue;
          }
          const d = other.position.distanceTo(enemy.position);
          if (d < bestOther) {
            bestOther = d;
            switchCandidate = other;
          }
        }
        if (
          switchCandidate !== null &&
          bestOther + dogfightCfg.targetSwitchMargin < currentDistance
        ) {
          ai.targetId = switchCandidate.id;
          return switchCandidate;
        }
        return entity;
      }
    }
  }

  // 无有效当前目标：选最近存活目标（玩家优先级兜底）
  let best: SimEntity = player;
  let bestDistance = player.alive ? player.position.distanceTo(enemy.position) : Infinity;
  for (const entity of entities) {
    if (!entity.alive || entity.variant !== 'wingman') {
      continue;
    }
    const d = entity.position.distanceTo(enemy.position);
    if (d < bestDistance) {
      bestDistance = d;
      best = entity;
    }
  }
  ai.targetId = best.id;
  return best;
}

/**
 * 朝期望方向生成控制杆量（街机控制律）
 *
 * 功能：把期望飞行方向变换到敌机局部坐标系，按局部分量生成
 * 俯仰/滚转/偏航杆量——目标在上拉杆、在右右滚；后半球目标
 * 拉杆掉头；低空时强制拉起保护
 * @param enemy 敌机实体
 * @param desired 期望飞行方向（世界坐标单位向量）
 * @returns 控制输入快照
 * 异常：无
 * 注意事项：敌机油门由调用方直接写入组件（绕过输入平滑），
 * 故此处 throttleUp/Down 恒为 false
 */
function steerTowards(enemy: SimEntity, desired: Vector3): ControlInput {
  _invQuat.copy(enemy.quaternion).invert();
  _local.copy(desired).applyQuaternion(_invQuat);
  // 局部系：x=右，y=上，z=后（-z 为机头前向）
  const frontness = -_local.z;

  let pitch = Math.min(Math.max(_local.y * 2.2, -1), 1);
  let roll = Math.min(Math.max(_local.x * 2.2, -1), 1);
  const yaw = 0;

  // 后半球目标：拉杆掉头 + 持续滚转对齐
  if (frontness < 0.1) {
    pitch = 0.9;
    roll = _local.x >= 0 ? 0.6 : -0.6;
  }

  // 低空拉起保护：满杆拉起，优先于一切俯仰指令
  if (enemy.position.y < enemyCfg.minAltitude) {
    pitch = 1;
  }

  return { ...IDLE_CONTROL, pitch, roll, yaw };
}

/**
 * 计算机炮前置瞄准方向
 *
 * 功能：按"弹丸飞行时间 ≈ 距离/相对弹速"估计前置量，
 * 瞄准目标未来位置，写入模块级 _aimDir 供 updateGun 使用
 * @param enemy 开火敌机
 * @param target 目标实体
 * @returns void（结果写入 _aimDir）
 * 异常：无
 * 注意事项：粗略前置（未迭代求解），叠加随机散布后命中概率适中，
 * 构成威胁但留给玩家反应空间
 */
function computeLeadAim(enemy: SimEntity, target: SimEntity): void {
  const distance = enemy.position.distanceTo(target.position);
  const timeToHit = distance / Math.max(gunCfg.muzzleSpeed, 1);
  _aimDir
    .copy(target.position)
    .addScaledVector(target.velocity, timeToHit)
    .sub(enemy.position)
    .normalize();
}
