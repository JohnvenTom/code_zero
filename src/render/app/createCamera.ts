import { PerspectiveCamera } from 'three';
import { gameConfig } from '../../config';

/**
 * 创建透视相机
 *
 * 功能：按配置初始化透视相机的视场角/裁剪面/宽高比；
 * 实际位姿由追尾跟随相机控制器（chaseCamera）每帧驱动
 * @param aspect 初始宽高比（窗口宽/高）
 * @returns 相机实例
 * 异常：无
 * 注意事项：相机初始位置无意义（首帧被追尾控制器吸附到战机后方）
 */
export function createCamera(aspect: number): PerspectiveCamera {
  const cfg = gameConfig.camera;
  return new PerspectiveCamera(cfg.fov, aspect, cfg.near, cfg.far);
}
