/**
 * 教练层耦合闭环仿真（临时脚本，不参与构建产物）
 *
 * 复现真实游戏全环路：飞机（真实 flightModel）+ 教练（真实 instructor）
 * + 追尾相机（复刻 chaseCamera.ts：位置阻尼/aimFollow 注视混合/rollFollow）
 * + 固定屏幕光标（真实反投影 unproject）。这是能照出"相机-机头偏置
 * 漂移"与"相机滞后蛇形"两类真实 bug 的测试——固定世界方向的旧仿真
 * 看不到这两个问题。
 *
 * 场景：
 * S1 松手光标居中：期望无漂移（俯仰率→0、航向稳定、高度平稳）
 * S2 光标停右侧边缘：期望持续平滑转弯（航向率稳定、无蛇形摆振）
 * S3 光标阶跃右上：期望机头收敛到瞄准射线上（世界角差→死区）
 * S4 滑条 ×2.0 重复 S2/S3：期望仍稳定
 * S5 光标停上方：期望爬升到位后俯仰率→0（无长周期晃动）
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { gameConfig } from '../src/config';
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
const W = 1600;
const H = 900;
const chaseCfg = gameConfig.camera.chase;
const stick: InstructorStick = { pitch: 0, roll: 0, yaw: 0 };

/** 复刻 chaseCamera 的迷你追尾相机（含迭代12 机头平行视线） */
class MiniChaseCamera {
  readonly camera = new PerspectiveCamera(gameConfig.camera.fov, W / H, 0.1, 30000);
  private noseAlignBlend = 0;
  private noseAlignInitialized = false;
  private readonly offset = new Vector3();
  private readonly desired = new Vector3();
  private readonly ahead = new Vector3();
  private readonly oldLookDir = new Vector3();
  private readonly lookDir = new Vector3();
  private readonly lookTarget = new Vector3();
  private readonly aircraftUp = new Vector3();
  private readonly cameraUp = new Vector3();
  private first = true;

  update(pos: Vector3, q: Quaternion, speed: number, dt: number, aimDir: Vector3 | null): void {
    const speedFactor = Math.min(
      Math.max((speed - gameConfig.flight.stallSpeed) / (gameConfig.flight.maxSpeed - gameConfig.flight.stallSpeed), 0),
      1,
    );
    const distance = chaseCfg.distance * (1 - speedFactor * 0.15);
    this.offset.set(0, chaseCfg.height, distance).applyQuaternion(q);
    this.desired.copy(pos).add(this.offset);
    if (this.first) {
      this.camera.position.copy(this.desired);
      this.first = false;
    } else {
      this.camera.position.lerp(this.desired, 1 - Math.exp(-chaseCfg.positionLag * dt));
    }
    this.camera.position.y = Math.max(this.camera.position.y, chaseCfg.minGroundClearance);

    // 教练激活 → 相机视线与机头严格平行；关闭 → 原前向提前量注视
    this.ahead.set(0, 0, -1).applyQuaternion(q);
    if (aimDir !== null && !this.noseAlignInitialized) {
      this.noseAlignBlend = 1;
      this.noseAlignInitialized = true;
    }
    const targetBlend = aimDir !== null ? 1 : 0;
    this.noseAlignBlend += (targetBlend - this.noseAlignBlend) * Math.min(1, chaseCfg.noseAlignLag * dt);
    if (this.noseAlignBlend > 0.001) {
      this.oldLookDir
        .copy(pos)
        .addScaledVector(this.ahead, chaseCfg.lookAhead)
        .sub(this.camera.position)
        .normalize();
      this.lookDir.copy(this.oldLookDir).lerp(this.ahead, this.noseAlignBlend).normalize();
      this.lookTarget.copy(this.camera.position).addScaledVector(this.lookDir, 1000);
    } else {
      this.lookTarget.copy(pos).addScaledVector(this.ahead, chaseCfg.lookAhead);
    }

    this.aircraftUp.set(0, 1, 0).applyQuaternion(q);
    this.cameraUp.set(0, 1, 0).lerp(this.aircraftUp, chaseCfg.rollFollow).normalize();
    this.camera.up.copy(this.cameraUp);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();
  }

  /** 屏幕像素 → 世界视线方向（复刻 render 层反投影） */
  rayFromScreen(px: number, py: number, out: Vector3): Vector3 {
    return out
      .set((px / W) * 2 - 1, -(py / H) * 2 + 1, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position)
      .normalize();
  }
}

