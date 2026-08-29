import { Vector3 } from 'three';
import { gameConfig } from '../config';
import type { FighterConfig, SpecialWeaponConfig } from '../config';
import type { EntityKind, SimEntity } from './entity';
import { createMissileData, createProjectileData, type SpecialWeaponPod } from './components';
import type { GameEvent } from './events';
import { orientAlongVelocity } from './gunSystem';

/** 导弹配置的模块级引用（远程导弹基础参数） */
const missileCfg = gameConfig.missile;

/** 模块级复用对象：机头前向向量 */
const _forward = new Vector3();
/** 模块级复用对象：机体右方向向量（集束散布） */
const _right = new Vector3();
/** 模块级复用对象：机体下方向向量（集束前下抛撒） */
const _down = new Vector3();
/** 模块级复用对象：破片生成位置 */
const _spawnPos = new Vector3();
/** 模块级复用对象：破片初速向量 */
const _spawnVelocity = new Vector3();

/**
 * 创建特殊武器挂载组件
 *
 * @param fighter 所选战机配置
 * @returns 特殊武器挂载组件
 * 异常：无
 */
export function createSpecialWeaponPod(fighter: FighterConfig): SpecialWeaponPod {
  return { ammo: fighter.special.ammo, cooldown: 0, config: fighter.special };
}

/**
 * 递减特殊武器冷却（单个固定步）
 *
 * @param pod 特殊武器挂载组件
 * @param dt 固定时间步长（秒）
 * @returns void
 * 异常：无
 */
export function tickSpecialWeapon(pod: SpecialWeaponPod, dt: number): void {
  pod.cooldown = Math.max(0, pod.cooldown - dt);
}

/**
 * 发射特殊武器（仅玩家使用）
 *
 * 功能：按特殊武器类型分派——
 * 1) multi-missile：锁定锥内最多 maxTargets 个目标同时各发射一枚
 *    追踪导弹（每目标独立制导，弹药按齐射次数消耗）；
 * 2) cluster-bomb：机腹向前下方抛撒 bombletCount 枚破片，
 *    破片为范围伤害弹丸（落点附近 blastRadius 内目标结算伤害）；
 * 3) long-range-missile：对锁定目标发射一枚高速远程导弹。
 * 冷却未完或弹药耗尽时静默失败。
 * @param player 玩家实体（须挂有 specialPod 与 lockTarget）
 * @param lockTargetId 锁定追踪器当前目标 ID（无锁定时 null，
 *        多目标/远程导弹需要锁定；集束炸弹无需锁定）
 * @param entities 世界实体列表（多目标检索候选）
 * @param spawnProjectile 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns 是否成功发射
 * 异常：无
 * 注意事项：多目标导弹在锥内不足 maxTargets 个目标时按实际数量发射
 * （至少需要 1 个锥内目标）；集束炸弹破片伤害由弹丸命中系统结算
 */
export function launchSpecialWeapon(
  player: SimEntity,
  lockTargetId: number | null,
  entities: readonly SimEntity[],
  spawnProjectile: (kind: EntityKind, position: Vector3, quaternion?: import('three').Quaternion) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): boolean {
  const pod = player.specialPod;
  if (pod === undefined || !player.alive || pod.ammo <= 0 || pod.cooldown > 0) {
    return false;
  }
  const config = pod.config;
  pod.ammo -= 1;
  pod.cooldown = 1.6;
  pushEvent({
    type: 'special-launched',
    position: player.position.clone(),
    weapon: config.type,
  });

  if (config.type === 'cluster-bomb') {
    return launchClusterBomb(player, config, spawnProjectile);
  }

  if (config.type === 'multi-missile') {
    return launchMultiMissile(player, config, entities, spawnProjectile, pushEvent);
  }

  // long-range-missile：需要锁定目标
  if (lockTargetId === null) {
    return true; // 弹药已消耗但未发射（HUD 提示锁定需求由快照层处理）
  }
  const target = entities.find((e) => e.id === lockTargetId && e.alive);
  if (target === undefined) {
    return true;
  }
  return launchLongRangeMissile(player, config, target, spawnProjectile, pushEvent);
}

/**
 * 发射对地集束炸弹（私有分片）
 *
 * 功能：从机腹向前下方锥形抛撒 bombletCount 枚破片——
 * 初速 = 载机速度 +（机头 + 随机散布角）×破片速度；
 * 破片为范围伤害弹丸（projectile 组件 blastRadius 标记）
 * @param player 玩家实体
 * @param config 特殊武器配置
 * @param spawnProjectile 世界层实体生成回调
 * @returns 是否成功（恒 true，弹药已在入口扣除）
 * 异常：无
 * 注意事项：破片带小半径范围伤害（弹着点附近全结算），
 * 由 updateProjectiles 的 blastRadius 分支处理
 */
