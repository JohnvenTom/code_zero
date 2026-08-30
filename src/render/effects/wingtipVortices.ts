import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineSegments,
  LineBasicMaterial,
  Vector3,
} from 'three';

/**
 * 翼尖涡流拖尾系统（航迹云式常驻白色雾化拖尾）
 *
 * 功能：为每架存活战机（玩家/敌机/僚机）在双翼尖生成常驻渐隐条带——
 * 空中飞行时始终可见（与航迹云一致，久留空中约 720m 后自然淡出），
 * 高 G 机动时透明度额外增强（G 2→6 渐强白雾感）；
 * 每帧从翼尖世界坐标按固定距离采样向历史位置延伸；
 * 以池化 LineSegments 实现（每机 2 条，容量按实体上限分配），
 * 历史位置环形缓冲（避免运行时分配），逐段顶点色渐隐。
 * 边界约定：本类属渲染层装饰，只读取实体插值位姿与 G 值。
 */
export class WingtipVortices {
  /** 涡流挂载组（加入场景） */
  readonly group = new Group();

  /** 涡流条带池（每条=一架飞机的一个翼尖） */
  private readonly trails: VortexTrail[] = [];
  /** 池容量（同时可见的最大飞机数 × 2 翼尖） */
  private readonly maxTrails: number;
  /** 历史位置环形缓冲长度（每条；固定距离采样，120 点×6m≈720m 航迹云式拖尾） */
  private static readonly HISTORY = 120;
  /** 相邻历史点的采样距离（米；拖尾长度与速度解耦，久留空中） */
  private static readonly SAMPLE_DISTANCE = 6;
  /** 采样启用高度（米；地面滑跑不产生航迹） */
  private static readonly MIN_ALTITUDE = 25;

  /** 涡流颜色 */
  private static readonly COLOR = new Color(0xe8f2f8);

  /**
   * 构造翼尖涡流系统
   *
   * @param maxAircraft 最大同时跟踪飞机数（缺省 12；池容量=该值×2）
   * 异常：无
   * 注意事项：LineSegments 每条一个 draw call，容量 24 条可控
   */
  constructor(maxAircraft: number = 12) {
    this.maxTrails = maxAircraft * 2;
    for (let i = 0; i < this.maxTrails; i++) {
      // 每条涡流 HISTORY-1 段线段（HISTORY 个历史点）
      const segmentCount = WingtipVortices.HISTORY - 1;
      const positions = new Float32Array(segmentCount * 6);
      // 顶点色：逐段渐隐（旧段更透明，实现拖尾淡出）
      const colors = new Float32Array(segmentCount * 6);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
      geometry.setDrawRange(0, 0); // 初始不可见
      const material = new LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        vertexColors: true,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const lines = new LineSegments(geometry, material);
      lines.visible = false;
      lines.frustumCulled = false; // 涡流长度跨越视锥判定盒，手动关闭剔除
      this.group.add(lines);
      this.trails.push({
        lines,
        material,
        history: [],
        ownerId: -1,
      });
    }
  }

