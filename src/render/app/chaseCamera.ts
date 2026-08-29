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
   */
  update(
    targetPosition: Vector3,
    targetQuaternion: Quaternion,
    speed: number,
    gLoad: number,
    dt: number,
  ): void;
}

/** 模块级复用对象：机体坐标系下的相机偏移 */
const _offset = new Vector3();
/** 模块级复用对象：期望相机位置 */
const _desired = new Vector3();
/** 模块级复用对象：注视目标点 */
const _lookTarget = new Vector3();
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

  return {
    update(targetPosition, targetQuaternion, speed, gLoad, dt) {
      const dtc = Math.min(Math.max(dt, 0), 0.1);

      // 期望位置：机体后上方（机体 +Z 为机尾方向）
      _offset.set(0, chaseCfg.height, chaseCfg.distance).applyQuaternion(targetQuaternion);
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

      // 注视点：机头前方提前量
      _ahead.set(0, 0, -chaseCfg.lookAhead).applyQuaternion(targetQuaternion);
      _lookTarget.copy(targetPosition).add(_ahead);

      // up 向量：世界 up 与机体 up 混合，滚转时镜头部分跟随倾斜
      _aircraftUp.set(0, 1, 0).applyQuaternion(targetQuaternion);
      _cameraUp.set(0, 1, 0).lerp(_aircraftUp, chaseCfg.rollFollow).normalize();
      camera.up.copy(_cameraUp);
      camera.lookAt(_lookTarget);

      // 速度感 FOV：速度区间内平滑放大视场
      const speedFactor = Math.min(
        Math.max((speed - flightCfg.stallSpeed) / (flightCfg.maxSpeed - flightCfg.stallSpeed), 0),
        1,
      );
      const targetFov = gameConfig.camera.fov + speedFactor * chaseCfg.fovBoost;
      currentFov += (targetFov - currentFov) * Math.min(1, chaseCfg.fovLag * dtc);
      camera.fov = currentFov;
      camera.updateProjectionMatrix();
    },
  };
}
