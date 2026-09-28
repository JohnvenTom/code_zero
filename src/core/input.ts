import { gameConfig } from '../config';
import type { Vector3 } from 'three';
import type { ControlInput } from '../simulation';
import { saveUserSettings, userSettings } from './settingsStore';

/** 推杆（低头）灵敏度系数（手感调优：拉杆全量、推杆略柔） */
const PUSH_SENSITIVITY = 0.8;

/** 瞄准方向提供者：屏幕坐标 → 世界坐标方向（main 层注入渲染层反投影） */
export type AimDirProvider = (cursorX: number, cursorY: number) => Vector3 | null;

/** 鼠标教练瞄准状态快照（HUD 设定点环/光标隐藏消费） */
export interface MouseAimState {
  /** 教练是否激活（M 键开关 ×持久化设置） */
  readonly active: boolean;
  /** 光标横坐标（像素，已钳制在窗口内） */
  readonly cursorX: number;
  /** 光标纵坐标（像素，已钳制在窗口内） */
  readonly cursorY: number;
}

/**
 * 键盘+鼠标输入管理器
 *
 * 功能：监听窗口键盘事件与文档级鼠标事件，将按键状态维护为按下集合
 * 与一次性动作队列（换武器/切目标/干扰弹/重置为边沿触发），
 * 按 simulation 层定义的 ControlInput 结构输出纯数据快照，
 * 供固定步模拟采样；俯仰输入不对称调优（拉杆全量、推杆 0.8 倍）。
 * 键位映射（迭代11 重构）：W/S 油门、↑↓ 俯仰、←→ 滚转、
 * A/D 踩舵（偏航）、空格=发射当前选中武器、R=循环切换武器、
 * X=切换锁定目标、C=僚机指令、E=干扰弹、Backspace=坠毁重置；
 * 迭代12 鼠标教练：M=开关鼠标教练（持久化）、左键=开火（同空格）、
 * 滚轮=切武器（同 R）、右键=切目标（同 X）、光标=教练瞄准设定点。
 * 自由光标防坑：光标坐标钳制在窗口内（甩出窗口不丢设定点）、
 * contextmenu/wheel 默认行为强制拦截、失焦清空按键状态。
 * 边界约定：本类属于 core 层的 DOM 桥接件，只产生纯数据，
 * 不包含任何游戏规则；键位与灵敏度均来自配置表；
 * 屏幕坐标→世界方向的换算经注入的 aimDirProvider 完成
 * （本类不接触渲染层）。
 */
export class InputManager {
  /** 当前按下的 KeyboardEvent.code 集合 */
  private readonly pressed = new Set<string>();
  /** 待消费的一次性动作：重置键（Backspace） */
  private pendingReset = false;
  /** 待消费的一次性动作：循环切换武器键（R 或滚轮） */
  private pendingCycleWeapon = false;
  /** 待消费的一次性动作：切换锁定目标键（X 或右键） */
  private pendingSwitchTarget = false;
  /** 待消费的一次性动作：干扰弹释放键（E） */
  private pendingFlare = false;
  /** 待消费的一次性动作：僚机指令循环键（C） */
  private pendingWingmanCommand = false;
  /** 全部被游戏占用的键位集合（用于 preventDefault 拦截浏览器默认行为） */
  private readonly actionCodes: Set<string>;
  /** 键位映射配置（模块级只读引用） */
  private readonly keys = gameConfig.input.keys;
  /** 鼠标左键是否按住（开火，与空格同通道） */
  private mouseFireDown = false;
  /** 光标横坐标（像素，钳制在窗口内；初始屏幕中心） */
  private cursorX = window.innerWidth / 2;
  /** 光标纵坐标（像素，钳制在窗口内；初始屏幕中心） */
  private cursorY = window.innerHeight / 2;
  /** 瞄准方向提供者（main 层注入；null=尚未装配，鼠标瞄准暂不可用） */
  private aimDirProvider: AimDirProvider | null = null;

