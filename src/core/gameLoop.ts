import { gameConfig, type LoopConfig } from '../config';

/**
 * 主循环回调集
 */
export interface GameLoopCallbacks {
  /** 固定步长模拟回调；dt 恒定等于配置的 fixedTimestep（秒） */
  fixedUpdate: (dt: number) => void;
  /**
   * 渲染回调
   * @param alpha 插值系数 ∈ [0,1)，表示上一固定步到当前累积进度，用于渲染插值
   * @param frameDt 本真实帧间隔（秒，已钳制），供性能统计使用
   */
  render: (alpha: number, frameDt: number) => void;
}

/**
 * 固定时间步长游戏主循环（accumulator 模式）
 *
 * 功能：以 requestAnimationFrame 驱动，将真实帧时间累积后按固定步长
 * 整数次调用 fixedUpdate，再以剩余累积比例 alpha 调用 render 做插值渲染，
 * 保证模拟确定性与不同刷新率显示器下的手感一致。
 * 注意事项：
 * - 单帧累积时间被钳制在 maxFrameTime 内（后台标签页切回时的巨大帧间隔）
 * - 单帧固定步数达到 maxFixedStepsPerFrame 时丢弃剩余累积，防死亡螺旋
 */
export class GameLoop {
  /** 模拟与渲染回调集 */
  private readonly callbacks: GameLoopCallbacks;
  /** 固定模拟步长（秒） */
  private readonly fixedTimestep: number;
  /** 单帧最大累积时间（秒） */
  private readonly maxFrameTime: number;
  /** 单帧最大固定步数 */
  private readonly maxFixedStepsPerFrame: number;
  /** rAF 句柄；null 表示循环已停止 */
  private rafId: number | null = null;
  /** 上一帧时间戳（毫秒）；null 表示尚未开始首帧 */
  private lastTimeMs: number | null = null;
  /** 时间累积器（秒） */
  private accumulator = 0;

  /**
   * 构造主循环
   *
   * @param callbacks 模拟与渲染回调
   * @param options 可选参数覆盖（缺省取 gameConfig.loop）
   * 异常：无
   * 注意事项：构造后需调用 start() 启动；fixedTimestep 必须为正数
   */
  constructor(callbacks: GameLoopCallbacks, options?: Partial<LoopConfig>) {
    this.callbacks = callbacks;
    this.fixedTimestep = options?.fixedTimestep ?? gameConfig.loop.fixedTimestep;
    this.maxFrameTime = options?.maxFrameTime ?? gameConfig.loop.maxFrameTime;
    this.maxFixedStepsPerFrame = options?.maxFixedStepsPerFrame ?? gameConfig.loop.maxFixedStepsPerFrame;
  }

  /**
   * 启动主循环
   *
   * 功能：注册 requestAnimationFrame 帧回调开始循环；重复调用无副作用
   * 参数：无
   * 返回值：void
   * 异常：无
   * 注意事项：启动时重置时间基准与累积器，避免残留旧的暂停状态
   */
  start(): void {
    if (this.rafId !== null) {
      return;
    }
    this.lastTimeMs = null;
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * 停止主循环
   *
   * 功能：取消已注册的帧回调，循环暂停；可再次 start() 恢复
   * 参数：无
   * 返回值：void
   * 异常：无
   * 注意事项：停止时不清空累积器，恢复时 start() 会统一重置
   */
  stop(): void {
    if (this.rafId === null) {
      return;
    }
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /**
   * 帧回调（私有）
   *
   * 功能：计算真实帧间隔 → 累积 → 按固定步长整步推进模拟 → 以剩余比例插值渲染
   * @param nowMs requestAnimationFrame 提供的当前时间戳（毫秒）
   * @returns void
   * 异常：回调内部异常会向上冒泡（本类不吞异常，便于问题暴露）
   * 注意事项：先注册下一帧再执行本帧逻辑，保证循环连续；
   * 帧间隔钳制到 [0, maxFrameTime] 以抵御系统时间回拨与切页尖峰
   */
  private tick = (nowMs: number): void => {
    this.rafId = requestAnimationFrame(this.tick);
    const lastMs = this.lastTimeMs ?? nowMs;
    this.lastTimeMs = nowMs;
    const frameDt = Math.min(Math.max((nowMs - lastMs) / 1000, 0), this.maxFrameTime);
    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= this.fixedTimestep && steps < this.maxFixedStepsPerFrame) {
      this.callbacks.fixedUpdate(this.fixedTimestep);
      this.accumulator -= this.fixedTimestep;
      steps += 1;
    }
    if (steps >= this.maxFixedStepsPerFrame) {
      // 固定步数耗尽仍有积压：丢弃剩余累积，避免死亡螺旋
      this.accumulator = 0;
    }
    const alpha = this.accumulator / this.fixedTimestep;
    this.callbacks.render(alpha, frameDt);
  };
}
