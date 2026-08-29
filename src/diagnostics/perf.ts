/**
 * 性能探针：FPS 与帧耗时的滑动窗口统计
 *
 * 功能：每帧喂入真实帧间隔，维护最近 N 帧的滑动平均，
 * 为 HUD 状态条与后续性能验收（目标 60fps）提供数据。
 * 注意事项：本类只做统计不含渲染；frameDt 为 0 时按极小值处理避免除零。
 */
export class PerfProbe {
  /** 帧间隔样本（秒） */
  private readonly samples: number[] = [];
  /** 滑动窗口容量 */
  private readonly maxSamples: number;

  /**
   * 构造性能探针
   *
   * @param maxSamples 滑动窗口容量（帧数），缺省 60（约 1 秒窗口）
   * 异常：无
   * 注意事项：容量越大统计越平滑、但对帧率突变越迟钝
   */
  constructor(maxSamples: number = 60) {
    this.maxSamples = Math.max(1, Math.floor(maxSamples));
  }

  /**
   * 记录一帧
   *
   * 功能：将本帧真实间隔推入滑动窗口，超出容量时淘汰最旧样本
   * @param frameDt 本帧间隔（秒，非负）
   * @returns void
   * 异常：无
   * 注意事项：由主循环每帧调用；负值/零值会被钳制为极小正数
   */
  update(frameDt: number): void {
    this.samples.push(Math.max(frameDt, 1e-6));
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * 平均 FPS
   *
   * @returns 滑动窗口内的平均帧率；无样本时返回 1000000（占位，避免除零）
   */
  get fps(): number {
    return 1 / this.averageDt;
  }

  /**
   * 平均帧耗时（毫秒）
   *
   * @returns 滑动窗口内的平均帧间隔换算为毫秒
   */
  get averageFrameMs(): number {
    return this.averageDt * 1000;
  }

  /**
   * 计算滑动窗口平均帧间隔（私有）
   *
   * @returns 平均帧间隔（秒）
   */
  private get averageDt(): number {
    if (this.samples.length === 0) {
      return 1e-6;
    }
    let sum = 0;
    for (const sample of this.samples) {
      sum += sample;
    }
    return sum / this.samples.length;
  }
}
