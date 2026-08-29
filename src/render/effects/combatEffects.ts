import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  SphereGeometry,
  Vector3,
} from 'three';

/**
 * 战斗特效系统（爆炸 / 命中火花 / 导弹烟迹）
 *
 * 功能：以对象池粒子网格呈现战斗特效——
 * 1) 空中爆炸：橙红火球碎片四散 + 中心闪光，随时间膨胀淡出；
 * 2) 地面爆炸：更大火球 + 灰色烟柱持续上飘；
 * 3) 命中火花：小型黄色火花迸溅；
 * 4) 导弹烟迹：导弹飞行沿途排放灰色烟点，缓慢膨胀消散。
 * 全部粒子复用固定池（无运行时分配），由渲染帧 update(dt) 推进。
 * 边界约定：本类属渲染层装饰，不读取/不修改任何模拟状态；
 * 触发源为模拟事件与导弹实体位置（只读）。
 */
export class CombatEffects {
  /** 特效粒子挂载组（加入场景） */
  readonly group = new Group();

  /** 粒子池（网格复用，active 标记是否在播） */
  private readonly particles: EffectParticle[] = [];
  /** 池容量（防爆量） */
  private readonly capacity: number;
  /** 池游标（环形取空闲粒子） */
  private cursor = 0;
  /** 上一帧时刻（毫秒，update 自算 dt 兜底） */
  private lastTimeMs = performance.now();

  /** 空爆碎片颜色 */
  private static readonly FIRE_COLOR = new Color(0xff7a33);
  /** 空爆核心闪光颜色 */
  private static readonly FLASH_COLOR = new Color(0xffe9a8);
  /** 烟迹/烟柱颜色 */
  private static readonly SMOKE_COLOR = new Color(0x8a8f96);
  /** 命中火花颜色 */
  private static readonly SPARK_COLOR = new Color(0xffd166);
  /** 共享球体几何（全部粒子复用，单位半径按 scale 缩放） */
  private static readonly GEOMETRY = new SphereGeometry(1, 8, 6);

