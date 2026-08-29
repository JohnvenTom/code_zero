import { Vector3 } from 'three';
import type { EntityVariant } from './entity';
import type { SpecialWeaponType } from '../config';
import type { WingmanCommand } from './components';

/**
 * 模拟事件（模拟层 → UI/渲染层的单向通知）
 *
 * 功能：以纯数据形式播报模拟层内发生的瞬时事件（命中/击毁/坠毁/
 * 导弹发射与爆炸/干扰弹释放/锁定状态变化/特殊武器发射），供 HUD
 * 反馈与后续特效系统消费。
 * 注意事项：事件在世界内排队，由渲染帧通过 consumeEvents() 一次性取走；
 * position 为发生时刻的位置快照（已 clone，调用方可安全持有）。
 */
export type GameEvent =
  | { readonly type: 'gun-hit'; readonly position: Vector3 }
  | {
      readonly type: 'target-destroyed';
      readonly position: Vector3;
      /** 被摧毁目标的实体变体（敌机/靶标等，HUD 据此区分文案与统计） */
      readonly variant: EntityVariant;
    }
  | { readonly type: 'player-crash'; readonly position: Vector3 }
  | { readonly type: 'missile-launched'; readonly position: Vector3; readonly byPlayer: boolean }
  | { readonly type: 'missile-hit'; readonly position: Vector3 }
  | { readonly type: 'missile-miss'; readonly position: Vector3 }
  | { readonly type: 'flare-released'; readonly position: Vector3; readonly byPlayer: boolean }
  | { readonly type: 'lock-acquired'; readonly targetId: number }
  | { readonly type: 'lock-lost' }
  | {
      readonly type: 'special-launched';
      readonly position: Vector3;
      /** 特殊武器类型（HUD 提示文案用） */
      readonly weapon: SpecialWeaponType;
    }
  | {
      readonly type: 'wingman-command';
      /** 新指令（HUD 指令显示用） */
      readonly command: WingmanCommand;
    };
