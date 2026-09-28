import { Quaternion, Vector3 } from 'three';
import { gameConfig } from '../config';

/**
 * 鼠标教练瞄准（战雷式虚拟教练，迭代12）
 *
 * 功能：把"光标瞄准方向"翻译为协调转弯杆量——
 * 1) 方向最优坡度 atan2(方位误差, 仰角差)：水平目标压 90° 侧立零爬升、
 *    上视目标浅坡螺旋爬升、下视目标延伸滚过 90°，滚转杆量追踪坡度差；
 * 2) 体系仰角误差 + 转弯保持下限 → 拉杆（推杆受限幅度，负 G 由
 *    飞行模型 G 限动器兜底）；
 * 3) 方位误差收敛到微舵阈值内后坡度快速回平，叠加方向舵做末端修正；
 * 输出杆量走与键盘完全相同的输入通道（smoothStick/G限/速度权限全部生效）。
 * 边界约定：本模块为 simulation 层纯函数，只消费世界坐标方向向量，
 * 不接触屏幕坐标/DOM（反投影由渲染层完成、core 层桥接传入）。
 * 验证：scripts/instructor-sim.ts 闭环数值回归（收敛时间/失稳次数/G 上限）。
 */

/** 教练手感调参（设置页滑条实时缩放，由 world 层持有注入） */
export interface InstructorTuning {
  /** 追踪响应倍率 0.4..2（缩放拉杆/滚转增益：低=稳重，高=凌厉） */
  readonly pursuitResponse: number;
  /** 微调方向舵倍率 0..2（缩放末端方向舵修正量，0=关闭微舵） */
  readonly rudderAssist: number;
}

/** 默认调参（1=使用配置表基准增益） */
export const DEFAULT_INSTRUCTOR_TUNING: InstructorTuning = {
  pursuitResponse: 1,
  rudderAssist: 1,
};

/** 教练杆量输出（三轴 -1..1，语义与键盘杆量一致） */
export interface InstructorStick {
  pitch: number;
  roll: number;
  yaw: number;
}

/** 鼠标教练配置（模块级只读引用） */
const cfg = gameConfig.input.mouse;

/** 世界系上方向量常量 */
const WORLD_UP = new Vector3(0, 1, 0);

// ---- 模块级复用对象（避免每固定步分配） ----
/** 瞄准方向在机体坐标系的表示 */
const _local = new Vector3();
/** 机头前向（世界坐标） */
const _forward = new Vector3();
/** 机体上方向量（世界坐标） */
const _bodyUp = new Vector3();
/** 机头水平航向（世界坐标，y 归零） */
const _headingH = new Vector3();
/** 瞄准方向水平投影（世界坐标，y 归零） */
const _targetH = new Vector3();
/** 航向右手方向（水平面内，指向机头右侧） */
const _rightH = new Vector3();
/** 垂直于机头的世界"地平上参考"（俯仰轴平面内的世界上方向量） */
const _upRef = new Vector3();
/** 垂直于机头的右手参考（坡度测量用） */
const _rightRef = new Vector3();
/** 姿态逆四元数（世界→机体变换） */
const _invQ = new Quaternion();

/**
 * 数值钳制
 *
 * @param value 输入值
 * @param min 下限
 * @param max 上限
 * @returns 钳制后的值
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 计算鼠标教练杆量（单个固定步，纯函数）
 *
 * 功能：按"协调转弯"策略计算机头追踪瞄准方向所需的三轴杆量——
 * - 滚转：方向最优坡度 atan2(方位误差, 仰角差)（水平目标 90° 侧立/
 *   上视浅坡/下视滚过 90°），滚转杆量追踪坡度差；
 * - 俯仰：体系仰角误差×拉杆增益 + 转弯保持下限（推杆限幅在
 *   pushStickLimit 内，负 G 由飞行模型 G 限动器兜底）；
 * - 偏航：方位误差进入微舵阈值后叠加微量方向舵精修；
 *   瞄准死区内松杆 + 缓和改平机翼（防末端抖动）。
 * @param quaternion 机头姿态（前向=本体 -Z）
 * @param aimDir 瞄准方向（世界坐标单位向量；由光标反投影得到）
 * @param tuning 手感调参（设置页实时缩放）
 * @param out 杆量输出（写入 pitch/roll/yaw，调用方复用避免分配）
 * @returns void
 * 异常：无（aimDir 非单位向量时仅增益略有偏差，不抛异常）
 * 注意事项：
 * - 机头接近垂直（俯冲/爬升顶点）时地平参考退化，坡度环让位（滚转归零）；
 * - 世界系方位误差保证"已压坡度转弯中不会提前改平"（体坐标系误差
 *   在坡度中恒为零的问题由世界系参考解决）；
 * - 输出杆量将经过 flightModel 的 smoothStick 平滑与 G 限动器约束，
 *   教练不会绕过任何飞行保护。
 */
