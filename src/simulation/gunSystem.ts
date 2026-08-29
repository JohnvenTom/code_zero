import { Matrix4, Quaternion, Vector3 } from 'three';
import { gameConfig } from '../config';
import type { EntityKind, SimEntity } from './entity';
import { createProjectileData } from './components';
import type { GameEvent } from './events';

/** 机炮配置的模块级引用 */
const gunCfg = gameConfig.gun;
/** 飞行配置的模块级引用（重力用于弹道下坠） */
const flightCfg = gameConfig.flight;

/** 模块级复用对象：机头前向向量 */
const _forward = new Vector3();
/** 模块级复用对象：机体右方向向量 */
const _right = new Vector3();
/** 模块级复用对象：机体上方向向量 */
const _up = new Vector3();
/** 模块级复用对象：炮口世界坐标 */
const _muzzle = new Vector3();
/** 模块级复用对象：弹道方向（含散布） */
const _dir = new Vector3();
/** 模块级复用对象：弹丸速度向量 */
const _velocity = new Vector3();
/** 模块级复用对象：lookAt 目标点（沿速度方向） */
const _lookTarget = new Vector3();
/** 模块级复用对象：lookAt 复用矩阵 */
const _lookMatrix = new Matrix4();
/** 世界坐标上方向常量（lookAt up 向量） */
const UP = new Vector3(0, 1, 0);

/**
 * 更新机炮并按射速发射曳光弹（单个固定步，玩家与敌机通用）
 *
 * 功能：冷却递减；wantFire 为真且弹药充足、冷却归零时生成一发曳光弹：
 * 炮口位于机头前方 muzzleOffset 处，初速 = 载机速度 + 弹道方向×炮口初速，
 * 弹道方向 = 瞄准方向（可选，缺省机头）+ 随机锥形散布；
 * 弹丸姿态沿速度方向取向。
 * @param shooter 开火的飞机实体（须挂有 gun 组件）
 * @param wantFire 本步是否请求开火（持续按住语义）
 * @param dt 固定时间步长（秒）
 * @param spawnProjectile 世界层提供的实体生成回调（避免系统直接依赖世界类）
 * @param aimDir 可选瞄准方向（世界坐标单位向量，AI 前置瞄准用）；缺省用机头方向
 * @returns void
 * 异常：无
 * 注意事项：弹药耗尽时静默停射（HUD 层负责弹药告警显示）；
 * 弹丸的 prev 快照在构造时初始化为出生点，渲染插值天然平滑
 */
export function updateGun(
  shooter: SimEntity,
  wantFire: boolean,
  dt: number,
  spawnProjectile: (kind: EntityKind, position: Vector3, quaternion?: Quaternion) => SimEntity,
  aimDir?: Vector3,
): void {
  const gun = shooter.gun;
  if (gun === undefined || !shooter.alive) {
    return;
  }
  gun.cooldown = Math.max(0, gun.cooldown - dt);
  if (!wantFire || gun.cooldown > 0 || gun.ammo <= 0) {
    return;
  }

  gun.ammo -= 1;
  gun.cooldown = 1 / gunCfg.fireRate;

  // 基准弹道方向：显式瞄准方向或机头方向
  if (aimDir !== undefined) {
    _dir.copy(aimDir).normalize();
  } else {
    _dir.set(0, 0, -1).applyQuaternion(shooter.quaternion);
  }

  // 机体系散布轴 → 世界坐标
  _right.set(1, 0, 0).applyQuaternion(shooter.quaternion);
  _up.set(0, 1, 0).applyQuaternion(shooter.quaternion);

  // 炮口位置：机头前方偏移
  _forward.copy(_dir);
  _muzzle.copy(_forward).multiplyScalar(gunCfg.muzzleOffset).add(shooter.position);

  // 弹道方向：基准方向 + 随机锥形散布
  _dir
    .addScaledVector(_right, (Math.random() * 2 - 1) * gunCfg.spreadRad)
    .addScaledVector(_up, (Math.random() * 2 - 1) * gunCfg.spreadRad)
    .normalize();

  // 初速 = 载机速度 + 方向 × 炮口初速
  _velocity.copy(shooter.velocity).addScaledVector(_dir, gunCfg.muzzleSpeed);

  const projectile = spawnProjectile('projectile', _muzzle);
  projectile.variant = 'tracer';
  projectile.velocity.copy(_velocity);
  projectile.projectile = createProjectileData(
    gunCfg.damage,
    gunCfg.tracerLife,
    shooter.id,
    shooter.variant === 'enemy',
  );
  orientAlongVelocity(projectile);
}

/**
 * 推进全部机炮弹丸并做命中检测（单个固定步）
 *
 * 功能：遍历弹丸实体（导弹由导弹系统处理，此处跳过）——
 * 寿命递减（归零消亡）、受缩放重力下坠、位置步进、姿态沿速度方向取向、
 * 触地消亡；与全部挂生命值组件的存活实体做球体距离检测，
 * 命中即结算伤害并播报事件，目标血量归零时击毁。
 * @param entities 世界实体列表（含弹丸与可命中目标）
 * @param dt 固定时间步长（秒）
 * @param pushEvent 世界层事件播报回调
 * @returns void
 * 异常：无
 * 注意事项：命中判定基于步进后的位置（球体半径远大于单步位移，无隧穿风险）；
 * 发射者自身通过 ownerId 跳过（敌我弹丸互射均正确豁免）
 */
