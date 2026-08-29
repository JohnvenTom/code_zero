import { Vector3 } from 'three';
import type { SimulationWorld } from '../simulation';
import { createCamera } from './app/createCamera';
import { createChaseCamera } from './app/chaseCamera';
import { createEnvironment } from './app/createEnvironment';
import { createRenderer, type RendererHooks } from './app/createRenderer';
import { createScene } from './app/createScene';
import { RenderBridge } from './adapters/renderBridge';

/** createRenderApp 参数：画布容器 + 上下文事件钩子 */
export interface RenderAppOptions extends RendererHooks {
  /** WebGL canvas 挂载的容器元素（index.html 中的 #app） */
  container: HTMLElement;
}

/** 实体屏幕投影结果（HUD 屏幕空间元素定位用） */
export interface ScreenProjection {
  /** 屏幕横坐标（像素，左上为原点） */
  readonly x: number;
  /** 屏幕纵坐标（像素，左上为原点） */
  readonly y: number;
  /** 是否在相机前视锥内（false=在屏幕外或相机后方） */
  readonly onScreen: boolean;
}

/** 渲染应用统一接口（由主循环每帧驱动） */
export interface RenderApp {
  /** 渲染一帧：先同步实体插值状态，再驱动追尾相机，最后绘制场景 */
  render(world: SimulationWorld, alpha: number): void;
  /** 将实体当前渲染帧位置投影为屏幕坐标（HUD 锁定框定位用） */
  projectEntity(entityId: number): ScreenProjection | null;
  /** 处理窗口尺寸变化（更新相机宽高比与渲染器尺寸） */
  resize(): void;
  /** 释放全部渲染资源并移除 canvas */
  dispose(): void;
}

/** 模块级复用对象：投影计算向量 */
const _projectVec = new Vector3();

/**
 * 创建渲染应用（渲染层装配入口）
 *
 * 功能：创建渲染器（含上下文丢失处理）、场景（天空/雾/光照）、
 * 静态环境（地面/跑道/边界）、追尾相机与渲染桥，
 * 并组装为统一的 RenderApp 接口供主循环驱动
 * @param options 容器与上下文丢失/恢复钩子
 * @returns 渲染应用实例
 * @throws 浏览器不支持 WebGL 时向上抛出异常，由调用方兜底提示
 * 注意事项：render() 每帧调用一次，负责实体状态同步、
 * 追尾相机位姿更新与场景绘制；resize() 由 main.ts 监听 resize 触发
 */
export function createRenderApp(options: RenderAppOptions): RenderApp {
  const { renderer, canvas } = createRenderer(options.container, options);
  const { scene } = createScene();
  const camera = createCamera(window.innerWidth / window.innerHeight);
  const bridge = new RenderBridge();
  scene.add(bridge.group);

  const environment = createEnvironment();
  scene.add(environment.group);

  const chaseCamera = createChaseCamera(camera);
  let lastFrameMs = performance.now();

  return {
    /**
     * 渲染一帧
     *
     * @param world 模拟世界（读取实体插值状态与玩家引用）
     * @param alpha 插值系数 ∈ [0,1)
     */
    render(world, alpha) {
      bridge.syncFrom(world, alpha);

      // 追尾相机：读取玩家插值位姿与飞行状态（坠毁后玩家对象被移除，相机保持原位）
      const player = world.getPlayer();
      if (player !== null && player.aircraft !== undefined) {
        const playerObject = bridge.getObject(player.id);
        if (playerObject !== undefined) {
          const now = performance.now();
          const frameDt = (now - lastFrameMs) / 1000;
          lastFrameMs = now;
          chaseCamera.update(
            playerObject.position,
            playerObject.quaternion,
            player.aircraft.speed,
            player.aircraft.gLoad,
            frameDt,
          );
        }
      }

      renderer.render(scene, camera);
    },

    /**
     * 将实体当前渲染帧位置投影为屏幕坐标
     *
     * 功能：取实体渲染对象的插值位置，经相机投影矩阵变换为
     * NDC 坐标后换算为屏幕像素坐标，并判定是否在前视锥内
     * @param entityId 模拟实体 ID
     * @returns 屏幕投影；实体无渲染对象（未出现/已消亡）时返回 null
     * 异常：无
     * 注意事项：须在 render() 之后调用（插值位置已同步）；
     * NDC z>1 表示在相机后方
     */
    projectEntity(entityId) {
      const obj = bridge.getObject(entityId);
      if (obj === undefined) {
        return null;
      }
      _projectVec.copy(obj.position).project(camera);
      return {
        x: (_projectVec.x * 0.5 + 0.5) * window.innerWidth,
        y: (-_projectVec.y * 0.5 + 0.5) * window.innerHeight,
        onScreen:
          _projectVec.z < 1 && Math.abs(_projectVec.x) <= 1 && Math.abs(_projectVec.y) <= 1,
      };
    },

    /**
     * 处理窗口尺寸变化
     */
    resize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    },

    /**
     * 释放渲染资源
     */
    dispose() {
      bridge.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