  /**
   * 构造战斗特效系统
   *
   * @param capacity 粒子池容量（缺省 240；过小则爆炸残缺，过大浪费绘制）
   * 异常：无
   * 注意事项：池满时新粒子覆盖最旧粒子（环形游标），不丢帧不报错
   */
  constructor(capacity: number = 240) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      const material = new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      });
      const mesh = new Mesh(CombatEffects.GEOMETRY, material);
      mesh.visible = false;
      this.group.add(mesh);
      this.particles.push({
        mesh,
        material,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 0,
        life: 0,
        maxLife: 1,
        startScale: 1,
        endScale: 1,
        startOpacity: 1,
        endOpacity: 1,
        drag: 0,
        gravity: 0,
        active: false,
      });
    }
  }

  /**
   * 生成空中爆炸特效
   *
   * 功能：在指定位置生成 1 个大闪光核心 + 10 个橙红火球碎片
   * （随机方向扩散、受重力与阻力），持续约 0.9 秒
   * @param position 爆炸位置（世界坐标）
   * @returns void
   * 异常：无
   */
  spawnAirExplosion(position: Vector3): void {
    this.emitParticle(position, CombatEffects.FLASH_COLOR, 6, 26, 0.5, 1, 4, 0, 0.92);
    for (let i = 0; i < 10; i++) {
      const dir = randomUnitVector();
      this.emitParticle(
        position,
        CombatEffects.FIRE_COLOR,
        2.2,
        9,
        0.7,
        0.55,
        2.6,
        1.6,
        2.4,
        dir.x * 34,
        dir.y * 34 + 6,
        dir.z * 34,
      );
    }
  }

  /**
   * 生成地面爆炸特效
   *
   * 功能：低空/地面位置生成更大火球（12 个碎片、更高上抛）+
   * 灰色烟柱（6 个烟点持续上飘膨胀，寿命更长），持续约 1.6 秒
   * @param position 爆炸位置（世界坐标）
   * @returns void
   * 异常：无
   */
  spawnGroundExplosion(position: Vector3): void {
    this.emitParticle(position, CombatEffects.FLASH_COLOR, 9, 40, 0.6, 1, 4.2, 0, 0.92);
    for (let i = 0; i < 12; i++) {
      const dir = randomUnitVector();
      this.emitParticle(
        position,
        CombatEffects.FIRE_COLOR,
        3,
        12,
        0.9,
        0.6,
        3.4,
        1.8,
        2.6,
        dir.x * 40,
        Math.abs(dir.y) * 46 + 10,
        dir.z * 40,
      );
    }
    // 烟柱：持续上飘的灰色烟点
    for (let i = 0; i < 6; i++) {
      this.emitParticle(
        position,
        CombatEffects.SMOKE_COLOR,
        4,
        16,
        1.6,
        0.4,
        1.2,
        0.8,
        0,
        (Math.random() * 2 - 1) * 6,
        16 + Math.random() * 10,
        (Math.random() * 2 - 1) * 6,
      );
    }
  }

  /**
   * 生成命中火花特效
   *
   * 功能：机炮命中点生成 3 个小型黄色火花（快速消散）
   * @param position 命中位置（世界坐标）
   * @returns void
   * 异常：无
   */
  spawnHitSpark(position: Vector3): void {
    for (let i = 0; i < 3; i++) {
      const dir = randomUnitVector();
      this.emitParticle(
        position,
        CombatEffects.SPARK_COLOR,
        0.7,
        2.6,
        0.28,
        0.9,
        0.9,
        2,
        0,
        dir.x * 22,
        dir.y * 22,
        dir.z * 22,
      );
    }
  }

  /**
   * 排放导弹烟迹粒子
   *
   * 功能：在导弹当前位置生成一个灰色烟点（小尺寸、寿命较长、
   * 缓慢膨胀），由渲染帧对每枚存活导弹调用形成连续尾迹
   * @param position 导弹当前位置（世界坐标）
   * @returns void
   * 异常：无
   * 注意事项：调用方按帧率控制排放密度（本系统每帧每弹排 1 粒）
   */
  emitMissileTrail(position: Vector3): void {
    this.emitParticle(
      position,
      CombatEffects.SMOKE_COLOR,
      1.1,
      4.5,
      1.1,
      0.35,
      0.5,
      0.4,
      0,
      (Math.random() * 2 - 1) * 1.5,
      1,
      (Math.random() * 2 - 1) * 1.5,
    );
  }

  /**
   * 释放单个粒子（私有核心）
   *
   * 功能：从池中取下一格粒子写入初值并激活；
   * 池满时覆盖游标处粒子（环形复用）
   * @param position 出生位置
   * @param color 粒子颜色
   * @param startScale 初始缩放（米）
   * @param endScale 结束缩放（米）
   * @param maxLife 寿命（秒）
   * @param startOpacity 初始不透明度
   * @param endOpacity 结束不透明度
   * @param drag 速度阻尼系数（1/s）
   * @param gravity 重力加速度（m/s²，正=下坠）
   * @param vx 初速度 X 分量（m/s）
   * @param vy 初速度 Y 分量（m/s）
   * @param vz 初速度 Z 分量（m/s）
   * @returns void
   * 异常：无
   */
  private emitParticle(
    position: Vector3,
    color: Color,
    startScale: number,
    endScale: number,
    maxLife: number,
    startOpacity: number,
    endOpacity: number,
    drag: number,
    gravity: number,
    vx: number = 0,
    vy: number = 0,
    vz: number = 0,
  ): void {
    const p = this.particles[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.capacity;

    p.mesh.position.copy(position);
    p.mesh.visible = true;
    p.material.color.copy(color);
    p.material.opacity = startOpacity;
    p.mesh.scale.setScalar(startScale);
    p.velocityX = vx;
    p.velocityY = vy;
    p.velocityZ = vz;
    p.life = maxLife;
    p.maxLife = maxLife;
    p.startScale = startScale;
    p.endScale = endScale;
    p.startOpacity = startOpacity;
    p.endOpacity = endOpacity;
    p.drag = drag;
    p.gravity = gravity;
    p.active = true;
    // 烟迹用普通混合保持灰度感；火球/火花用叠加混合提亮
    p.material.blending = color === CombatEffects.SMOKE_COLOR ? NormalBlending : AdditiveBlending;
  }

  /**
   * 推进全部粒子（每渲染帧）
   *
   * 功能：按帧间隔积分粒子——速度阻尼 + 重力 + 位置步进 +
   * 缩放/不透明度按寿命比例插值；寿命耗尽隐藏归池
   * @param dt 帧间隔（秒；<=0 时自算兜底）
   * @returns void
   * 异常：无
   * 注意事项：dt 钳制到 0.1s 抵御切页尖峰
   */
  update(dt: number): void {
    if (dt <= 0) {
      const now = performance.now();
      dt = Math.min((now - this.lastTimeMs) / 1000, 0.1);
    }
    this.lastTimeMs = performance.now();
    const dtc = Math.min(dt, 0.1);

    for (const p of this.particles) {
      if (!p.active) {
        continue;
      }
      p.life -= dtc;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      // 速度阻尼 + 重力
      const damping = Math.max(0, 1 - p.drag * dtc);
      p.velocityX *= damping;
      p.velocityY = p.velocityY * damping - p.gravity * dtc;
      p.velocityZ *= damping;
      p.mesh.position.x += p.velocityX * dtc;
      p.mesh.position.y += p.velocityY * dtc;
      p.mesh.position.z += p.velocityZ * dtc;

      // 缩放与透明度按剩余寿命插值（t: 1→0）
      const t = p.life / p.maxLife;
      const scale = p.startScale + (p.endScale - p.startScale) * (1 - t);
      p.mesh.scale.setScalar(scale);
      p.material.opacity = p.startOpacity + (p.endOpacity - p.startOpacity) * (1 - t);
      if (p.material.opacity <= 0.01) {
        p.active = false;
        p.mesh.visible = false;
      }
    }
  }

  /**
   * 释放全部粒子资源
   *
   * 功能：销毁全部粒子材质并清空挂载组（几何为共享静态资源不销毁）
   * @returns void
   * 异常：无
   * 注意事项：仅应用销毁时调用
   */
  dispose(): void {
    for (const p of this.particles) {
      p.material.dispose();
      this.group.remove(p.mesh);
    }
    this.particles.length = 0;
  }
}

/** 特效粒子（池元素：网格 + 运动状态） */
interface EffectParticle {
  /** 粒子网格 */
  readonly mesh: Mesh;
  /** 粒子材质（透明度独立控制） */
  readonly material: MeshBasicMaterial;
  /** 初速度分量（m/s） */
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  /** 剩余寿命（秒） */
  life: number;
  /** 总寿命（秒） */
  maxLife: number;
  /** 初始缩放（米） */
  startScale: number;
  /** 结束缩放（米） */
  endScale: number;
  /** 初始不透明度 */
  startOpacity: number;
  /** 结束不透明度 */
  endOpacity: number;
  /** 速度阻尼（1/s） */
  drag: number;
  /** 重力（m/s²） */
  gravity: number;
  /** 是否在播 */
  active: boolean;
}

/**
 * 生成随机单位向量（私有工具）
 *
 * @returns 单位长度的随机方向向量（新对象，仅特效初始化使用）
 * 异常：无
 */
function randomUnitVector(): Vector3 {
  const theta = Math.random() * Math.PI * 2;
  const z = Math.random() * 2 - 1;
  const r = Math.sqrt(1 - z * z);
  return new Vector3(r * Math.cos(theta), r * Math.sin(theta), z);
}
