import { Vector3 } from 'three';
import type { Quaternion } from 'three';
import { gameConfig } from '../config';
import type { EntityKind, SimEntity } from './entity';
import { createMissileData, createProjectileData, tickReloadState, triggerReloadIfEmpty } from './components';
import type { GameEvent } from './events';
import { applyDamage, orientAlongVelocity } from './gunSystem';

/** 导弹配置的模块级引用 */
const missileCfg = gameConfig.missile;
/** 干扰弹配置的模块级引用（诱偏判定） */
const flareCfg = gameConfig.flare;

/** 锁定锥半角余弦（模块级预计算：目标方向与机头夹角小于锥角即在锥内） */
const LOCK_CONE_COS = Math.cos((missileCfg.lockConeDeg * Math.PI) / 180);

/** 模块级复用对象：机头前向向量 */
const _forward = new Vector3();
/** 模块级复用对象：目标相对位置向量 */
const _toTarget = new Vector3();
/** 模块级复用对象：导弹当前飞行方向 */
const _missileDir = new Vector3();
/** 模块级复用对象：期望追踪方向 */
const _desiredDir = new Vector3();
/** 模块级复用对象：转向旋转轴 */
const _turnAxis = new Vector3();
/** 模块级复用对象：导弹发射位置（机腹偏移） */
const _launchPos = new Vector3();
/** 模块级复用对象：导弹初始速度 */
const _launchVelocity = new Vector3();
/** 世界坐标下方向常量（机腹偏移计算） */
const DOWN = new Vector3(0, -1, 0);

/**
 * 玩家导弹锁定追踪器
 *
 * 功能：每固定步扫描玩家机头前方锁定锥内的候选目标（敌机/靶标等
 * 一切挂生命值的实体），选取锥角最小者累计锁定时间——
 * 保持 lockTime 秒完成锁定（播报 lock-acquired）；
 * 目标出锥/超距/死亡即丢失（播报 lock-lost）并清零进度。
 * 注意事项：锁定状态为纯数据，供导弹发射条件、敌机规避触发
 * 与 HUD 锁定框显示三处消费
 */
export class LockTracker {
  /** 当前锁定候选目标实体 ID（null=锥内无目标） */
  private targetId: number | null = null;
  /** 锥内持续保持时间（秒） */
  private holdTime = 0;
  /** 锁定是否完成 */
  private locked = false;
  /** 手动目标切换偏移（X 键循环候选列表用；0=自动选最佳） */
  private manualIndex = 0;

  /**
   * 手动循环切换锁定目标（X 键边沿触发）
   *
   * 功能：收集锁定锥内全部候选（按锥角排序），将手动索引偏移 +1
   * 并循环回绕；下次 update 时按 manualIndex 选取候选；
   * 锁定进度随目标切换清零
   * @param player 玩家实体
   * @param entities 世界实体列表
   * @returns 是否切换成功（锥内无候选或多候选不足时返回 false）
   * 异常：无
   * 注意事项：候选不足 2 个时无切换意义，返回 false；
   * 切换后锁定状态重置为未锁定（需重新保持锁定时间）
   */
  cycleTarget(player: SimEntity, entities: readonly SimEntity[]): boolean {
    const candidates = this.collectCandidates(player, entities);
    if (candidates.length < 2) {
      return false;
    }
    this.manualIndex = (this.manualIndex + 1) % candidates.length;
    // 手动切换后清除当前锁定，update 将按 manualIndex 重选
    this.targetId = null;
    this.holdTime = 0;
    this.locked = false;
    return true;
  }

  /**
   * 收集锁定锥内全部候选目标（按锥角降序=机头夹角升序，私有）
   *
   * 功能：扫描锁定锥与射程内的全部可锁定实体（挂生命值且存活），
   * 按机头夹角余弦降序排列（最接近机头者在前）
   * @param player 玩家实体
   * @param entities 世界实体列表
   * @returns 候选实体 ID 列表（空=锥内无目标）
   * 异常：无
   */
  private collectCandidates(player: SimEntity, entities: readonly SimEntity[]): number[] {
    _forward.set(0, 0, -1).applyQuaternion(player.quaternion);
    const candidates: { id: number; cos: number }[] = [];
    for (const candidate of entities) {
      if (candidate === player || !candidate.alive || candidate.health === undefined) {
        continue;
      }
      _toTarget.subVectors(candidate.position, player.position);
      const distance = _toTarget.length();
      if (distance > missileCfg.lockRange || distance < 1e-3) {
        continue;
      }
      _toTarget.divideScalar(distance);
      const cosAngle = _toTarget.dot(_forward);
      if (cosAngle > LOCK_CONE_COS) {
        candidates.push({ id: candidate.id, cos: cosAngle });
      }
    }
    candidates.sort((a, b) => b.cos - a.cos);
    return candidates.map((c) => c.id);
  }