function launchClusterBomb(
  player: SimEntity,
  config: SpecialWeaponConfig,
  spawnProjectile: (kind: EntityKind, position: Vector3, quaternion?: import('three').Quaternion) => SimEntity,
): boolean {
  const count = config.bombletCount ?? 10;
  const spread = config.spreadRad ?? 0.3;
  const speed = config.bombletSpeed ?? 200;
  const life = config.bombletLife ?? 2.5;

  _forward.set(0, 0, -1).applyQuaternion(player.quaternion);
  _right.set(1, 0, 0).applyQuaternion(player.quaternion);
  _down.set(0, -1, 0).applyQuaternion(player.quaternion);

  for (let i = 0; i < count; i++) {
    // 机腹偏后位置抛撒
    _spawnPos.copy(player.position).addScaledVector(_forward, 2).addScaledVector(_down, 3);
    // 散布方向：前下锥内随机
    _spawnVelocity
      .copy(_forward)
      .addScaledVector(_right, (Math.random() * 2 - 1) * spread)
      .addScaledVector(_down, 0.6 + Math.random() * spread)
      .normalize()
      .multiplyScalar(speed)
      .add(player.velocity);

    const bomblet = spawnProjectile('projectile', _spawnPos);
    bomblet.variant = 'tracer';
    bomblet.velocity.copy(_spawnVelocity);
    bomblet.projectile = createProjectileData(config.damage, life, player.id, false);
    bomblet.blastRadius = config.blastRadius ?? 24;
    orientAlongVelocity(bomblet);
  }
  return true;
}

/**
 * 发射多目标导弹（私有分片）
 *
 * 功能：扫描玩家机头锁定锥内目标（复用锁定锥角），取最近
 * maxTargets 个各发射一枚独立制导导弹
 * @param player 玩家实体
 * @param config 特殊武器配置
 * @param entities 世界实体列表
 * @param spawnProjectile 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns 是否成功（锥内无目标返回 false 且退还弹药）
 * 异常：无
 */
function launchMultiMissile(
  player: SimEntity,
  config: SpecialWeaponConfig,
  entities: readonly SimEntity[],
  spawnProjectile: (kind: EntityKind, position: Vector3, quaternion?: import('three').Quaternion) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): boolean {
  const maxTargets = config.maxTargets ?? 4;
  const turnRate = config.turnRate ?? 2.2;

  // 扫描锁定锥内候选（按距离升序）
  _forward.set(0, 0, -1).applyQuaternion(player.quaternion);
  const coneCos = Math.cos((missileCfg.lockConeDeg * Math.PI) / 180);
  const candidates: { entity: SimEntity; distance: number }[] = [];
  for (const candidate of entities) {
    if (candidate === player || !candidate.alive || candidate.health === undefined) {
      continue;
    }
    _spawnPos.subVectors(candidate.position, player.position);
    const distance = _spawnPos.length();
    if (distance > missileCfg.lockRange || distance < 1e-3) {
      continue;
    }
    if (_spawnPos.divideScalar(distance).dot(_forward) <= coneCos) {
      continue;
    }
    candidates.push({ entity: candidate, distance });
  }
  candidates.sort((a, b) => a.distance - b.distance);

  const targets = candidates.slice(0, maxTargets);
  if (targets.length === 0) {
    // 锥内无目标：退还弹药（未发射）
    const pod = player.specialPod;
    if (pod !== undefined) {
      pod.ammo += 1;
    }
    return false;
  }

  for (const { entity: target } of targets) {
    spawnSpecialMissile(player, target, config.damage, turnRate, missileCfg.maxSpeed, spawnProjectile, pushEvent);
  }
  return true;
}

/**
 * 生成特殊导弹弹体（多目标/远程共用，私有）
 *
 * 功能：在机腹生成一枚导弹实体，追踪指定目标——
 * 伤害/转向速率/极速由特殊武器配置决定
 * @param player 发射者（玩家）
 * @param target 追踪目标实体
 * @param damage 单发伤害
 * @param turnRate 转向角速率（rad/s）
 * @param maxSpeed 最大飞行速度（m/s）
 * @param spawnProjectile 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns void
 * 异常：无
 */
function spawnSpecialMissile(
  player: SimEntity,
  target: SimEntity,
  damage: number,
  turnRate: number,
  maxSpeed: number,
  spawnProjectile: (kind: EntityKind, position: Vector3, quaternion?: import('three').Quaternion) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): void {
  _forward.set(0, 0, -1).applyQuaternion(player.quaternion);
  _down.set(0, -1, 0).applyQuaternion(player.quaternion);
  _spawnPos.copy(player.position).addScaledVector(_forward, 5).addScaledVector(_down, 2.5);
  _spawnVelocity.copy(player.velocity).addScaledVector(_forward, missileCfg.launchSpeed);

  const missileEntity = spawnProjectile('projectile', _spawnPos);
  missileEntity.variant = 'missile';
  missileEntity.velocity.copy(_spawnVelocity);
  missileEntity.projectile = createProjectileData(
    damage,
    missileCfg.life,
    player.id,
    false,
  );
  missileEntity.missile = createMissileData(target.id, missileCfg.launchSpeed);
  missileEntity.missile.turnRateOverride = turnRate;
  missileEntity.missile.maxSpeedOverride = maxSpeed;
  orientAlongVelocity(missileEntity);

  pushEvent({
    type: 'missile-launched',
    position: _spawnPos.clone(),
    byPlayer: true,
  });
}

/**
 * 发射远程导弹（私有分片）
 *
 * 功能：对锁定目标生成一枚远程导弹——更高极速与伤害、
 * 略低转向速率（能量弹道）
 * @param player 玩家实体
 * @param config 特殊武器配置
 * @param target 追踪目标实体
 * @param spawnProjectile 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns 是否成功
 * 异常：无
 */
function launchLongRangeMissile(
  player: SimEntity,
  config: SpecialWeaponConfig,
  target: SimEntity,
  spawnProjectile: (kind: EntityKind, position: Vector3, quaternion?: import('three').Quaternion) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): boolean {
  spawnSpecialMissile(
    player,
    target,
    config.damage,
    config.longTurnRate ?? 1.7,
    config.maxSpeed ?? 650,
    spawnProjectile,
    pushEvent,
  );
  return true;
}
