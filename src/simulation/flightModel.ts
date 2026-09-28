import { Euler, Quaternion, Vector3 } from 'three';
import { gameConfig } from '../config';
import type { SimEntity } from './entity';

/**
 * 战机控制输入快照（玩家由 core 层 InputManager 采样生成，敌机由 AI 生成）
 *
 * 功能：承载一个固定步内一架战机的全部控制输入；
 * simulation 层只依赖本结构，不接触任何 DOM/键盘事件。
 */
export interface ControlInput {
  /** 俯仰杆量 -1..1（+1 拉杆抬头 / -1 推杆低头） */
  readonly pitch: number;
  /** 滚转杆量 -1..1（+1 右滚） */
  readonly roll: number;
  /** 偏航量 -1..1（+1 机头右偏） */
  readonly yaw: number;
  /** 是否按住油门增大键 */
  readonly throttleUp: boolean;
  /** 是否按住油门减小键 */
  readonly throttleDown: boolean;
  /** 是否按住发射键（空格：按当前选中武器持续/单发射） */
  readonly fire: boolean;
  /** 是否请求循环切换武器（R 键边沿触发，仅单个固定步为 true） */
  readonly cycleWeapon: boolean;
  /** 是否请求切换锁定目标（X 键边沿触发，仅单个固定步为 true） */
  readonly switchTarget: boolean;
  /** 是否请求释放干扰弹（边沿触发，仅单个固定步为 true） */
  readonly flare: boolean;
  /** 是否请求循环僚机指令（边沿触发，仅单个固定步为 true；仅玩家使用） */
  readonly wingmanCommand: boolean;
  /** 是否请求重置（边沿触发，仅单个固定步为 true；仅玩家使用） */
  readonly reset: boolean;
  /** 鼠标教练瞄准是否激活（仅玩家：M 键开关 ×设置页；教练层据此接管杆量） */
  readonly mouseAim?: boolean;
  /** 鼠标瞄准方向（世界坐标单位向量，渲染层由光标反投影；null=不可用。
   *  仅玩家使用；自由光标在屏幕内+追尾相机，天然约束在机头前视锥附近 */
  readonly aimDir?: Vector3 | null;
}

/** 飞行基准配置的模块级引用（通用参数：油门速率/输入响应/失速特性/地面参数） */
const cfg = gameConfig.flight;

/** 模块级复用对象：局部角增量欧拉角（避免每步分配） */
const _euler = new Euler();
/** 模块级复用对象：局部角增量四元数 */
const _deltaQ = new Quaternion();
/** 模块级复用对象：机头前向向量（世界坐标） */
const _forward = new Vector3();
/** 模块级复用对象：机体上方向向量（世界坐标） */
const _up = new Vector3();
/** 模块级复用对象：机体局部 X 轴（俯仰轴） */
const _pitchAxis = new Vector3(1, 0, 0);

/**
 * 将数值钳制到区间内
 *
 * @param value 输入值
 * @param min 下限
 * @param max 上限
 * @returns 钳制后的值
 * 异常：无
 * 注意事项：min > max 时结果未定义，调用方需保证区间合法
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 操纵杆量非对称平滑（私有）
 *
 * 功能：键盘二元输入→连续杆量的过渡——加大杆量方向用慢速率
 * （attack，建立过程给玩家精细瞄准的空间：轻点轻拉、长按满拉），
 * 减小/回中/反向用快速率（release，松杆立即回中不粘滞）
 * @param current 当前平滑杆量
 * @param target 目标杆量（原始输入×灵敏度）
 * @param dt 时间步长（秒）
 * @param attackRate 加大杆量方向的速率（1/s）
 * @param releaseRate 减小杆量方向的速率（1/s）
 * @returns 新的平滑杆量
 * 异常：无
 * 注意事项：判断方向用 |target|>|current|（含反向过零场景）
 */