  /**
   * 更新锁定状态（单个固定步）
   *
   * 功能：扫描锁定锥内候选目标→按手动索引偏移选取（manualIndex=0
   * 时自动选锥角最近者）→累计/重置保持时间→完成锁定或丢失锁定
   * 时播报事件
   * @param player 玩家实体（存活状态由调用方保证）
   * @param entities 世界实体列表（候选目标来源）
   * @param dt 固定时间步长（秒）
   * @param pushEvent 世界层事件播报回调
   * @returns void
   * 异常：无
   * 注意事项：目标在锥内但已死亡时立即丢失；切换候选目标时进度清零；
   * 手动切换（cycleTarget）后自动回退到手动指定的候选
   */
  update(
    player: SimEntity,
    entities: readonly SimEntity[],
    dt: number,
    pushEvent: (event: GameEvent) => void,
  ): void {
    const candidateIds = this.collectCandidates(player, entities);

    if (candidateIds.length === 0) {
      // 锥内无目标：丢失锁定（若有），手动偏移重置
      this.manualIndex = 0;
      this.loseLock(pushEvent);
      return;
    }
    // 按手动索引选取候选（越界回绕钳制到自动最佳）
    const index = Math.min(this.manualIndex, candidateIds.length - 1);
    const bestId = candidateIds[index]!;

    if (this.targetId !== bestId) {
      // 切换候选目标：进度清零重新累计
      this.targetId = bestId;
      this.holdTime = 0;
      if (this.locked) {
        this.locked = false;
        pushEvent({ type: 'lock-lost' });
      }
      return;
    }
    if (this.locked) {
      return; // 已锁定：保持（目标死亡由下一扫描步的 alive 检查处理）
    }
    this.holdTime += dt;
    if (this.holdTime >= missileCfg.lockTime) {
      this.locked = true;
      pushEvent({ type: 'lock-acquired', targetId: bestId });
    }
  }

  /**
   * 清空锁定状态并播报丢失事件（私有）
   *
   * @param pushEvent 世界层事件播报回调
   */
  private loseLock(pushEvent: (event: GameEvent) => void): void {
    const hadLock = this.targetId !== null;
    this.targetId = null;
    this.holdTime = 0;
    if (this.locked || hadLock) {
      this.locked = false;
      pushEvent({ type: 'lock-lost' });
    }
  }

  /** 当前锁定目标实体 ID（null=无） */
  get currentTargetId(): number | null {
    return this.targetId;
  }

  /** 锁定是否完成 */
  get isLocked(): boolean {
    return this.locked;
  }

  /** 锁定进度 0..1（完成时为 1，HUD 进度条用） */
  get progress(): number {
    return this.locked ? 1 : Math.min(this.holdTime / missileCfg.lockTime, 1);
  }

  /**
   * 强制重置锁定状态（玩家重置时调用）
   *
   * @returns void
   */
  reset(): void {
    this.targetId = null;
    this.holdTime = 0;
    this.locked = false;
    this.manualIndex = 0;
  }
}

/**
 * 递减导弹挂载冷却与装填倒计时（单个固定步）
 *
 * 功能：推进飞机实体的导弹发射冷却计时；装填中时递减倒计时，
 * 归零瞬间将导弹整弹匣回满
 * @param shooter 挂有导弹挂载组件的飞机实体
 * @param dt 固定时间步长（秒）
 * @returns void
 * 异常：无
 */
export function tickMissilePod(shooter: SimEntity, dt: number): void {
  const pod = shooter.missiles;
  if (pod === undefined) {
    return;
  }
  pod.cooldown = Math.max(0, pod.cooldown - dt);
  tickReloadState(pod, dt);
}