  /**
   * 每渲染帧更新全部涡流（实体插值同步后调用）
   *
   * 功能：遍历传入的飞机实体（含插值位姿与 G 值）——
   * 1) 按实体 ID 池化分配条带（消失时释放归池）；
   * 2) 计算双翼尖世界坐标（±翼展偏移×实体姿态）；
   * 3) 追加历史位置（环形缓冲）；
   * 4) 按 |G| 计算强度（G≤3 隐藏，3→6 线性增强，>6 饱和），
   *    写入线段顶点（沿历史点连线，透明度随段龄衰减）。
   * @param aircraft 本帧的飞机渲染数据列表（id/位置/姿态/G）
   * @returns void
   * 异常：无
   * 注意事项：调用方须在实体插值同步后调用；翼尖偏移取机型
   * 翼展一半（渲染网格主翼约 ±7m）
   */
  update(aircraft: readonly AircraftFrame[]): void {
    // 池分配：按实体 ID 匹配已有条带，新实体取空闲条带
    const usedTrails = new Set<VortexTrail>();
    const frames = new Map<number, AircraftFrame>();
    for (const frame of aircraft) {
      frames.set(frame.id, frame);
    }
    // 保留仍存活的实体条带
    for (const trail of this.trails) {
      if (trail.ownerId !== -1 && frames.has(trail.ownerId)) {
        usedTrails.add(trail);
      } else if (trail.ownerId !== -1) {
        trail.ownerId = -1;
        trail.history.length = 0;
        trail.lines.visible = false;
        trail.material.opacity = 0;
      }
    }
    // 新实体取空闲条带（左右各一）
    for (const frame of aircraft) {
      let hasTrail = false;
      for (const trail of this.trails) {
        if (trail.ownerId === frame.id) {
          hasTrail = true;
          break;
        }
      }
      if (!hasTrail) {
        const idle = this.findIdleTrail();
        if (idle !== null) {
          idle.ownerId = frame.id;
          idle.side = 'left';
          idle.history.length = 0;
          usedTrails.add(idle);
        }
        const idleRight = this.findIdleTrail();
        if (idleRight !== null) {
          idleRight.ownerId = frame.id;
          idleRight.side = 'right';
          idleRight.history.length = 0;
          usedTrails.add(idleRight);
        }
      }
    }

    // 更新每条涡流
    for (const trail of this.trails) {
      if (trail.ownerId === -1) {
        continue;
      }
      const frame = frames.get(trail.ownerId);
      if (frame === undefined) {
        continue;
      }
      // 翼尖世界坐标（±7m 沿机体 X 轴）
      const sideSign = trail.side === 'left' ? -1 : 1;
      _tip.set(sideSign * 7, 0, 0).applyQuaternion(frame.quaternion).add(frame.position);

      // 追加历史点（固定距离采样：翼尖移动超过 SAMPLE_DISTANCE 才入列，
      // 使拖尾长度与飞行速度/时间解耦；仅空中产生航迹，地面滑跑不采样）
      const first = trail.history[0];
      if (
        frame.position.y > WingtipVortices.MIN_ALTITUDE &&
        (first === undefined || first.distanceTo(_tip) >= WingtipVortices.SAMPLE_DISTANCE)
      ) {
        trail.history.unshift(_tip.clone());
        if (trail.history.length > WingtipVortices.HISTORY) {
          trail.history.length = WingtipVortices.HISTORY;
        }
      }

      // 强度：常驻航迹云基线 + |G| 机动增强（G 2→6 线性提升，>6 饱和）
      // 涡流始终可见（与航迹云一致），高 G 时更浓更亮
      const g = Math.abs(frame.gLoad);
      const gBoost = Math.min(Math.max((g - 2) / 4, 0), 1);
      trail.lines.visible = trail.history.length >= 2;
      if (trail.history.length < 2) {
        continue;
      }
      trail.material.opacity = 0.4 + 0.5 * gBoost;

      // 写入线段顶点与顶点色：相邻历史点连线，颜色按段龄渐隐
      // （新段亮白、旧段趋透明——拖尾自然淡出效果）
      const positions = trail.lines.geometry.getAttribute('position');
      const colorAttr = trail.lines.geometry.getAttribute('color');
      const segmentCount = trail.history.length - 1;
      for (let i = 0; i < segmentCount; i++) {
        const a = trail.history[i]!;
        const b = trail.history[i + 1]!;
        positions.setXYZ(i * 2, a.x, a.y, a.z);
        positions.setXYZ(i * 2 + 1, b.x, b.y, b.z);
        // 段龄渐隐系数：i=0（最新）为 1，最旧段线性衰减到 0
        const ageFade = 1 - i / segmentCount;
        const r = WingtipVortices.COLOR.r * ageFade;
        const g2 = WingtipVortices.COLOR.g * ageFade;
        const b2 = WingtipVortices.COLOR.b * ageFade;
        colorAttr.setXYZ(i * 2, r, g2, b2);
        colorAttr.setXYZ(i * 2 + 1, r, g2, b2);
      }
      positions.needsUpdate = true;
      colorAttr.needsUpdate = true;
      trail.lines.geometry.setDrawRange(0, segmentCount * 2);
    }
  }

  /**
   * 查找空闲条带（私有）
   *
   * @returns 空闲涡流条带；池耗尽时返回 null
   * 异常：无
   */
  private findIdleTrail(): VortexTrail | null {
    for (const trail of this.trails) {
      if (trail.ownerId === -1) {
        return trail;
      }
    }
    return null;
  }

  /**
   * 释放全部涡流资源
   *
   * 功能：销毁全部几何与材质并清空挂载组
   * @returns void
   * 异常：无
   */
  dispose(): void {
    for (const trail of this.trails) {
      trail.lines.geometry.dispose();
      trail.material.dispose();
      this.group.remove(trail.lines);
    }
    this.trails.length = 0;
  }
}

/** 涡流条带（池元素） */
interface VortexTrail {
  /** 线段渲染对象 */
  readonly lines: LineSegments;
  /** 线材质（透明度随强度） */
  readonly material: LineBasicMaterial;
  /** 历史翼尖位置（环形缓冲，新点在前） */
  history: Vector3[];
  /** 归属实体 ID（-1=空闲） */
  ownerId: number;
  /** 翼尖侧（新分配时写入） */
  side?: 'left' | 'right';
}

/** 飞机渲染帧数据（涡流更新输入） */
export interface AircraftFrame {
  /** 实体 ID */
  readonly id: number;
  /** 插值位置（世界坐标） */
  readonly position: Vector3;
  /** 插值姿态 */
  readonly quaternion: import('three').Quaternion;
  /** 当前 G 值 */
  readonly gLoad: number;
}

/** 模块级复用对象：翼尖局部偏移 */
const _tip = new Vector3();