  /**
   * 构造输入管理器
   *
   * 功能：构建键位占用集合（滚转/偏航/发射为数组键位，展开注册）
   * 并挂载 keydown/keyup/blur 键盘与 mousemove/mousedown/mouseup/
   * wheel/contextmenu 鼠标事件监听
   * 参数：无
   * 异常：无
   * 注意事项：键盘监听挂 window、鼠标监听挂 document（自由光标
   * 需覆盖全窗口含 HUD 覆盖层）；页面卸载时由浏览器回收，
   * 无需显式销毁（如需可调用 dispose）
   */
  constructor() {
    this.actionCodes = new Set<string>([
      this.keys.pitchPull,
      this.keys.pitchPush,
      ...this.keys.rollLeft,
      ...this.keys.rollRight,
      ...this.keys.yawLeft,
      ...this.keys.yawRight,
      this.keys.throttleUp,
      this.keys.throttleDown,
      this.keys.reset,
      this.keys.cycleWeapon,
      this.keys.switchTarget,
      this.keys.flare,
      this.keys.wingmanCommand,
      gameConfig.input.mouse.toggleKey,
      ...this.keys.fire,
    ]);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('contextmenu', this.onContextMenu);
  }

  /**
   * 注入瞄准方向提供者（main 层装配时调用）
   *
   * @param provider 屏幕坐标 → 世界坐标单位方向（渲染层反投影）
   * @returns void
   */
  setAimDirProvider(provider: AimDirProvider): void {
    this.aimDirProvider = provider;
  }

  /**
   * 获取鼠标教练瞄准状态（HUD/光标隐藏消费）
   *
   * @returns 教练激活位与钳制后的光标坐标
   */
  getMouseAimState(): MouseAimState {
    return {
      active: userSettings.mouseAimEnabled,
      cursorX: this.cursorX,
      cursorY: this.cursorY,
    };
  }

  /**
   * 采样玩家输入快照
   *
   * 功能：将当前按键与鼠标状态转换为 ControlInput 纯数据；
   * cycleWeapon/switchTarget/flare/wingmanCommand/reset 为边沿触发
   * （consumePending 语义，仅首个采样固定步读到 true）；
   * 开火 = 空格按住 ∪ 鼠标左键按住；鼠标教练激活时附带
   * 经提供者反投影的世界瞄准方向（aimDir；提供者未装配或
   * 教练关闭时 aimDir 为 null）
   * @returns 玩家控制输入快照
   * 异常：无
   * 注意事项：每固定步调用一次；一帧内多固定步共享同一持续按键状态；
   * aimDir 引用提供者内部复用向量，仅在本次固定步消费有效
   */
  sample(): ControlInput {
    const keys = this.keys;
    const rawPitch = (this.isDown(keys.pitchPull) ? 1 : 0) + (this.isDown(keys.pitchPush) ? -1 : 0);
    // 滚转：←→（数组键位，任一按下即生效）
    const roll =
      (keys.rollRight.some((code) => this.isDown(code)) ? 1 : 0) +
      (keys.rollLeft.some((code) => this.isDown(code)) ? -1 : 0);
    // 偏航（踩舵）：A/D（数组键位）
    const yaw =
      (keys.yawRight.some((code) => this.isDown(code)) ? 1 : 0) +
      (keys.yawLeft.some((code) => this.isDown(code)) ? -1 : 0);
    // 俯仰不对称：拉杆（抬头）保持全量，推杆（低头）衰减——
    // 街机空战手感（抬头跟手、俯冲可控）
    const pitch = rawPitch > 0 ? rawPitch : rawPitch * PUSH_SENSITIVITY;
    const fire = keys.fire.some((code) => this.pressed.has(code)) || this.mouseFireDown;
    const cycleWeapon = this.pendingCycleWeapon;
    const switchTarget = this.pendingSwitchTarget;
    const flare = this.pendingFlare;
    const wingmanCommand = this.pendingWingmanCommand;
    const reset = this.pendingReset;
    this.pendingCycleWeapon = false;
    this.pendingSwitchTarget = false;
    this.pendingFlare = false;
    this.pendingWingmanCommand = false;
    this.pendingReset = false;
    const mouseAim = userSettings.mouseAimEnabled;
    return {
      pitch,
      roll,
      yaw,
      throttleUp: this.isDown(keys.throttleUp),
      throttleDown: this.isDown(keys.throttleDown),
      fire,
      cycleWeapon,
      switchTarget,
      flare,
      wingmanCommand,
      reset,
      mouseAim,
      aimDir: mouseAim && this.aimDirProvider !== null
        ? this.aimDirProvider(this.cursorX, this.cursorY)
        : null,
    };
  }

