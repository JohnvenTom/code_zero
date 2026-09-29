import { Vector3 } from 'three';
import type { PerspectiveCamera, Quaternion } from 'three';
import { gameConfig } from '../../config';

/** 追尾相机配置的模块级引用 */
const chaseCfg = gameConfig.camera.chase;
/** 飞行配置的模块级引用（速度区间用于 FOV 速度感） */
const flightCfg = gameConfig.flight;

/** 追尾相机控制器接口 */
export interface ChaseCameraController {
  /**
   * 每渲染帧更新相机位姿
   * @param targetPosition 跟随目标的插值位置（世界坐标）
   * @param targetQuaternion 跟随目标的插值姿态
   * @param speed 目标速度标量（m/s，驱动 FOV 速度感）
   * @param gLoad 目标当前过载（G，驱动机动镜头抖动）
   * @param dt 本渲染帧间隔（秒）
   * @param aimDir 鼠标瞄准方向（世界坐标；传非 null 表示教练激活）。
   *  迭代12：教练激活时相机视线与机头严格平行（光标屏幕偏移=瞄准
   *  角差的无动态测量）；关闭时平滑回退原机头前向提前量注视
   */
  update(
    targetPosition: Vector3,
    targetQuaternion: Quaternion,
    speed: number,
    gLoad: number,
    dt: number,
    aimDir?: Vector3 | null,
  ): void;
}

/** 模块级复用对象：机体坐标系下的相机偏移 */
const _offset = new Vector3();
/** 模块级复用对象：期望相机位置 */
const _desired = new Vector3();
/** 模块级复用对象：注视目标点 */
const _lookTarget = new Vector3();
/** 模块级复用对象：原注视方向（机头前向提前量，从相机位置出发） */
const _oldLookDir = new Vector3();
/** 模块级复用对象：混合后的注视方向（平行机头过渡） */
const _lookDir = new Vector3();
/** 模块级复用对象：前向注视偏移 */
const _ahead = new Vector3();
/** 模块级复用对象：机体 up 向量 */
const _aircraftUp = new Vector3();
/** 模块级复用对象：混合后的相机 up 向量 */
const _cameraUp = new Vector3();

/**
 * 创建追尾跟随相机控制器
 *
 * 功能：以阻尼跟随方式把相机保持在战机后上方——
 * 1) 位置指数阻尼跟随（首帧直接吸附避免开场甩镜）；
 * 2) 相机 up 向机体 up 部分混合，滚转时镜头随之倾斜（机动镜头）；
 * 3) FOV 随速度在基础值与加速档间平滑过渡（速度感）；
 * 4) 高过载时叠加小幅位置抖动（机动冲击感）；
 * 5) 相机高度不低于离地净空
 * @param camera 被驱动的透视相机
 * @returns 追尾相机控制器
 * 异常：无
 * 注意事项：update 应在实体插值同步之后、场景绘制之前调用；
 * dt 钳制到 0.1 秒以抵御切页后的巨大帧间隔
 */