export function updateProjectiles(
  entities: readonly SimEntity[],
  dt: number,
  pushEvent: (event: GameEvent) => void,
): void {
  for (const projectile of entities) {
    if (
      projectile.kind !== 'projectile' ||
      !projectile.alive ||
      projectile.projectile === undefined ||
      projectile.missile !== undefined
    ) {
      continue;
    }
    const data = projectile.projectile;

    // 寿命归零 → 脱靶消亡
    data.remainingLife -= dt;
    if (data.remainingLife <= 0) {
      projectile.alive = false;
      continue;
    }

    // 弹道下坠 + 位置步进 + 姿态取向
    projectile.velocity.y -= flightCfg.gravity * gunCfg.tracerGravityScale * dt;
    projectile.position.addScaledVector(projectile.velocity, dt);
    orientAlongVelocity(projectile);

    // 触地消亡（集束破片触地爆炸：对范围目标结算伤害）
    if (projectile.position.y <= 0) {
      if (projectile.blastRadius !== undefined) {
        applyBlastDamage(projectile, entities, pushEvent);
      }
      projectile.alive = false;
      continue;
    }

    // 球体命中检测：与全部可命中目标比对
    for (const target of entities) {
      if (
        target === projectile ||
        !target.alive ||
        target.health === undefined ||
        target.id === data.ownerId
      ) {
        continue;
      }
      // 阵营豁免：敌方弹丸只命中玩家（避免敌机误伤友机/靶标）
      if (data.byEnemy && target.variant !== 'player') {
        continue;
      }
      const radius = target.health.hitRadius;
      if (projectile.position.distanceToSquared(target.position) <= radius * radius) {
        if (projectile.blastRadius !== undefined) {
          // 范围伤害弹丸：命中点爆炸结算全体范围目标
          pushEvent({ type: 'gun-hit', position: projectile.position.clone() });
          applyBlastDamage(projectile, entities, pushEvent);
        } else {
          pushEvent({ type: 'gun-hit', position: projectile.position.clone() });
          applyDamage(target, data.damage, pushEvent);
        }
        projectile.alive = false;
        break;
      }
    }
  }
}

/**
 * 对爆炸点附近目标结算范围伤害（集束破片用）
 *
 * 功能：以弹丸位置为圆心、blastRadius 为半径检索全部可命中目标
 * （阵营豁免与发射者豁免同单体命中），命中逐个结算伤害
 * @param projectile 爆炸弹丸实体（携带 blastRadius 与 projectile 组件）
 * @param entities 世界实体列表
 * @param pushEvent 世界层事件播报回调
 * @returns void
 * 异常：无
 * 注意事项：地面目标（固定不动）是主要伤害对象；
 * 空中目标在半径内同样受伤（误伤风险低）
 */
function applyBlastDamage(
  projectile: SimEntity,
  entities: readonly SimEntity[],
  pushEvent: (event: GameEvent) => void,
): void {
  const data = projectile.projectile;
  const radius = projectile.blastRadius;
  if (data === undefined || radius === undefined) {
    return;
  }
  for (const target of entities) {
    if (
      target === projectile ||
      !target.alive ||
      target.health === undefined ||
      target.id === data.ownerId
    ) {
      continue;
    }
    if (data.byEnemy && target.variant !== 'player') {
      continue;
    }
    if (projectile.position.distanceToSquared(target.position) <= radius * radius) {
      applyDamage(target, data.damage, pushEvent);
    }
  }
}

/**
 * 对目标结算伤害（机炮/导弹命中共用）
 *
 * 功能：扣除目标生命值；血量归零时置死亡标记并播报击毁事件——
 * 玩家目标不发 target-destroyed（由世界层统一发 player-crash），
 * 其余目标按实体变体播报（HUD 区分敌机击坠/靶标摧毁文案）
 * @param target 被命中实体（须挂有 health 组件）
 * @param damage 单次伤害值
 * @param pushEvent 世界层事件播报回调
 * @returns void
 * 异常：无
 * 注意事项：调用方负责弹丸自身消亡与命中反馈事件（gun-hit/missile-hit）
 */
export function applyDamage(
  target: SimEntity,
  damage: number,
  pushEvent: (event: GameEvent) => void,
): void {
  const health = target.health;
  if (health === undefined || !target.alive) {
    return;
  }
  health.hp -= damage;
  if (health.hp > 0) {
    return;
  }
  target.alive = false;
  if (target.variant === 'player') {
    // 玩家死亡统一走 player-crash 事件（世界层检查存活状态变化后播报）
    if (target.aircraft !== undefined) {
      target.aircraft.crashed = true;
    }
    return;
  }
  if (target.aircraft !== undefined) {
    target.aircraft.crashed = true;
  }
  pushEvent({
    type: 'target-destroyed',
    position: target.position.clone(),
    variant: target.variant ?? 'enemy',
  });
}

/**
 * 将实体姿态设为沿其速度方向（-Z 前向约定）
 *
 * 功能：用 lookAt 矩阵构造使实体 -Z 轴指向速度方向的四元数，
 * 保证曳光弹/导弹长轴与弹道一致
 * @param entity 目标弹丸实体
 * @returns void
 * 异常：无
 * 注意事项：速度接近零向量时保持原姿态（避免 lookAt 退化）；
 * 速度接近垂直方向时 up 向量退化概率极低（弹道仅轻微下坠），可接受
 */
export function orientAlongVelocity(entity: SimEntity): void {
  if (entity.velocity.lengthSq() < 1e-8) {
    return;
  }
  _dir.copy(entity.velocity).normalize();
  _lookTarget.copy(entity.position).add(_dir);
  _lookMatrix.lookAt(entity.position, _lookTarget, UP);
  entity.quaternion.setFromRotationMatrix(_lookMatrix);
}