function smoothStick(
  current: number,
  target: number,
  dt: number,
  attackRate: number,
  releaseRate: number,
): number {
  const growing = Math.abs(target) > Math.abs(current);
  const rate = growing ? attackRate : releaseRate;
  const maxStep = rate * dt;
  return current + clamp(target - current, -maxStep, maxStep);
}

/**
 * 计算最佳机动速度操纵权限因子（corner speed 曲线）
 *
 * 功能：按当前速度相对最佳机动速度的位置计算操纵权限 0..1——
 * - speed == best：权限 1.0（机动最佳点）；
 * - stall ≤ speed < best：从失速速度处的 0.35 线性升至 1.0
 *   （低速权限不足，替换旧 controlAuthorityFloor 低速衰减曲线）；
 * - speed < stall：钳制在 0.35（失速最低权限，配合机头下压）；
 * - speed > best：从 1.0 线性缓降至极速处的 0.75（高速略沉重）。
 * @param speed 当前速度标量（m/s）
 * @param stallSpeed 失速速度（m/s）
 * @param bestSpeed 最佳机动速度（m/s）
 * @param maxSpeed 最大平飞速度（m/s）
 * @returns 操纵权限因子 0.35..1.0
 * 异常：无
 * 注意事项：bestSpeed ≤ stallSpeed 或 maxSpeed ≤ bestSpeed 的
 * 退化配置按边界值钳制处理，不抛异常
 */
export function maneuverAuthorityFactor(
  speed: number,
  stallSpeed: number,
  bestSpeed: number,
  maxSpeed: number,
): number {
  const LOW_AUTHORITY = 0.35;
  const HIGH_AUTHORITY_FLOOR = 0.75;
  if (speed <= stallSpeed || bestSpeed <= stallSpeed) {
    return LOW_AUTHORITY;
  }
  if (speed <= bestSpeed) {
    // 失速速度→最佳速度：0.35 → 1.0 线性上升
    return LOW_AUTHORITY + (1 - LOW_AUTHORITY) * ((speed - stallSpeed) / (bestSpeed - stallSpeed));
  }
  if (maxSpeed <= bestSpeed) {
    return 1;
  }
  // 最佳速度→极速：1.0 → 0.75 线性缓降
  return 1 - (1 - HIGH_AUTHORITY_FLOOR) * ((speed - bestSpeed) / (maxSpeed - bestSpeed));
}

/**
 * 姿态角速率街机飞行模型积分（单个固定步）
 *
 * 功能：按“姿态角速率 + 油门 + 速度区间”的自研街机模型推进飞行器一个固定步：
 * 1) 油门积分与杆量平滑；2) 地面滑跑（锁定滚转/偏航、限抬头角、离地判定）；
 * 3) 空中姿态积分（俯仰受 G 限动器约束、最佳机动速度权限曲线与失速机头下压）；
 * 4) 速度标量积分（推力 - 阻力 - 重力沿机头分量）；
 * 5) 位置积分与 G 值计算；6) 坠地判定（坠毁置 alive=false）。
 * 全程使用四元数局部旋转，任意姿态下无万向节死锁；
 * 全部性能参数读取 aircraft.params（机型差异的落点）。
 * @param entity 飞行器实体（须挂有 aircraft 组件且存活）
 * @param input 本固定步的控制输入快照（玩家输入或 AI 生成的控制量）
 * @param dt 固定时间步长（秒）
 * @returns void（结果写入实体与组件字段）
 * 异常：无（内部不做防御性校验，调用方保证组件存在）
 * 注意事项：
 * - 前向约定：本体 -Z 为机头；拉杆(+pitch)对应绕局部 X 正向旋转（抬头）；
 *   右滚(+roll)对应绕局部 Z 负向；右偏航(+yaw)对应绕局部 Y 负向；
 * - 操纵权限由最佳机动速度曲线统一给出（旧 controlAuthorityFloor
 *   低速权限计算已被替换），G 限动器独立于该因子保持不变；
 * - 坠毁时仅置 alive=false 与 crashed=true，事件由世界层统一播报
 */
