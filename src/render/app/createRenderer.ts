import { WebGLRenderer } from 'three';
import { gameConfig } from '../../config';

/** 渲染器上下文事件钩子（用于 UI 提示） */
export interface RendererHooks {
  /** WebGL 上下文丢失时触发 */
  onContextLost?: () => void;
  /** WebGL 上下文恢复成功时触发 */
  onContextRestored?: () => void;
}

/** createRenderer 返回结构 */
export interface RendererBundle {
  /** WebGL 渲染器实例 */
  renderer: WebGLRenderer;
  /** 已挂载到容器的 canvas 元素 */
  canvas: HTMLCanvasElement;
}

/**
 * 创建 WebGL 渲染器
 *
 * 功能：初始化 WebGLRenderer（抗锯齿、设备像素比上限、全屏尺寸），
 * 将 canvas 挂载到指定容器，并注册 WebGL 上下文丢失/恢复事件监听
 * @param container canvas 挂载的目标容器元素
 * @param hooks 上下文丢失/恢复回调（可选，用于 UI 层提示）
 * @returns 渲染器与 canvas
 * @throws 浏览器不支持 WebGL 时 WebGLRenderer 构造函数抛出异常，由调用方兜底
 * 注意事项：webglcontextlost 必须 preventDefault 才允许浏览器自动恢复上下文；
 * 上下文恢复后 three 会自动重新上传 GPU 资源
 */
export function createRenderer(container: HTMLElement, hooks: RendererHooks = {}): RendererBundle {
  const renderer = new WebGLRenderer({ antialias: gameConfig.renderer.antialias });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, gameConfig.renderer.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  const canvas = renderer.domElement;
  container.appendChild(canvas);

  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault();
    hooks.onContextLost?.();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    hooks.onContextRestored?.();
  });

  return { renderer, canvas };
}