/** 运行一个耦合场景：光标固定在屏幕比例位置 (fx, fy)（可选中途切换） */
function runCoupled(
  name: string,
  cursorA: { fx: number; fy: number },
  seconds: number,
  tuning: InstructorTuning = DEFAULT_INSTRUCTOR_TUNING,
  cursorB?: { fx: number; fy: number; atSec: number },
): void {
  const entity = new SimEntity(1, 'aircraft', new Vector3(0, 3000, 0));
  entity.variant = 'player';
  entity.aircraft = createAircraftData(false);
  entity.aircraft.onGround = false;
  entity.aircraft.speed = 180;
  entity.aircraft.throttle = 0.62;

  const cam = new MiniChaseCamera();
  const aimDir = new Vector3();
  const forward = new Vector3();
  const input: ControlInput = {
    pitch: 0, roll: 0, yaw: 0, throttleUp: false, throttleDown: false,
    fire: false, cycleWeapon: false, switchTarget: false, flare: false,
    wingmanCommand: false, reset: false, mouseAim: true, aimDir: null,
  };

  let cursor = cursorA;
  let cursorSwitchDone = false;
  /** 全程航向率/俯仰角样本（蛇形检测与稳态判定） */
  const headingRateSamples: number[] = [];
  const pitchSamples: number[] = [];
  let prevHeading = 0;
  let headingInitialized = false;
  let maxAbsG = 0;
  let totalHeadingChange = 0;

  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const t = i * DT;
    if (cursorB !== undefined && !cursorSwitchDone && t >= cursorB.atSec) {
      cursor = cursorB;
      cursorSwitchDone = true;
    }

    // 1) 光标反投影（用上一帧相机——与真实游戏的一帧滞后一致）
    cam.rayFromScreen(cursor.fx * W, cursor.fy * H, aimDir);
    input.aimDir = aimDir;

    // 2) 教练 + 飞行积分
    computeInstructorStick(entity.quaternion, aimDir, tuning, stick);
    (input as { pitch: number }).pitch = stick.pitch;
    (input as { roll: number }).roll = stick.roll;
    (input as { yaw: number }).yaw = stick.yaw;
    integrateAircraftFlight(entity, input, DT);

    // 3) 相机更新（机头平行视线）
    cam.update(entity.position, entity.quaternion, entity.aircraft!.speed, DT, aimDir);

    // 4) 指标采样
    forward.set(0, 0, -1).applyQuaternion(entity.quaternion);
    const heading = Math.atan2(forward.x, -forward.z);
    if (!headingInitialized) {
      prevHeading = heading;
      headingInitialized = true;
    }
    let dHead = heading - prevHeading;
    if (dHead > Math.PI) dHead -= Math.PI * 2;
    if (dHead < -Math.PI) dHead += Math.PI * 2;
    prevHeading = heading;
    totalHeadingChange += dHead;
    headingRateSamples.push(dHead / DT);
    pitchSamples.push(Math.asin(forward.y));
    maxAbsG = Math.max(maxAbsG, Math.abs(entity.aircraft!.gLoad));
  }

  // 末段 40% 稳态判定：航向率均值/极差/符号翻转（蛇形检测）
  const tail = headingRateSamples.slice(Math.floor(headingRateSamples.length * 0.6));
  let signFlips = 0;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i]! * tail[i - 1]! < 0 && Math.abs(tail[i]!) > 0.02 && Math.abs(tail[i - 1]!) > 0.02) {
      signFlips += 1;
    }
  }
  const tailAbs = tail.map(Math.abs);
  const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const tailWobble = (Math.max(...tailAbs) + 1e-6) / (Math.abs(tailMean) + 1e-6);
  const tailPitch = pitchSamples.slice(Math.floor(pitchSamples.length * 0.6));
  const tailPitchMeanRad = tailPitch.reduce((a, b) => a + b, 0) / tailPitch.length;
  const tailPitchVar = Math.sqrt(
    tailPitch.reduce((a, b) => a + (b - tailPitchMeanRad) ** 2, 0) / tailPitch.length,
  );
  const tailPitchMean = (tailPitchMeanRad * 180) / Math.PI;
  const tailPitchStd = (tailPitchVar * 180) / Math.PI;

  console.log(
    `${name}: 累计转向=${((totalHeadingChange * 180) / Math.PI).toFixed(0)}° 末段航向率=${((tailMean * 180) / Math.PI).toFixed(1)}°/s 摆振比=${tailWobble.toFixed(2)} 翻转=${signFlips} | 末段俯仰=${tailPitchMean.toFixed(1)}°±${tailPitchStd.toFixed(1)}° 高度变化=${(entity.position.y - 3000).toFixed(0)}m 最大|G|=${maxAbsG.toFixed(1)}`,
  );
}

console.log('--- S1 松手居中（期望：航向率≈0、高度平稳、无漂移） ---');
runCoupled('居中 12s        ', { fx: 0.5, fy: 0.5 }, 12);
console.log('--- S2 光标停右缘（期望：持续平滑右转、摆振比≈1） ---');
runCoupled('右缘 (0.85,0.5) ', { fx: 0.85, fy: 0.5 }, 12);
console.log('--- S3 右推1.5s回中（期望：转一段时间后航向率→0 停住） ---');
runCoupled('右推→回中       ', { fx: 0.85, fy: 0.5 }, 10, DEFAULT_INSTRUCTOR_TUNING, { fx: 0.5, fy: 0.5, atSec: 1.5 });
console.log('--- S4 滑条 ×2.0（期望：仍稳定） ---');
const fast: InstructorTuning = { pursuitResponse: 2, rudderAssist: 1 };
runCoupled('右缘 ×2.0       ', { fx: 0.85, fy: 0.5 }, 12, fast);
runCoupled('右推回中 ×2.0   ', { fx: 0.85, fy: 0.5 }, 10, fast, { fx: 0.5, fy: 0.5, atSec: 1.5 });
console.log('--- S5 光标停上方（期望：持续上拉/筋斗、俯仰持续变化） ---');
runCoupled('上方 (0.5,0.32) ', { fx: 0.5, fy: 0.32 }, 12);
console.log('--- S6 左下对角（最难场景：期望持续左下转、稳定） ---');
runCoupled('左下 (0.18,0.66)', { fx: 0.18, fy: 0.66 }, 12);