  /**
   * 释放事件监听
   *
   * 功能：移除全部键盘与鼠标监听并清空按键状态
   * @returns void
   * 异常：无
   * 注意事项：仅应用销毁/重建输入系统时调用
   */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('contextmenu', this.onContextMenu);
    this.pressed.clear();
    this.mouseFireDown = false;
    this.pendingCycleWeapon = false;
    this.pendingSwitchTarget = false;
    this.pendingFlare = false;
    this.pendingWingmanCommand = false;
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
   * 功能：拦截游戏键位的浏览器默认行为（Backspace 的后退导航等），
   * 登记按下状态；换武器/切目标/干扰弹/僚机/重置键为一次性动作
   * 仅登记一次（忽略长按重复）；鼠标教练开关键切换持久化设置
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
    } else if (event.code === this.keys.cycleWeapon) {
      this.pendingCycleWeapon = true;
    } else if (event.code === this.keys.switchTarget) {
      this.pendingSwitchTarget = true;
    } else if (event.code === this.keys.flare) {
      this.pendingFlare = true;
    } else if (event.code === this.keys.wingmanCommand) {
      this.pendingWingmanCommand = true;
    } else if (event.code === gameConfig.input.mouse.toggleKey) {
      saveUserSettings({ mouseAimEnabled: !userSettings.mouseAimEnabled });
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
    this.mouseFireDown = false;
    this.pendingCycleWeapon = false;
    this.pendingSwitchTarget = false;
    this.pendingFlare = false;
    this.pendingWingmanCommand = false;
    this.pendingReset = false;
  };

  /**
   * mousemove 事件处理（私有）
   *
   * 功能：更新光标位置并钳制在窗口内——光标甩出窗口后
   * 保留最后合法位置（教练设定点不丢失）
   * @param event 鼠标事件
   * @returns void
   */
  private onMouseMove = (event: MouseEvent): void => {
    this.cursorX = Math.min(Math.max(event.clientX, 0), window.innerWidth);
    this.cursorY = Math.min(Math.max(event.clientY, 0), window.innerHeight);
  };

  /**
   * mousedown 事件处理（私有）
   *
   * 功能：左键登记开火持续状态；右键登记一次性切目标动作
   * @param event 鼠标事件
   * @returns void
   */
  private onMouseDown = (event: MouseEvent): void => {
    if (event.button === 0) {
      this.mouseFireDown = true;
    } else if (event.button === 2) {
      this.pendingSwitchTarget = true;
    }
  };

  /**
   * mouseup 事件处理（私有）
   *
   * 功能：左键释放清除开火持续状态
   * @param event 鼠标事件
   * @returns void
   */
  private onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) {
      this.mouseFireDown = false;
    }
  };

  /**
   * wheel 事件处理（私有）
   *
   * 功能：滚轮任意方向滚动登记一次性切武器动作（循环切换无方向语义）
   * 并拦截页面滚动默认行为
   * @param event 滚轮事件
   * @returns void
   */
  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.pendingCycleWeapon = true;
  };

  /**
   * contextmenu 事件处理（私有）
   *
   * 功能：拦截右键菜单（右键已用作切锁定目标）
   * @param event 上下文菜单事件
   * @returns void
   */
  private onContextMenu = (event: Event): void => {
    event.preventDefault();
  };
}
