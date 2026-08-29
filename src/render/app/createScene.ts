import {
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  Float32BufferAttribute,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Scene,
  SphereGeometry,
} from 'three';
import { gameConfig } from '../../config';

/** createScene 返回结构 */
export interface SceneBundle {
  /** 场景实例 */
  scene: Scene;
  /** 平行光（日光）引用，供后续昼夜系统调节 */
  sunLight: DirectionalLight;
}

/**
 * 计算平滑阶梯插值（smoothstep）
 *
 * @param edge0 起始边（返回 0）
 * @param edge1 结束边（返回 1）
 * @param x 输入值
 * @returns 0..1 的平滑插值，区间外钳制
 * 异常：无
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * 创建渐变天空穹
 *
 * 功能：以内背面球体 + 逐顶点颜色插值构造天顶→地平线的渐变天穹；
 * 地平线以下保持地平线色，与雾色一致实现远景无缝融合
 * @returns 天空穹网格（半径与分段来自 gameConfig.sky）
 * 异常：无
 * 注意事项：材质关闭雾效与深度写入，不透明队列中最后绘制，
 * 天穹半径必须小于相机远裁剪面
 */
function createSkyDome(): Mesh {
  const cfg = gameConfig.sky;
  const geometry = new SphereGeometry(cfg.domeRadius, 32, 20);
  const position = geometry.getAttribute('position');
  const vertexCount = position.count;
  const colors = new Float32Array(vertexCount * 3);

  const zenith = new Color(cfg.zenithColor);
  const horizon = new Color(cfg.horizonColor);
  const vertex = new Color();

  for (let i = 0; i < vertexCount; i++) {
    // 归一化高度：-1（天底）..1（天顶）；地平线附近缓慢过渡到天顶色
    const normalizedY = position.getY(i) / cfg.domeRadius;
    const t = smoothstep(-0.06, 0.55, normalizedY);
    vertex.copy(horizon).lerp(zenith, t);
    colors[i * 3] = vertex.r;
    colors[i * 3 + 1] = vertex.g;
    colors[i * 3 + 2] = vertex.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));

  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    fog: false,
    depthWrite: false,
  });
  return new Mesh(geometry, material);
}

/**
 * 创建基础场景
 *
 * 功能：构建场景——渐变天空穹、线性雾（远景融入地平线）、
 * 半球环境光 + 平行日光 + 少量环境光兜底，构成完整的户外光照环境
 * 参数：无（参数来自 gameConfig.scene / gameConfig.lighting / gameConfig.sky）
 * 返回值：场景与日光引用
 * 异常：无
 * 注意事项：昼夜光照切换（迭代6）通过调节 sunLight/hemi 实现即可；
 * 雾色与天空地平线色保持一致以避免远景接缝
 */
export function createScene(): SceneBundle {
  const scene = new Scene();
  scene.background = new Color(gameConfig.scene.background);

  const skyCfg = gameConfig.sky;
  scene.fog = new Fog(skyCfg.fogColor, skyCfg.fogNear, skyCfg.fogFar);
  scene.add(createSkyDome());

  const lightCfg = gameConfig.lighting;
  const hemi = new HemisphereLight(
    lightCfg.hemiSkyColor,
    lightCfg.hemiGroundColor,
    lightCfg.hemiIntensity,
  );
  scene.add(hemi);

  const ambient = new AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  const sunLight = new DirectionalLight(0xfff4e0, lightCfg.sunIntensity);
  const [x, y, z] = lightCfg.sunDirection;
  sunLight.position.set(x, y, z);
  scene.add(sunLight);

  return { scene, sunLight };
}