export function createChaseCamera(camera: PerspectiveCamera): ChaseCameraController {
  let firstUpdate = true;
  let currentFov = gameConfig.camera.fov;
  /** 平行视线混合权重 0..1（教练开→1 平行机头 / 关→0 原注视点） */
  let noseAlignBlend = 0;
  /** 首次教练激活直接吸附平行视线（任务开始于地面，跳过过渡避免初始俯仰瞬态） */
  let noseAlignInitialized = false;

  return {
    update(targetPosition, targetQuaternion, speed, gLoad, dt, aimDir) {
      const dtc = Math.min(Math.max(dt, 0), 0.1);

      // 高速相机修正：速度感 FOV 增幅收敛（fovBoost 6°上限）+
      // 相机距离随速度略拉近（高速时 0.85 倍距离补偿，
      // 保持飞机在画面中占比不缩小太多）
      const speedFactor = Math.min(
        Math.max((speed - flightCfg.stallSpeed) / (flightCfg.maxSpeed - flightCfg.stallSpeed), 0),
        1,
      );
      const zoomCompensation = 1 - speedFactor * 0.15; // 1.0 → 0.85
      const effectiveDistance = chaseCfg.distance * zoomCompensation;

      // 期望位置：机体后上方（机体 +Z 为机尾方向）
      _offset.set(0, chaseCfg.height, effectiveDistance).applyQuaternion(targetQuaternion);
      _desired.copy(targetPosition).add(_offset);

      if (firstUpdate) {
        camera.position.copy(_desired);
        firstUpdate = false;
      } else {
        const t = 1 - Math.exp(-chaseCfg.positionLag * dtc);
        camera.position.lerp(_desired, t);
      }

      // 机动镜头：高过载小幅抖动
      const shakeFactor = Math.min(
        Math.max((gLoad - chaseCfg.shakeGThreshold) / 6, 0),
        1,
      );
      if (shakeFactor > 0) {
        const amount = chaseCfg.shakeAmount * shakeFactor;
        camera.position.x += (Math.random() * 2 - 1) * amount;
        camera.position.y += (Math.random() * 2 - 1) * amount;
        camera.position.z += (Math.random() * 2 - 1) * amount;
      }

      // 离地净空钳制（贴地机动时避免相机穿地）
      camera.position.y = Math.max(camera.position.y, chaseCfg.minGroundClearance);

      // ---- 注视方向（迭代12）：教练激活时相机视线与机头严格平行 ----
      // 平行视线让"光标屏幕偏移 = 瞄准角差"成为零动态、零偏置的测量：
      // 相机姿态只随机头（位置滞后不影响过光标射线的方向），不存在
      // "机头追瞄准→相机追机头→瞄准随机头"的追逐环——
      // 光标居中 = 瞄准=机头 = 直线飞行（零漂移）；
      // 光标偏移 = 恒定角差 = 平稳持续转弯（战雷"光标指哪往哪转"）。
      // 机头在画面中略偏下居中（后上视角固有几何，战雷同款构图）。
      // 教练关闭时按 noseAlignBlend 平滑回退原"机头前向提前量"注视
      _ahead.set(0, 0, -1).applyQuaternion(targetQuaternion);
      const aimActive = aimDir !== undefined && aimDir !== null;
      if (aimActive && !noseAlignInitialized) {
        // 首次激活（任务开始）直接到位：混合过渡期相机带旧注视偏置，
        // 会给教练一个瞬态向下误差（松手缓降的来源）
        noseAlignBlend = 1;
        noseAlignInitialized = true;
      }
      const targetBlend = aimActive ? 1 : 0;
      noseAlignBlend += (targetBlend - noseAlignBlend) * Math.min(1, chaseCfg.noseAlignLag * dtc);
      if (noseAlignBlend > 0.001) {
        // 原注视方向（飞机前方提前量，从相机位置望向该点）→ 平行机头方向
        _oldLookDir
          .copy(targetPosition)
          .addScaledVector(_ahead, chaseCfg.lookAhead)
          .sub(camera.position)
          .normalize();
        _lookDir.copy(_oldLookDir).lerp(_ahead, noseAlignBlend).normalize();
        _lookTarget.copy(camera.position).addScaledVector(_lookDir, 1000);
      } else {
        _lookTarget.copy(targetPosition).addScaledVector(_ahead, chaseCfg.lookAhead);
      }

      // up 向量：世界 up 与机体 up 混合，滚转时镜头部分跟随倾斜
      _aircraftUp.set(0, 1, 0).applyQuaternion(targetQuaternion);
      _cameraUp.set(0, 1, 0).lerp(_aircraftUp, chaseCfg.rollFollow).normalize();
      camera.up.copy(_cameraUp);
      camera.lookAt(_lookTarget);

      // 速度感 FOV：速度区间内平滑放大视场（迭代11：增幅收敛 6° 上限，
      // 原 16° 上限过大会让飞机在画面中占比缩小太多）
      const targetFov = gameConfig.camera.fov + speedFactor * 6;
      currentFov += (targetFov - currentFov) * Math.min(1, chaseCfg.fovLag * dtc);
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    },
  };
}
