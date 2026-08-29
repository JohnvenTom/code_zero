import { gameConfig } from '../config';
import type { ControlInput } from '../simulation';

/** 推杆（低头）灵敏度系数（手感调优：拉杆全量、推杆略柔） */
const PUSH_SENSITIVITY = 0.8;

/**
 * 键盘输入管理器
 *
 * 功能：监听窗口键盘事件，将按键状态维护为按下集合与一次性动作队列
 * （导弹/干扰弹/重置为边沿触发），按 simulation 层定义的 ControlInput
 * 结构输出纯数据快照，供固定步模拟采样；俯仰输入不对称调优
 * （拉杆全量、推杆 0.8 倍，符合街机空战"抬头快低头柔"手感）；
 * 窗口失焦时自动清空避免按键卡死。
 * 边界约定：本类属于 core 层的 DOM 桥接件，只产生纯数据，
 * 不包含任何游戏规则；键位与灵敏度均来自配置表。
 */
export class InputManager {
  /** 当前按下的 KeyboardEvent.code 集合 */
  private readonly pressed = new Set<string>();
  /** 待消费的一次性动作：重置键 */
  private pendingReset = false;
  /** 待消费的一次性动作：导弹发射键 */
  private pendingMissile = false;
  /** 待消费的一次性动作：干扰弹释放键 */
  private pendingFlare = false;
  /** 待消费的一次性动作：特殊武器发射键 */
  private pendingSpecial = false;
  /** 待消费的一次性动作：特殊武器切换键 */
  private pendingCycleSpecial = false;
  /** 待消费的一次性动作：僚机指令循环键 */
  private pendingWingmanCommand = false;
  /** 全部被游戏占用的键位集合（用于 preventDefault 拦截浏览器默认行为） */
  private readonly actionCodes: Set<string>;
  /** 键位映射配置（模块级只读引用） */
  private readonly keys = gameConfig.input.keys;

  /**
   * 构造输入管理器
   *
   * 功能：构建键位占用集合并挂载 keydown/keyup/blur 事件监听
   * 参数：无
   * 异常：无
   * 注意事项：监听挂在 window 上随页面常驻；
   * 页面卸载时由浏览器回收，无需显式销毁（如需可调用 dispose）
   */
  constructor() {
    this.actionCodes = new Set<string>([
      this.keys.pitchPull,
      this.keys.pitchPush,
      this.keys.rollLeft,
      this.keys.rollRight,
      this.keys.yawLeft,
      this.keys.yawRight,
      this.keys.throttleUp,
      this.keys.throttleDown,
      this.keys.reset,
      this.keys.missile,
      this.keys.flare,
      this.keys.special,
      this.keys.cycleSpecial,
      this.keys.wingmanCommand,
      ...this.keys.fire,
    ]);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /**
   * 采样玩家输入快照
   *
   * 功能：将当前按键状态转换为 ControlInput 纯数据；
   * missile/flare/special/cycleSpecial/wingmanCommand/reset 为边沿触发
   * （consumePending 语义，仅首个采样固定步读到 true）
   * @returns 玩家控制输入快照
   * 异常：无
   * 注意事项：每固定步调用一次；一帧内多固定步共享同一持续按键状态
   */
  sample(): ControlInput {
    const keys = this.keys;
    const rawPitch = (this.isDown(keys.pitchPull) ? 1 : 0) + (this.isDown(keys.pitchPush) ? -1 : 0);
    const roll = (this.isDown(keys.rollRight) ? 1 : 0) + (this.isDown(keys.rollLeft) ? -1 : 0);
    const yaw = (this.isDown(keys.yawRight) ? 1 : 0) + (this.isDown(keys.yawLeft) ? -1 : 0);
    // 俯仰不对称：拉杆（抬头）保持全量，推杆（低头）衰减——
    // 街机空战手感（抬头跟手、俯冲可控）
    const pitch = rawPitch > 0 ? rawPitch : rawPitch * PUSH_SENSITIVITY;
    const fire = keys.fire.some((code) => this.pressed.has(code));
    const missile = this.pendingMissile;
    const flare = this.pendingFlare;
    const special = this.pendingSpecial;
    const cycleSpecial = this.pendingCycleSpecial;
    const wingmanCommand = this.pendingWingmanCommand;
    const reset = this.pendingReset;
    this.pendingMissile = false;
    this.pendingFlare = false;
    this.pendingSpecial = false;
    this.pendingCycleSpecial = false;
    this.pendingWingmanCommand = false;
    this.pendingReset = false;
    return {
      pitch,
      roll,
      yaw,
      throttleUp: this.isDown(keys.throttleUp),
      throttleDown: this.isDown(keys.throttleDown),
      fire,
      missile,
      flare,
      special,
      cycleSpecial,
      wingmanCommand,
      reset,
    };
  }

  /**
   * 释放事件监听
   *
   * 功能：移除全部窗口监听并清空按键状态
   * @returns void
   * 异常：无
   * 注意事项：仅应用销毁/重建输入系统时调用
   */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
    this.pendingMissile = false;
    this.pendingFlare = false;
    this.pendingSpecial = false;
    this.pendingCycleSpecial = false;
    this.pendingReset = false;
  }

  /**
   * 查询键位是否按下
   *
   * @param code KeyboardEvent.code
   * @returns 按下为 true
   */
  private isDown(code: string): boolean {
    return this.pressed.has(code);
  }

  /**
   * keydown 事件处理（私有）
   *
   * 功能：拦截游戏键位的浏览器默认行为，登记按下状态；
   * 导弹/干扰弹/特殊武器/重置键为一次性动作仅登记一次（忽略长按重复）
   * @param event 键盘事件
   * @returns void
   * 异常：无
   * 注意事项：e.repeat 的长按重复对按下集合无意义，直接跳过
   */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.actionCodes.has(event.code)) {
      return;
    }
    event.preventDefault();
    if (event.repeat) {
      return;
    }
    this.pressed.add(event.code);
    if (event.code === this.keys.reset) {
      this.pendingReset = true;
    } else if (event.code === this.keys.missile) {
      this.pendingMissile = true;
    } else if (event.code === this.keys.flare) {
      this.pendingFlare = true;
    } else if (event.code === this.keys.special) {
      this.pendingSpecial = true;
    } else if (event.code === this.keys.cycleSpecial) {
      this.pendingCycleSpecial = true;
    } else if (event.code === this.keys.wingmanCommand) {
      this.pendingWingmanCommand = true;
    }
  };

  /**
   * keyup 事件处理（私有）
   *
   * @param event 键盘事件
   * @returns void
   */
  private onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  /**
   * 窗口失焦处理（私有）
   *
   * 功能：清空全部按键状态与一次性动作，避免切页后按键卡死
   * @returns void
   */
  private onBlur = (): void => {
    this.pressed.clear();
    this.pendingMissile = false;
    this.pendingFlare = false;
    this.pendingSpecial = false;
    this.pendingCycleSpecial = false;
    this.pendingWingmanCommand = false;
    this.pendingReset = false;
  };
}