export function computeInstructorStick(
  quaternion: Quaternion,
  aimDir: Vector3,
  tuning: InstructorTuning,
  out: InstructorStick,
): void {
  // ---- 机体坐标系分解：前向分量/左右/上下 ----
  _invQ.copy(quaternion).invert();
  _local.copy(aimDir).applyQuaternion(_invQ);
  const fz = -_local.z;
  const lx = _local.x;
  const ly = _local.y;

  // 指向误差总角（瞄准方向为单位向量，fz 即夹角余弦）
  const errMag = Math.acos(clamp(fz, -1, 1));
  if (errMag < cfg.aimDeadzoneRad) {
    // 死区内松杆：俯仰/偏航归零 + 缓和改平机翼（滚转不改变机头指向，
    // 改平不影响瞄准保持——战雷教练死区行为）
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    if (Math.abs(_forward.set(0, 0, -1).applyQuaternion(quaternion).y) < 0.999) {
      _upRef.copy(WORLD_UP).addScaledVector(_forward, -WORLD_UP.dot(_forward));
      _upRef.normalize();
      _rightRef.crossVectors(_forward, _upRef);
      _bodyUp.set(0, 1, 0).applyQuaternion(quaternion);
      const bank = Math.atan2(_bodyUp.dot(_rightRef), _bodyUp.dot(_upRef));
      out.roll = clamp(-bank * cfg.rollGain * 0.5, -0.4, 0.4);
    }
    return;
  }

  // ---- 世界系方位误差（坡度环/转弯保持/微舵共用） ----
  _forward.set(0, 0, -1).applyQuaternion(quaternion);
  let azWorld = 0;
  let bankCurrent = 0;
  // 机头近垂直（|forward.y|>0.999）时地平参考退化：坡度环让位
  if (Math.abs(_forward.y) < 0.999) {
    // 机头水平航向与瞄准方向水平投影
    _headingH.set(_forward.x, 0, _forward.z);
    _targetH.set(aimDir.x, 0, aimDir.z);
    const headingLen = _headingH.length();
    const targetLen = _targetH.length();
    if (headingLen > 1e-6 && targetLen > 1e-6) {
      _headingH.divideScalar(headingLen);
      _targetH.divideScalar(targetLen);
      // 右手参考 = 航向 × 世界上（水平面内指向机头右侧）
      _rightH.crossVectors(_headingH, WORLD_UP);
      // 方位误差：瞄准方向偏右为正
      azWorld = Math.atan2(_targetH.dot(_rightH), _targetH.dot(_headingH));
    }

    // 当前坡度：机体 up 相对"垂直于机头的地平参考"的侧倾角（右压坡为正）
    _upRef.copy(WORLD_UP).addScaledVector(_forward, -WORLD_UP.dot(_forward));
    _upRef.normalize();
    _rightRef.crossVectors(_forward, _upRef);
    _bodyUp.set(0, 1, 0).applyQuaternion(quaternion);
    bankCurrent = Math.atan2(_bodyUp.dot(_rightRef), _bodyUp.dot(_upRef));
  }

  // ---- 方向最优坡度 → 滚转杆量（协调转弯坡度环） ----
  // 目标坡度 = 误差向量 (方位,仰角) 的方向角 atan2(azW, elW)：
  // - 水平目标 → 90° 侧立（拉杆纯转向，零爬升过冲）；
  // - 上视目标 → 浅坡（拉杆同时闭合方位与仰角，螺旋爬升）；
  // - 下视目标 → 借 downBankExtension 滚过 90°（拉杆产生向下转向分量，
  //   避免"先仰角过冲再靠受限推杆慢修"的长尾）。
  // 方位误差进入微舵阈值后坡度目标按三次方快速回零（改平收尾——
  // 残余坡度会让方向舵的方位修正效率按 cos(bank) 衰减，
  // 边界处衰减因子为 1 保证相位连续）
  const elWorld = Math.asin(clamp(aimDir.y, -1, 1)) - Math.asin(clamp(_forward.y, -1, 1));
  const maxBankEff = Math.min(
    cfg.maxBankRad + Math.max(0, -elWorld) * cfg.downBankExtension,
    2.4,
  );
  const bankFade = Math.min(1, Math.abs(azWorld) / cfg.rudderThresholdRad);
  const bankTarget =
    clamp(Math.atan2(azWorld, elWorld), -maxBankEff, maxBankEff) * bankFade * bankFade * bankFade;
  const roll = clamp(
    cfg.rollGain * tuning.pursuitResponse * (bankTarget - bankCurrent),
    -1,
    1,
  );

  // ---- 体系仰角误差 + 转弯保持下限 → 俯仰杆量（拉杆为主，推杆限幅） ----
  // 转弯保持项：压坡且方位误差实质未闭合（超过微舵阈值）时强制保持
  // 拉杆下限（转弯必须靠拉杆产生——纯坡度比例控制存在"光压坡不拉杆"
  // 与"仰角超调后求和抵消"两类死锁平衡点）。允许转弯中仰角短暂向上
  // 超调，方位闭合后坡度回平、由体系仰角误差（含受限推杆）修正回来
  // ——战雷教练"压坡拉G→回平修仰角"行为。方位误差进入微舵阈值内后
  // 下限失效，推杆路径不再被微小正下限掩盖（残余方位交由微舵收敛）
  const elBody = Math.atan2(ly, Math.hypot(lx, fz));
  const pullFromEl = tuning.pursuitResponse * cfg.pitchGain * elBody;
  const turnSustain = cfg.turnSustainGain * azWorld * Math.sin(bankCurrent);
  const sustainActive =
    Math.abs(azWorld) > cfg.rudderThresholdRad && turnSustain > pullFromEl;
  const pitch = clamp(
    sustainActive ? turnSustain : pullFromEl,
    -cfg.pushStickLimit,
    1,
  );

  // ---- 末端微舵：世界系方位误差收敛后叠加微量方向舵精修 ----
  let yaw = 0;
  if (Math.abs(azWorld) < cfg.rudderThresholdRad) {
    const azBody = Math.atan2(lx, fz);
    yaw = clamp(cfg.rudderGain * azBody, -1, 1) * cfg.rudderAuthority * tuning.rudderAssist;
  }

  out.pitch = pitch;
  out.roll = roll;
  out.yaw = yaw;
}