/**
 * 发射导弹（玩家与敌机通用）
 *
 * 功能：校验弹药、冷却与装填状态后，在载机机腹生成导弹实体——
 * 初速沿机头方向、追踪目标为指定实体；弹药递减、冷却重置、
 * 打空最后一发自动触发装填倒计时，并播报发射事件
 * @param shooter 发射者飞机实体（须挂有 missiles 组件）
 * @param target 追踪目标实体
 * @param spawnProjectile 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns 是否成功发射（弹药耗尽/冷却未完/装填中返回 false）
 * 异常：无
 * 注意事项：导弹出生位置在机腹下方偏前，避免与载机碰撞体干扰；
 * 导弹寿命由 projectile 组件承载，制导状态由 missile 组件承载
 */
export function launchMissile(
  shooter: SimEntity,
  target: SimEntity,
  spawnProjectile: (kind: EntityKind, position: Vector3, quaternion?: Quaternion) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): boolean {
  const pod = shooter.missiles;
  if (
    pod === undefined ||
    !shooter.alive ||
    pod.ammo <= 0 ||
    pod.cooldown > 0 ||
    pod.reloadRemain > 0
  ) {
    return false;
  }
  pod.ammo -= 1;
  pod.cooldown = missileCfg.cooldown;
  triggerReloadIfEmpty(pod);

  // 发射位置：机头前下方（机腹挂架）
  _forward.set(0, 0, -1).applyQuaternion(shooter.quaternion);
  _launchPos.copy(shooter.position).addScaledVector(_forward, 5).addScaledVector(DOWN, 2.5);

  // 初速：载机速度 + 机头方向 × 出膛速度
  _launchVelocity.copy(shooter.velocity).addScaledVector(_forward, missileCfg.launchSpeed);

  const missileEntity = spawnProjectile('projectile', _launchPos);
  missileEntity.variant = 'missile';
  missileEntity.velocity.copy(_launchVelocity);
  missileEntity.projectile = createProjectileData(
    missileCfg.damage,
    missileCfg.life,
    shooter.id,
    shooter.variant === 'enemy',
  );
  missileEntity.missile = createMissileData(target.id, missileCfg.launchSpeed);
  orientAlongVelocity(missileEntity);

  pushEvent({
    type: 'missile-launched',
    position: _launchPos.clone(),
    byPlayer: shooter.variant === 'player',
  });
  return true;
}

/**
 * 推进全部导弹：制导/诱偏/近炸/自毁（单个固定步）
 *
 * 功能：遍历导弹实体——寿命递减（归零脱靶自毁）、发动机加速、
 * 受限转向速率追踪目标（目标丢失则直飞）；来袭阶段对飞机目标执行
 * 单次诱偏判定（进入诱骗范围且目标有存活干扰弹时按概率改为追踪
 * 干扰弹）；近炸判定命中结算（对干扰弹命中即诱骗成功自毁）；
 * 触地消亡
 * @param entities 世界实体列表（含导弹/目标/干扰弹）
 * @param dt 固定时间步长（秒）
 * @param pushEvent 世界层事件播报回调
 * @returns void
 * 异常：无
 * 注意事项：内部构建 ID→实体映射供 O(1) 目标查询；
 * 诱偏为单次判定（decoyChecked 标记），总概率即配置概率不随步数累积
 */
