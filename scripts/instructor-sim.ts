/**
 * 教练层闭环数值自检（临时脚本，不参与构建产物）
 *
 * 用真实 instructor + flightModel 跑闭环：
 * 1) 平飞中瞄准不同方向（右/右下/左上/正上/大偏差/压坡中），验证机头收敛且无持续震荡；
 * 2) 验证 G 值被限动器约束在机型限制内；
 * 3) 验证持续瞄准时误差收敛到死区附近并保持。
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { SimEntity } from '../src/simulation/entity';
import { createAircraftData } from '../src/simulation/components';
import { integrateAircraftFlight, type ControlInput } from '../src/simulation/flightModel';
import {
  computeInstructorStick,
  DEFAULT_INSTRUCTOR_TUNING,
  type InstructorStick,
  type InstructorTuning,
} from '../src/simulation/instructor';

const DT = 1 / 60;
const stick: InstructorStick = { pitch: 0, roll: 0, yaw: 0 };
let entity = makePlane();

function makePlane(): SimEntity {
  const plane = new SimEntity(1, 'aircraft', new Vector3(0, 3000, 0));
  plane.variant = 'player';
  plane.aircraft = createAircraftData(false);
  plane.aircraft.onGround = false;
  plane.aircraft.speed = 180;
  plane.aircraft.throttle = 0.62;
  return plane;
}

function forwardOf(q: Quaternion): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(q);
}

/** 运行一个场景：持续瞄准固定世界方向，输出收敛统计 */
function runCase(
  name: string,
  aimDir: Vector3,
  seconds = 8,
  initialQuaternion?: Quaternion,
  tuning: InstructorTuning = DEFAULT_INSTRUCTOR_TUNING,
): void {
  entity = makePlane();
  if (initialQuaternion !== undefined) {
    entity.quaternion.copy(initialQuaternion);
  }
  const input: ControlInput = {
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
  let convergedAt: number | null = null;
  let maxAbsG = 0;
  let overshootCount = 0;
  let prevErr = Infinity;
  let settledErr = 0;
  let settledSamples = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    computeInstructorStick(entity.quaternion, aimDir, tuning, stick);
    const mutable = input as { pitch: number; roll: number; yaw: number };
    mutable.pitch = stick.pitch;
    mutable.roll = stick.roll;
    mutable.yaw = stick.yaw;

    const err = forwardOf(entity.quaternion).angleTo(aimDir);
    if (err < 0.03 && convergedAt === null) {
      convergedAt = i * DT;
    }
    if (convergedAt !== null) {
      if (err > 0.06 && prevErr <= 0.06) {
        overshootCount += 1;
      }
      if (i * DT > convergedAt + 2) {
        settledErr += err;
        settledSamples += 1;
      }
    }
    prevErr = err;
    integrateAircraftFlight(entity, input, DT);
    maxAbsG = Math.max(maxAbsG, Math.abs(entity.aircraft!.gLoad));
  }
  const finalErr = forwardOf(entity.quaternion).angleTo(aimDir);
  const settledAvg = settledSamples > 0 ? settledErr / settledSamples : -1;
  console.log(
    `${name}: 收敛=${convergedAt === null ? '未收敛' : convergedAt.toFixed(2) + 's'} 最终误差=${((finalErr * 180) / Math.PI).toFixed(2)}° 稳态误差=${settledAvg >= 0 ? ((settledAvg * 180) / Math.PI).toFixed(2) + '°' : '--'} 失稳次数=${overshootCount} 最大|G|=${maxAbsG.toFixed(1)} 速度=${entity.aircraft!.speed.toFixed(0)}m/s 高度=${entity.position.y.toFixed(0)}m`,
  );
}

/** 方向球坐标：az 方位（+右）、el 仰角（+上）→ 世界方向（北 = -Z） */
function dir(azDeg: number, elDeg: number): Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

runCase('正前方(死区松杆)', dir(0, 0));
runCase('右偏 25°      ', dir(25, 0));
runCase('右下 25°/-20° ', dir(25, -20));
runCase('左上 -30°/25° ', dir(-30, 25));
runCase('正上 35°      ', dir(0, 35));
runCase('右偏 45° 大偏差', dir(45, 0));
runCase('屏角极限 -45°/-35°', dir(-45, -35));

// 压坡爬升中瞄准正北水平：初始右压坡 60° + 爬升 20°
runCase('压坡爬升→瞄准北', dir(0, 0), 8, new Quaternion().setFromEuler(new Euler(0.349, 0, -1.05, 'XYZ')));

// 倒飞 (180° 滚转) 中瞄准正北水平
runCase('倒飞→瞄准北   ', dir(0, 0), 8, new Quaternion().setFromEuler(new Euler(0, 0, Math.PI, 'XYZ')));

// ---- 设置滑条极端值安全性：pursuitResponse 0.4 / 2.0 ----
const fastTuning: InstructorTuning = { pursuitResponse: 2, rudderAssist: 1 };
const slowTuning: InstructorTuning = { pursuitResponse: 0.4, rudderAssist: 1 };
console.log('--- 滑条上限 ×2.0 ---');
runCase('右偏 25°×2.0 ', dir(25, 0), 8, undefined, fastTuning);
runCase('屏角极限×2.0  ', dir(-45, -35), 8, undefined, fastTuning);
console.log('--- 滑条下限 ×0.4 ---');
runCase('右偏 25°×0.4 ', dir(25, 0), 8, undefined, slowTuning);
runCase('屏角极限×0.4  ', dir(-45, -35), 8, undefined, slowTuning);

// ---- 旋转瞄准方向跟踪（模拟光标持续追踪横向掠过的目标 20°/s） ----
entity = makePlane();
{
  let maxLag = 0;
  const w = 0.349; // 20°/s
  const stick2: InstructorStick = { pitch: 0, roll: 0, yaw: 0 };
  const input: ControlInput = {
    pitch: 0, roll: 0, yaw: 0, throttleUp: false, throttleDown: false,
    fire: false, cycleWeapon: false, switchTarget: false, flare: false,
    wingmanCommand: false, reset: false,
  };
  for (let i = 0; i < 10 * 60; i++) {
    const t = i * DT;
    const az = 0.35 + Math.sin(t * w) * 0.35; // 方位在 ±20° 内摆动
    const aim = dir((az * 180) / Math.PI, 5);
    computeInstructorStick(entity.quaternion, aim, DEFAULT_INSTRUCTOR_TUNING, stick2);
    (input as { pitch: number }).pitch = stick2.pitch;
    (input as { roll: number }).roll = stick2.roll;
    (input as { yaw: number }).yaw = stick2.yaw;
    const lag = forwardOf(entity.quaternion).angleTo(aim);
    if (t > 3) maxLag = Math.max(maxLag, lag);
    integrateAircraftFlight(entity, input, DT);
  }
  console.log(`摆动跟踪(±20°@20°/s): 稳态最大滞后=${((maxLag * 180) / Math.PI).toFixed(2)}° G峰值范围内`);
}