export function integrateAircraftFlight(entity: SimEntity, input: ControlInput, dt: number): void {
  const ac = entity.aircraft;
  if (ac === undefined || !entity.alive) {
    return;
  }
  const p = ac.params;

  // ---- 1) 油门与杆量平滑（非对称：建立慢=精细瞄准，回中快=不粘滞） ----
  if (input.throttleUp) {
    ac.throttle = clamp(ac.throttle + cfg.throttleRate * dt, 0, 1);
  }
  if (input.throttleDown) {
    ac.throttle = clamp(ac.throttle - cfg.throttleRate * dt, 0, 1);
  }
  const sens = gameConfig.input;
  ac.pitchIn = smoothStick(ac.pitchIn, input.pitch * sens.pitchSensitivity, dt,
    cfg.inputAttackRate, cfg.inputResponseRate);
  ac.rollIn = smoothStick(ac.rollIn, input.roll * sens.rollSensitivity, dt,
    cfg.inputAttackRate, cfg.inputResponseRate);
  ac.yawIn = smoothStick(ac.yawIn, input.yaw * sens.yawSensitivity, dt,
    cfg.inputAttackRate, cfg.inputResponseRate);

  // ---- 2) 地面滑跑模式 ----
  if (ac.onGround) {
    integrateGroundRoll(entity, ac, dt);
    return;
  }

  // ---- 3) 空中失速状态与最佳机动速度操纵权限 ----
  ac.stalled = ac.speed < p.stallSpeed;
  const authority = maneuverAuthorityFactor(
    ac.speed,
    p.stallSpeed,
    p.bestManeuverSpeed,
    p.maxSpeed,
  );

  // ---- 4) G 限动器（街机容忍：允许超出机型 G 限一定比例） ----
  // 物理硬钳制 pullLimit=(G限-1)g/v 在巡航速度下把俯仰速率压得很低
  // （真实飞机如此，街机手感偏迟缓）——放宽为允许实际 G 达到
  // 机型 G 限 × (1 + gLimiterRelax)，超限部分按该比例容忍
  const vSafe = Math.max(ac.speed, 15);
  const gTol = 1 + cfg.gLimiterRelax;
  const pullLimit = ((p.gLimitPositive * gTol - 1) * cfg.gravity) / vSafe;
  const pushLimit = (-(p.gLimitNegative * gTol - 1) * cfg.gravity) / vSafe;
  let pitchRate = p.pitchRateMax * authority * ac.pitchIn;
  pitchRate = clamp(pitchRate, pushLimit, pullLimit);
  const rollRate = p.rollRateMax * authority * ac.rollIn;
  const yawRate = p.yawRateMax * authority * ac.yawIn;

  // 局部旋转：pitch 绕 +X（抬头为正）、yaw 右偏绕 -Y、roll 右滚绕 -Z
  _euler.set(pitchRate * dt, -yawRate * dt, -rollRate * dt, 'XYZ');
  _deltaQ.setFromEuler(_euler);
  entity.quaternion.multiply(_deltaQ).normalize();

  // 失速：机头持续下压（绕局部 X 负向），严重度随速度亏损加深
  let stallSeverity = 0;
  if (ac.stalled) {
    stallSeverity = clamp((p.stallSpeed - ac.speed) / (p.stallSpeed * 0.5), 0, 1);
    _deltaQ.setFromAxisAngle(_pitchAxis, -cfg.stallPitchDropRate * stallSeverity * dt);
    entity.quaternion.multiply(_deltaQ).normalize();
  }

  // ---- 5) 速度标量积分：推力 - 气动阻力 - 重力沿机头分量 ----
  _forward.set(0, 0, -1).applyQuaternion(entity.quaternion);
  const accel =
    ac.throttle * p.thrustAccel -
    p.dragCoefficient * ac.speed * ac.speed -
    cfg.gravity * _forward.y;
  ac.speed = clamp(ac.speed + accel * dt, 0, p.maxSpeed);

  // ---- 6) 位置积分（速度 = 机头方向 × 速度标量；失速附加下沉） ----
  entity.velocity.copy(_forward).multiplyScalar(ac.speed);
  if (ac.stalled) {
    entity.velocity.y -= cfg.stallSinkRate * stallSeverity;
  }
  entity.position.addScaledVector(entity.velocity, dt);

  // ---- 7) G 值：俯仰向心过载 + 重力沿机体 up 分量 ----
  // 钳制区间放宽（允许显示街机超限 G，配合 G 限动器容忍系数）
  _up.set(0, 1, 0).applyQuaternion(entity.quaternion);
  ac.gLoad = clamp((pitchRate * ac.speed) / cfg.gravity + _up.y, -8, 20);

  // ---- 8) 坠地判定：机身中心低于滑跑高度-余量即坠毁 ----
  if (entity.position.y < cfg.gearHeight - cfg.crashMargin) {
    entity.position.y = Math.max(entity.position.y, 0);
    entity.alive = false;
    ac.crashed = true;
  }
}