export function updateMissiles(
  entities: readonly SimEntity[],
  dt: number,
  pushEvent: (event: GameEvent) => void,
): void {
  // 构建 ID→实体映射（目标查询用）
  const byId = new Map<number, SimEntity>();
  for (const entity of entities) {
    if (entity.alive) {
      byId.set(entity.id, entity);
    }
  }

  for (const missileEntity of entities) {
    if (
      missileEntity.kind !== 'projectile' ||
      !missileEntity.alive ||
      missileEntity.missile === undefined ||
      missileEntity.projectile === undefined
    ) {
      continue;
    }
    const data = missileEntity.missile;

    // 寿命归零 → 脱靶自毁
    missileEntity.projectile.remainingLife -= dt;
    if (missileEntity.projectile.remainingLife <= 0) {
      missileEntity.alive = false;
      pushEvent({ type: 'missile-miss', position: missileEntity.position.clone() });
      continue;
    }

    // 发动机加速至最大速度（特殊武器导弹按覆盖极速）
    const maxSpeed = data.maxSpeedOverride ?? missileCfg.maxSpeed;
    data.speed = Math.min(data.speed + missileCfg.accel * dt, maxSpeed);

    let target = byId.get(data.targetId);
    if (target !== undefined && !target.alive) {
      target = undefined; // 目标已死亡：直飞
    }

    // 诱偏判定：追踪飞机目标且导弹逼近至诱骗范围时单次掷骰
    if (
      target !== undefined &&
      target.aircraft !== undefined &&
      !data.decoyed &&
      !data.decoyChecked
    ) {
      if (missileEntity.position.distanceTo(target.position) < flareCfg.deceptionRange) {
        data.decoyChecked = true;
        const flare = findFlareOf(entities, target.id);
        if (flare !== undefined && Math.random() < flareCfg.deceptionProbability) {
          data.targetId = flare.id;
          data.decoyed = true;
          target = flare;
        }
      }
    }

    // 制导：受限转向速率朝目标转向；目标丢失则直飞
    _missileDir.copy(missileEntity.velocity);
    if (_missileDir.lengthSq() < 1e-8) {
      _missileDir.set(0, 0, -1);
    }
    if (target !== undefined) {
      _desiredDir.subVectors(target.position, missileEntity.position);
      if (_desiredDir.lengthSq() > 1e-6) {
        _desiredDir.normalize();
        const angle = _missileDir.angleTo(_desiredDir);
        if (angle > 1e-4) {
          _turnAxis.crossVectors(_missileDir, _desiredDir);
          if (_turnAxis.lengthSq() < 1e-10) {
            // 方向近乎相反：任取垂直轴掉头
            _turnAxis.set(_missileDir.y, _missileDir.z, -_missileDir.x);
          }
          _turnAxis.normalize();
          const turnRate = data.turnRateOverride ?? missileCfg.turnRate;
          const turnStep = Math.min(angle, turnRate * dt);
          _missileDir.applyAxisAngle(_turnAxis, turnStep).normalize();
        }
      }
    }
    missileEntity.velocity.copy(_missileDir).multiplyScalar(data.speed);
    missileEntity.position.addScaledVector(missileEntity.velocity, dt);
    orientAlongVelocity(missileEntity);

    // 触地消亡
    if (missileEntity.position.y <= 0) {
      missileEntity.alive = false;
      pushEvent({ type: 'missile-miss', position: missileEntity.position.clone() });
      continue;
    }

    // 近炸判定：对干扰弹用 flareFuse（诱骗成功自毁），其余用 proximityFuse
    if (target !== undefined) {
      const fuse = data.decoyed ? missileCfg.flareFuse : missileCfg.proximityFuse;
      if (missileEntity.position.distanceTo(target.position) < fuse) {
        if (data.decoyed) {
          missileEntity.alive = false;
          pushEvent({ type: 'missile-miss', position: missileEntity.position.clone() });
        } else {
          missileEntity.alive = false;
          pushEvent({ type: 'missile-hit', position: missileEntity.position.clone() });
          applyDamage(target, missileCfg.damage, pushEvent);
          // 干扰弹被命中后一并消亡
          if (target.flare !== undefined) {
            target.alive = false;
          }
        }
      }
    }
  }
}

/**
 * 查找指定释放者的存活干扰弹实体
 *
 * @param entities 世界实体列表
 * @param ownerId 释放者实体 ID
 * @returns 干扰弹实体；不存在时返回 undefined
 * 异常：无
 */
function findFlareOf(entities: readonly SimEntity[], ownerId: number): SimEntity | undefined {
  for (const entity of entities) {
    if (entity.alive && entity.flare !== undefined && entity.flare.ownerId === ownerId) {
      return entity;
    }
  }
  return undefined;
}

/**
 * 检查实体是否正被导弹追踪（告警判定用）
 *
 * @param entities 世界实体列表
 * @param targetId 待检查的实体 ID
 * @returns 存在追踪该实体的存活导弹时返回 true
 * 异常：无
 */
export function isMissileIncoming(entities: readonly SimEntity[], targetId: number): boolean {
  for (const entity of entities) {
    if (
      entity.alive &&
      entity.missile !== undefined &&
      entity.missile.targetId === targetId
    ) {
      return true;
    }
  }
  return false;
}
