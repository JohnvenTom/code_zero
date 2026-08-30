import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

/** 爆炸类型（决定特效规模与构成） */
export type ExplosionKind = 'small' | 'large';

/**
 * 战斗特效系统（爆炸 / 命中火花 / 导弹烟迹）
 *
 * 功能：以对象池粒子网格呈现战斗特效——
 * 1) 空中爆炸：多阶段火球（大闪光核心 + 火球碎片 + 延迟二次爆碎片 +
 *    冲击波扩散环）+ 浓密烟柱，击毁大目标（轰炸机/地面）规模更大；
 * 2) 地面爆炸：更大火球 + 更高上抛 + 更浓密持久的烟柱 + 冲击波环；
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
  /** 深色浓烟颜色（大爆炸后期烟团） */
  private static readonly DARK_SMOKE_COLOR = new Color(0x555a60);
  /** 冲击波环颜色 */
  private static readonly SHOCK_COLOR = new Color(0xfff2d0);
  /** 共享球体几何（全部粒子复用，单位半径按 scale 缩放） */
  private static readonly GEOMETRY = new SphereGeometry(1, 8, 6);
  /** 共享冲击波环几何（XZ 平面环，单位半径按 scale 缩放） */
  private static readonly RING_GEOMETRY = new RingGeometry(0.82, 1, 40);

  /**
   * 构造战斗特效系统
   *
   * @param capacity 粒子池容量（缺省 300；过小则爆炸残缺，过大浪费绘制）
   * 异常：无
   * 注意事项：池满时新粒子覆盖最旧粒子（环形游标），不丢帧不报错
   */
  constructor(capacity: number = 300) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      const material = new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
        side: 2, // DoubleSide（冲击波环需要双面渲染）
      });
      // 前 40 格用环几何（冲击波专用），其余用球几何
      const mesh = new Mesh(i < 40 ? CombatEffects.RING_GEOMETRY : CombatEffects.GEOMETRY, material);
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
        delay: 0,
        ring: i < 40,
        active: false,
      });
    }
  }

  /**
   * 生成空中爆炸特效（迭代11 增强版：多阶段 + 冲击波环）
   *
   * 功能：在指定位置按爆炸类型生成完整多阶段爆炸——
   * 1) 大闪光核心（膨胀更大）；
   * 2) 一波橙红火球碎片（随机方向扩散、受重力与阻力）；
   * 3) 延迟 0.12-0.25s 的二次爆炸碎片（延迟粒子，模拟殉爆）；
   * 4) 冲击波扩散环（XZ 平面快速放大淡出）；
   * 5) 浓密烟柱（灰烟 + 深色浓烟双层，持续更久）。
   * 大目标（轰炸机）规模约为小敌机的 1.8 倍
   * @param position 爆炸位置（世界坐标）
   * @param kind 爆炸类型（small=小敌机；large=轰炸机/大目标）
   * @returns void
   * 异常：无
   */
  spawnAirExplosion(position: Vector3, kind: ExplosionKind = 'small'): void {
    const s = kind === 'large' ? 1.8 : 1;
    // 1) 大闪光核心（膨胀至 2 倍规模）
    this.emitParticle(position, CombatEffects.FLASH_COLOR, 7 * s, 52 * s, 0.55, 1, 4, 0, 0.92);
    // 2) 一波火球碎片（数量翻倍、扩散更远）
    const primaryCount = kind === 'large' ? 20 : 14;
    for (let i = 0; i < primaryCount; i++) {
      const dir = randomUnitVector();
      this.emitParticle(
        position,
        CombatEffects.FIRE_COLOR,
        2.6 * s,
        13 * s,
        0.75,
        0.6,
        2.6,
        1.6,
        2.4,
        dir.x * 40 * s,
        dir.y * 40 * s + 8,
        dir.z * 40 * s,
      );
    }
    // 3) 延迟二次爆碎片（殉爆感）
    const secondaryCount = kind === 'large' ? 12 : 7;
    for (let i = 0; i < secondaryCount; i++) {
      const dir = randomUnitVector();
      this.emitDelayedParticle(
        position,
        CombatEffects.FIRE_COLOR,
        1.8 * s,
        8 * s,
        0.6,
        0.65,
        2.4,
        1.8,
        2.6,
        0.12 + Math.random() * 0.2,
        dir.x * 30 * s,
        dir.y * 30 * s + 6,
        dir.z * 30 * s,
      );
    }
    // 4) 冲击波扩散环（快速放大淡出）
    this.emitShockwave(position, kind);
    // 5) 浓密烟柱（灰烟 + 深色浓烟，持续更久）
    const smokeCount = kind === 'large' ? 12 : 8;
    for (let i = 0; i < smokeCount; i++) {
      this.emitParticle(
        position,
        CombatEffects.SMOKE_COLOR,
        3.4 * s,
        15 * s,
        2.2,
        0.45,
        1.1,
        0.8,
        -1.5,
        (Math.random() * 2 - 1) * 8 * s,
        12 + Math.random() * 14 * s,
        (Math.random() * 2 - 1) * 8 * s,
      );
    }
    for (let i = 0; i < 4; i++) {
      this.emitDelayedParticle(
        position,
        CombatEffects.DARK_SMOKE_COLOR,
        2.2 * s,
        9 * s,
        2.6,
        0.5,
        0.9,
        0.7,
        -1,
        0.15 + Math.random() * 0.3,
        (Math.random() * 2 - 1) * 4,
        8 + Math.random() * 8,
        (Math.random() * 2 - 1) * 4,
      );
    }
  }

  /**
   * 生成地面爆炸特效（迭代11 增强版）
   *
   * 功能：低空/地面位置生成更大火球（更多碎片、更高上抛）+
   * 延迟二次爆 + 冲击波环 + 双层浓密烟柱（持续更久）
   * @param position 爆炸位置（世界坐标）
   * @returns void
   * 异常：无
   */
  spawnGroundExplosion(position: Vector3): void {
    // 大闪光核心
    this.emitParticle(position, CombatEffects.FLASH_COLOR, 12, 68, 0.65, 1, 4.2, 0, 0.92);
    // 主火球碎片（数量与速度均提升）
    for (let i = 0; i < 22; i++) {
      const dir = randomUnitVector();
      this.emitParticle(
        position,
        CombatEffects.FIRE_COLOR,
        4,
        18,
        1.0,
        0.65,
        3.2,
        1.8,
        2.8,
        dir.x * 52,
        Math.abs(dir.y) * 58 + 14,
        dir.z * 52,
      );
    }
    // 延迟二次爆碎片
    for (let i = 0; i < 10; i++) {
      const dir = randomUnitVector();
      this.emitDelayedParticle(
        position,
        CombatEffects.FIRE_COLOR,
        2.6,
        12,
        0.75,
        0.7,
        2.4,
        1.8,
        2.6,
        0.15 + Math.random() * 0.25,
        dir.x * 38,
        Math.abs(dir.y) * 42 + 8,
        dir.z * 38,
      );
    }
    // 冲击波环（地面爆炸更大更慢）
    this.emitShockwave(position, 'large');
    // 烟柱：灰烟（数量与持续翻倍）+ 深色浓烟
    for (let i = 0; i < 12; i++) {
      this.emitParticle(
        position,
        CombatEffects.SMOKE_COLOR,
        5,
        24,
        2.6,
        0.5,
        1.0,
        0.7,
        -1.2,
        (Math.random() * 2 - 1) * 8,
        20 + Math.random() * 16,
        (Math.random() * 2 - 1) * 8,
      );
    }
    for (let i = 0; i < 6; i++) {
      this.emitDelayedParticle(
        position,
        CombatEffects.DARK_SMOKE_COLOR,
        3.4,
        16,
        3.2,
        0.55,
        0.8,
        0.6,
        -0.8,
        0.2 + Math.random() * 0.4,
        (Math.random() * 2 - 1) * 5,
        14 + Math.random() * 12,
        (Math.random() * 2 - 1) * 5,
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
   * 生成冲击波扩散环（私有）
   *
   * 功能：在爆炸位置生成一个 XZ 平面环，从极小尺寸快速放大至
   * 爆炸规模的 3 倍并快速淡出（0.45s）；环几何取自专用粒子池段
   * @param position 爆炸位置（世界坐标）
   * @param kind 爆炸类型（large 环更大）
   * @returns void
   * 异常：无
   * 注意事项：环粒子存放在池前 40 格专用段（ring 标记）；
   * 环平面为 XZ（水平冲击波，地面/空爆通用）
   */
  private emitShockwave(position: Vector3, kind: ExplosionKind): void {
    // 在环专用段中找空闲格（前 40 格）
    for (let i = 0; i < 40; i++) {
      const p = this.particles[i]!;
      if (p.active || !p.ring) {
        continue;
      }
      const s = kind === 'large' ? 1.6 : 1;
      p.mesh.position.copy(position);
      p.mesh.rotation.set(-Math.PI / 2, 0, 0); // 环平躺 XZ 平面
      p.mesh.visible = true;
      p.material.color.copy(CombatEffects.SHOCK_COLOR);
      p.material.opacity = 0.85;
      p.material.blending = AdditiveBlending;
      p.mesh.scale.setScalar(2 * s);
      p.velocityX = 0;
      p.velocityY = 0;
      p.velocityZ = 0;
      p.life = 0.45;
      p.maxLife = 0.45;
      p.startScale = 2 * s;
      p.endScale = 52 * s;
      p.startOpacity = 0.85;
      p.endOpacity = 0;
      p.drag = 0;
      p.gravity = 0;
      p.delay = 0.03;
      p.active = true;
      return;
    }
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
   * @param gravity 重力加速度（m/s²，正=下坠；负=上浮烟柱）
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
    const p = this.nextSphereParticle();
    this.initParticle(p, position, color, startScale, endScale, maxLife, startOpacity, endOpacity, drag, gravity, 0, vx, vy, vz);
  }

  /**
   * 释放延迟粒子（私有：二次爆碎片用）
   *
   * 功能：与 emitParticle 相同但带出生延迟——延迟期间粒子不可见
   * 且不运动，倒计时归零瞬间激活（模拟殉爆时序差）
   * @param position 出生位置
   * @param color 粒子颜色
   * @param startScale 初始缩放（米）
   * @param endScale 结束缩放（米）
   * @param maxLife 寿命（秒，不含延迟）
   * @param startOpacity 初始不透明度
   * @param endOpacity 结束不透明度
   * @param drag 速度阻尼系数（1/s）
   * @param gravity 重力加速度（m/s²）
   * @param delay 出生延迟（秒）
   * @param vx 初速度 X 分量（m/s）
   * @param vy 初速度 Y 分量（m/s）
   * @param vz 初速度 Z 分量（m/s）
   * @returns void
   * 异常：无
   */
  private emitDelayedParticle(
    position: Vector3,
    color: Color,
    startScale: number,
    endScale: number,
    maxLife: number,
    startOpacity: number,
    endOpacity: number,
    drag: number,
    gravity: number,
    delay: number,
    vx: number = 0,
    vy: number = 0,
    vz: number = 0,
  ): void {
    const p = this.nextSphereParticle();
    this.initParticle(p, position, color, startScale, endScale, maxLife, startOpacity, endOpacity, drag, gravity, delay, vx, vy, vz);
    p.mesh.visible = false; // 延迟期间隐藏
  }

  /**
   * 取下一格球体粒子（跳过环专用段，私有）
   *
   * 功能：从池的球体段（第 40 格起）环形取粒子
   * @returns 粒子池元素
   * 异常：无
   * 注意事项：池满时覆盖游标处粒子（环形复用）
   */
  private nextSphereParticle(): EffectParticle {
    // 游标跳过环专用段（0..39）
    if (this.cursor < 40) {
      this.cursor = 40;
    }
    const p = this.particles[this.cursor]!;
    this.cursor = (this.cursor + 1 - 40) % (this.capacity - 40) + 40;
    return p;
  }

  /**
   * 写入粒子初值并激活（私有核心）
   *
   * 功能：将粒子池元素重置为指定初值（位置/颜色/缩放/寿命/速度/
   * 延迟）并激活；混合模式按颜色区分（烟=普通混合保持灰度感，
   * 火球/火花/冲击波=叠加混合提亮）
   * @param p 目标粒子
   * @param position 出生位置
   * @param color 粒子颜色
   * @param startScale 初始缩放（米）
   * @param endScale 结束缩放（米）
   * @param maxLife 寿命（秒）
   * @param startOpacity 初始不透明度
   * @param endOpacity 结束不透明度
   * @param drag 速度阻尼系数（1/s）
   * @param gravity 重力加速度（m/s²）
   * @param delay 出生延迟（秒）
   * @param vx 初速度 X 分量（m/s）
   * @param vy 初速度 Y 分量（m/s）
   * @param vz 初速度 Z 分量（m/s）
   * @returns void
   * 异常：无
   */
  private initParticle(
    p: EffectParticle,
    position: Vector3,
    color: Color,
    startScale: number,
    endScale: number,
    maxLife: number,
    startOpacity: number,
    endOpacity: number,
    drag: number,
    gravity: number,
    delay: number,
    vx: number,
    vy: number,
    vz: number,
  ): void {
    p.mesh.position.copy(position);
    p.mesh.rotation.set(0, 0, 0);
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
    p.delay = delay;
    p.active = true;
    p.material.blending =
      color === CombatEffects.SMOKE_COLOR || color === CombatEffects.DARK_SMOKE_COLOR
        ? NormalBlending
        : AdditiveBlending;
  }

  /**
   * 推进全部粒子（每渲染帧）
   *
   * 功能：按帧间隔积分粒子——延迟倒计时（延迟期间跳过运动与渲染）→
   * 速度阻尼 + 重力 + 位置步进 + 缩放/不透明度按寿命比例插值；
   * 寿命耗尽隐藏归池
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
      // 延迟倒计时：延迟期间不可见且不运动
      if (p.delay > 0) {
        p.delay -= dtc;
        if (p.delay > 0) {
          continue;
        }
        p.mesh.visible = true; // 延迟归零：显现
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
  /** 重力（m/s²；负值=上浮） */
  gravity: number;
  /** 出生延迟（秒；>0 时延迟期间不可见不运动） */
  delay: number;
  /** 是否冲击波环粒子（专用几何段标记） */
  ring: boolean;
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