/**
 * 地面滑跑积分（私有逻辑分片）
 *
 * 功能：处理跑道滑跑阶段——滚转/偏航输入锁定，速度达到抬前轮阈值后
 * 允许抬头（限最大地面抬头角），抬头超过离地角且速度足够即转入空中；
 * 位置沿跑道方向推进且高度锁定在起落架高度
 * @param entity 飞行器实体
 * @param ac 飞行数据组件
 * @param dt 固定时间步长（秒）
 * @returns void
 * 异常：无
 * 注意事项：滑跑阶段姿态仅含俯仰（自单位姿态累积），天然保持水平；
 * G 值固定为 1，失速标记恒为 false；起飞速度按机型参数包判定
 */
function integrateGroundRoll(entity: SimEntity, ac: NonNullable<SimEntity['aircraft']>, dt: number): void {
  const p = ac.params;

  // 抬前轮：速度足够且拉杆，仅允许正向俯仰
  let pitchRate = 0;
  if (ac.speed >= p.takeoffSpeed && ac.pitchIn > 0) {
    pitchRate = p.pitchRateMax * ac.pitchIn;
  }
  if (pitchRate !== 0) {
    _euler.set(pitchRate * dt, 0, 0, 'XYZ');
    _deltaQ.setFromEuler(_euler);
    entity.quaternion.multiply(_deltaQ).normalize();

    // 地面最大抬头角钳制：超出则回转修正到上限
    _forward.set(0, 0, -1).applyQuaternion(entity.quaternion);
    const pitchAngle = Math.asin(clamp(_forward.y, -1, 1));
    if (pitchAngle > cfg.groundMaxPitch) {
      _deltaQ.setFromAxisAngle(_pitchAxis, cfg.groundMaxPitch - pitchAngle);
      entity.quaternion.multiply(_deltaQ).normalize();
    }
  }

  // 速度积分：推力 - 气动阻力 - 滚动阻力（机头近水平，重力分量忽略）
  const accel =
    ac.throttle * p.thrustAccel -
    p.dragCoefficient * ac.speed * ac.speed -
    cfg.rollingResistance;
  ac.speed = clamp(ac.speed + accel * dt, 0, p.maxSpeed);

  // 位置沿机头水平推进，高度锁定起落架高度
  _forward.set(0, 0, -1).applyQuaternion(entity.quaternion);
  entity.velocity.copy(_forward).multiplyScalar(ac.speed);
  entity.velocity.y = 0;
  entity.position.addScaledVector(entity.velocity, dt);
  entity.position.y = cfg.gearHeight;

  // 离地判定：速度达标且抬头角超过离地角
  _forward.set(0, 0, -1).applyQuaternion(entity.quaternion);
  const pitchAngle = Math.asin(clamp(_forward.y, -1, 1));
  if (ac.speed >= p.takeoffSpeed && pitchAngle >= cfg.liftoffPitch) {
    ac.onGround = false;
  }

  ac.gLoad = 1;
  ac.stalled = false;
}
