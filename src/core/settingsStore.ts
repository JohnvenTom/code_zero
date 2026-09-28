import { gameConfig } from '../config';

/**
 * 用户设置持久化（core 层 DOM 桥接件，迭代12）
 *
 * 功能：以 localStorage 保存用户输入偏好（鼠标教练开关/追踪响应/
 * 微舵倍率），启动时与默认值合并读取，变更时写回并通知监听者
 * （HUD/机库设置页/世界层实时同步）；
 * 损坏/缺失/版本不符的存档静默回落默认值，不抛异常。
 * 边界约定：本模块只做读写与合并，不包含任何游戏规则；
 * simulation 层禁止直接引用（由 main 层转发调参）。
 */

/** localStorage 存档键（v1：首版字段集合） */
const STORAGE_KEY = 'code-zero-settings-v1';

/** 用户设置（可变单例：读写均经 set* 入口保证落盘与通知） */
export interface UserSettings {
  /** 鼠标教练瞄准开关（M 键与设置页共享此状态） */
  mouseAimEnabled: boolean;
  /** 追踪响应倍率 0.4..2（教练拉杆/滚转增益缩放） */
  pursuitResponse: number;
  /** 微调方向舵倍率 0..2（末端方向舵修正缩放，0=关闭） */
  rudderAssist: number;
}

/** 当前生效的用户设置单例（启动时从存档合并默认值） */
export const userSettings: UserSettings = {
  mouseAimEnabled: gameConfig.input.mouse.enabledByDefault,
  pursuitResponse: 1,
  rudderAssist: 1,
};

/** 设置变更监听者（设置页/世界调参/HUD 状态同步） */
type SettingsListener = (settings: UserSettings) => void;
const listeners: SettingsListener[] = [];

/**
 * 从 localStorage 加载设置（bootstrap 时调用一次）
 *
 * 功能：读取存档并做字段级校验（数值范围钳制、类型检查），
 * 任何字段损坏则该字段回落默认值；无存档时保持默认
 * @returns void
 * 异常：无（JSON 解析失败/localStorage 不可用均静默降级）
 */
export function loadUserSettings(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return;
    }
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) {
      return;
    }
    const record = data as Record<string, unknown>;
    if (typeof record.mouseAimEnabled === 'boolean') {
      userSettings.mouseAimEnabled = record.mouseAimEnabled;
    }
    if (typeof record.pursuitResponse === 'number' && Number.isFinite(record.pursuitResponse)) {
      userSettings.pursuitResponse = clamp(record.pursuitResponse, 0.4, 2);
    }
    if (typeof record.rudderAssist === 'number' && Number.isFinite(record.rudderAssist)) {
      userSettings.rudderAssist = clamp(record.rudderAssist, 0, 2);
    }
  } catch {
    // 存档损坏/隐私模式 localStorage 不可用：静默回落默认值
  }
}

/**
 * 写入设置并持久化+广播
 *
 * 功能：合并变更到单例、写 localStorage、依次通知监听者
 * @param patch 部分字段变更
 * @returns void
 * 异常：无（localStorage 写失败静默降级为会话内生效）
 */
export function saveUserSettings(patch: Partial<UserSettings>): void {
  Object.assign(userSettings, patch);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(userSettings));
  } catch {
    // 写入失败（隐私模式/容量满）：仅会话内生效
  }
  for (const listener of listeners) {
    listener(userSettings);
  }
}

/**
 * 注册设置变更监听
 *
 * @param listener 监听回调（接收最新设置单例）
 * @returns void
 */
export function onUserSettingsChanged(listener: SettingsListener): void {
  listeners.push(listener);
}

/** 数值钳制（私有） */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
