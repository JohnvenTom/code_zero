import { Vector3 } from 'three';
import { gameConfig } from '../config';
import type { EntityKind, SimEntity } from './entity';
import { createFlareData } from './components';
import type { GameEvent } from './events';

/** 干扰弹配置的模块级引用 */
const flareCfg = gameConfig.flare;
/** 飞行配置的模块级引用（重力） */
const flightCfg = gameConfig.flight;

/** 模块级复用对象：机尾方向（弹射方向） */
const _back = new Vector3();
/** 模块级复用对象：干扰弹生成位置 */
const _spawnPos = new Vector3();
/** 模块级复用对象：干扰弹初始速度 */
const _spawnVelocity = new Vector3();
/** 世界坐标上方向常量 */
const UP = new Vector3(0, 1, 0);

/**
 * 递减干扰弹挂载冷却与装填倒计时（单个固定步）
 *
 * 功能：推进飞机实体的干扰弹释放冷却计时；装填中时递减倒计时，
 * 归零瞬间将干扰弹整弹匣回满（干扰弹计数为 count 字段，
 * 此处内联适配 ReloadState 的 ammo 语义）
 * @param shooter 挂有干扰弹挂载组件的飞机实体
 * @param dt 固定时间步长（秒）
 * @returns void
 * 异常：无
 */
export function tickFlarePod(shooter: SimEntity, dt: number): void {
  const pod = shooter.flares;
  if (pod === undefined) {
    return;
  }
  pod.cooldown = Math.max(0, pod.cooldown - dt);
  if (pod.reloadRemain > 0) {
    pod.reloadRemain -= dt;
    if (pod.reloadRemain <= 0) {
      pod.reloadRemain = 0;
      pod.count = pod.magazine;
    }
  }
}

/**
 * 释放干扰弹（玩家与敌机通用）
 *
 * 功能：校验数量、冷却与装填状态后，在载机后方生成一枚干扰弹实体——
 * 初速 = 载机速度 + 机尾方向×向后弹射速度 + 世界向上×向上弹射速度；
 * 数量递减、冷却重置、打空最后一发自动触发装填倒计时，并播报释放事件
 * @param shooter 释放者飞机实体（须挂有 flares 组件）
 * @param spawnEntity 世界层实体生成回调
 * @param pushEvent 世界层事件播报回调
 * @returns 是否成功释放（数量耗尽/冷却未完/装填中返回 false）
 * 异常：无
 * 注意事项：干扰弹挂在 kind='effect' 上，不参与机炮命中检测；
 * 导弹诱偏系统通过 flare 组件的 ownerId 检索归属
 */
export function releaseFlares(
  shooter: SimEntity,
  spawnEntity: (kind: EntityKind, position: Vector3) => SimEntity,
  pushEvent: (event: GameEvent) => void,
): boolean {
  const pod = shooter.flares;
  if (
    pod === undefined ||
    !shooter.alive ||
    pod.count <= 0 ||
    pod.cooldown > 0 ||
    pod.reloadRemain > 0
  ) {
    return false;
  }
  pod.count -= 1;
  pod.cooldown = flareCfg.cooldown;
  // 打空最后一发：自动触发装填（count 适配 ammo 语义）
  if (pod.count <= 0 && pod.reloadRemain <= 0) {
    pod.reloadRemain = pod.reloadTime;
  }

  // 生成位置：载机正后方（机尾）
  _back.set(0, 0, 1).applyQuaternion(shooter.quaternion);
  _spawnPos.copy(shooter.position).addScaledVector(_back, 6);

  // 初速：载机速度 + 向后弹射 + 向上弹射
  _spawnVelocity
    .copy(shooter.velocity)
    .addScaledVector(_back, flareCfg.ejectBackSpeed)
    .addScaledVector(UP, flareCfg.ejectUpSpeed);

  const flareEntity = spawnEntity('effect', _spawnPos);
  flareEntity.variant = 'flare';
  flareEntity.velocity.copy(_spawnVelocity);
  flareEntity.flare = createFlareData(shooter.id, flareCfg.life);

  pushEvent({
    type: 'flare-released',
    position: _spawnPos.clone(),
    byPlayer: shooter.variant === 'player',
  });
  return true;
}

/**
 * 推进全部干扰弹弹体（单个固定步）
 *
 * 功能：遍历干扰弹实体——寿命递减（归零消亡）、受缩放重力下坠、
 * 位置步进；触地即消亡
 * @param entities 世界实体列表
 * @param dt 固定时间步长（秒）
 * @returns void
 * 异常：无
 * 注意事项：干扰弹不做姿态取向（渲染为发光球体，无方向性）
 */
export function updateFlares(entities: readonly SimEntity[], dt: number): void {
  for (const entity of entities) {
    if (entity.kind !== 'effect' || !entity.alive || entity.flare === undefined) {
      continue;
    }
    entity.flare.remainingLife -= dt;
    if (entity.flare.remainingLife <= 0) {
      entity.alive = false;
      continue;
    }
    entity.velocity.y -= flightCfg.gravity * flareCfg.gravityScale * dt;
    entity.position.addScaledVector(entity.velocity, dt);
    if (entity.position.y <= 0) {
      entity.alive = false;
    }
  }
}
