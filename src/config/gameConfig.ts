/**
 * 全局游戏配置（数据驱动）
 *
 * 功能：集中管理主循环、渲染器、相机、光照、天空、地形环境、
 * 街机飞行模型、键盘输入、机炮与练习靶标等全部可调参数；
 * 后续战机/导弹/任务等配置表也将统一放在本目录（src/config）下。
 * 注意事项：本层只存放纯数据与常量，严禁包含任何逻辑代码。
 */

/** 主循环配置 */
export interface LoopConfig {
  /** 固定模拟步长（秒），模拟以该步长确定性推进（60Hz） */
  readonly fixedTimestep: number;
  /** 单帧可累计的最大时间（秒），钳制后台标签页切回时的巨大帧间隔 */
  readonly maxFrameTime: number;
  /** 单帧允许执行的最大固定步数，超过则丢弃剩余累积时间（防死亡螺旋） */
  readonly maxFixedStepsPerFrame: number;
}

/** 渲染器配置 */
export interface RendererConfig {
  /** 是否开启抗锯齿 */
  readonly antialias: boolean;
  /** 设备像素比上限（避免高分屏过度渲染） */
  readonly maxPixelRatio: number;
}

/** 追尾跟随相机配置 */
export interface ChaseCameraConfig {
  /** 机尾后方跟随距离（米，沿机体 +Z 后方） */
  readonly distance: number;
  /** 机身上方抬升高度（米） */
  readonly height: number;
  /** 前向注视提前量（米，沿机头方向） */
  readonly lookAhead: number;
  /** 位置跟随阻尼速率（越大跟得越紧，1/s） */
  readonly positionLag: number;
  /** FOV 平滑速率（1/s） */
  readonly fovLag: number;
  /** 速度感 FOV 最大增量（度） */
  readonly fovBoost: number;
  /** 相机 up 向机体 up 的混合系数（0=始终水平，1=完全跟随滚转） */
  readonly rollFollow: number;
  /** 鼠标教练视线平行过渡速率（1/s，迭代12：教练开/关时相机注视在
   *  原前向提前量与机头平行视线间的混合过渡快慢，避免切换跳镜） */
  readonly noseAlignLag: number;
  /** 相机离地最低净空（米） */
  readonly minGroundClearance: number;
  /** 开始触发镜头抖动的 G 值阈值 */
  readonly shakeGThreshold: number;
  /** 抖动最大幅度（米） */
  readonly shakeAmount: number;
}

/** 相机配置 */
export interface CameraConfig {
  /** 基础垂直视场角（度） */
  readonly fov: number;
  /** 近裁剪面距离（米） */
  readonly near: number;
  /** 远裁剪面距离（米），需覆盖天空穹与远地形 */
  readonly far: number;
  /** 追尾跟随相机参数 */
  readonly chase: ChaseCameraConfig;
}

/** 场景配置 */
export interface SceneConfig {
  /** 场景背景色（天空穹失效时的兜底背景） */
  readonly background: number;
}

/** 基础光照配置 */
export interface LightingConfig {
  /** 平行光（日光）强度 */
  readonly sunIntensity: number;
  /** 平行光位置方向（从该点指向原点，米） */
  readonly sunDirection: readonly [number, number, number];
  /** 半球光天空色 */
  readonly hemiSkyColor: number;
  /** 半球光地面反照色 */
  readonly hemiGroundColor: number;
  /** 半球光强度 */
  readonly hemiIntensity: number;
}

/** 天空与雾效配置 */
export interface SkyConfig {
  /** 天顶颜色 */
  readonly zenithColor: number;
  /** 地平线颜色 */
  readonly horizonColor: number;
  /** 天空穹半径（米），需小于相机远裁剪面 */
  readonly domeRadius: number;
  /** 雾色（应与地平线色一致以获得无缝远景融合） */
  readonly fogColor: number;
  /** 雾起始距离（米） */
  readonly fogNear: number;
  /** 雾结束距离（米） */
  readonly fogFar: number;
}

/** 地形环境配置（Task 2.2） */
export interface EnvironmentConfig {
  /** 地面平面边长（米） */
  readonly groundSize: number;
  /** 地面基色 */
  readonly groundBaseColor: number;
  /** 地面色块调色板（草地/耕地/沙地等） */
  readonly groundPatchColors: readonly number[];
  /** 色块数量 */
  readonly groundPatchCount: number;
  /** 纹理生成随机种子（保证地板块分布确定性） */
  readonly groundSeed: number;
  /** 水面色 */
  readonly waterColor: number;
  /** 水面区域中心（UV 坐标 0..1） */
  readonly waterCenter: readonly [number, number];
  /** 水面区域半径（UV 坐标 0..1，椭圆两轴） */
  readonly waterRadius: readonly [number, number];
  /** 跑道宽度（米） */
  readonly runwayWidth: number;
  /** 跑道长度（米，沿世界 Z 轴居中于原点） */
  readonly runwayLength: number;
  /** 战场边界半径（米） */
  readonly boundaryRadius: number;
  /** 边界提示立柱数量 */
  readonly boundaryPillarCount: number;
  /** 边界立柱高度（米） */
  readonly boundaryPillarHeight: number;
  /** 边界立柱半径（米） */
  readonly boundaryPillarRadius: number;
  /** 边界立柱发光色 */
  readonly boundaryPillarColor: number;
  /** 边界立柱不透明度 */
  readonly boundaryPillarOpacity: number;
}

/** 街机飞行模型配置（Task 3.2 / 3.3） */
export interface FlightConfig {
  /** 最大俯仰角速率（rad/s，杆量满输入） */
  readonly pitchRateMax: number;
  /** 最大滚转角速率（rad/s） */
  readonly rollRateMax: number;
  /** 最大偏航角速率（rad/s） */
  readonly yawRateMax: number;
  /** 失速速度（m/s，低于该速度进入失速） */
  readonly stallSpeed: number;
  /** 最大平飞速度（m/s） */
  readonly maxSpeed: number;
  /** 最佳机动速度 corner speed（m/s，该速度下操纵权限最佳 1.0；
   *  低于则线性衰减至失速速度处的 0.35，高于则缓降至极速处的 0.75） */
  readonly bestManeuverSpeed: number;
  /** 起飞离地速度（m/s，超过后拉杆可抬前轮/离地） */
  readonly takeoffSpeed: number;
  /** 满油门加速度（m/s²） */
  readonly thrustAccel: number;
  /** 气动阻力系数（dragAccel = k·v²，与推力平衡决定极速） */
  readonly dragCoefficient: number;
  /** 地面滑跑滚动阻力（m/s²） */
  readonly rollingResistance: number;
  /** 重力加速度（m/s²） */
  readonly gravity: number;
  /** 正过载限制（G，限制拉杆可用俯仰速率） */
  readonly gLimitPositive: number;
  /** 负过载限制（G，限制推杆可用俯仰速率） */
  readonly gLimitNegative: number;
  /** 输入平滑响应速率（1/s，键盘二元输入的柔和化——回中/减小杆量方向） */
  readonly inputResponseRate: number;
  /** 杆量建立速率（1/s，加大杆量方向更慢，给玩家精细瞄准过渡） */
  readonly inputAttackRate: number;
  /** 油门变化速率（1/s） */
  readonly throttleRate: number;
  /** 失速时机头下压速率（rad/s） */
  readonly stallPitchDropRate: number;
  /** 失速时最大下沉附加速度（m/s） */
  readonly stallSinkRate: number;
  /** 失速时最低操纵权限系数（0..1） */
  readonly controlAuthorityFloor: number;
  /** G 限动器放宽系数（0..1，街机软限制：0=物理硬钳制，1=完全不看 G 限） */
  readonly gLimiterRelax: number;
  /** 地面滑跑时机身中心离地高度（米） */
  readonly gearHeight: number;
  /** 地面滑跑允许的最大抬头角（rad） */
  readonly groundMaxPitch: number;
  /** 离地所需最小抬头角（rad） */
  readonly liftoffPitch: number;
  /** 坠地判定高度余量（米，机身中心低于 gearHeight-该值 即坠毁） */
  readonly crashMargin: number;
}

/** 键盘输入配置（Task 4.1） */
export interface InputConfig {
  /** 俯仰灵敏度乘数 */
  readonly pitchSensitivity: number;
  /** 滚转灵敏度乘数 */
  readonly rollSensitivity: number;
  /** 偏航灵敏度乘数 */
  readonly yawSensitivity: number;
  /** 键位映射（KeyboardEvent.code；轴键位为数组，任一按下即生效） */
  readonly keys: {
    /** 拉杆抬头 */
    readonly pitchPull: string;
    /** 推杆低头 */
    readonly pitchPush: string;
    /** 左滚转（小键盘 4；NumLock 开/关两种 code 均注册） */
    readonly rollLeft: readonly string[];
    /** 右滚转（小键盘 6；NumLock 开/关两种 code 均注册） */
    readonly rollRight: readonly string[];
    /** 左偏航（踩舵：A 与方向键 ←） */
    readonly yawLeft: readonly string[];
    /** 右偏航（踩舵：D 与方向键 →） */
    readonly yawRight: readonly string[];
    /** 油门增大 */
    readonly throttleUp: string;
    /** 油门减小 */
    readonly throttleDown: string;
    /** 发射当前选中武器（空格：机炮持续/导弹与特殊单发） */
    readonly fire: readonly string[];
    /** 循环切换武器类型（R：gun→missile→special，边沿触发） */
    readonly cycleWeapon: string;
    /** 切换锁定目标（X：锥内候选循环，边沿触发） */
    readonly switchTarget: string;
    /** 干扰弹释放（边沿触发） */
    readonly flare: string;
    /** 僚机指令循环（边沿触发：进攻→掩护→集合） */
    readonly wingmanCommand: string;
    /** 坠毁后重置到跑道（Backspace） */
    readonly reset: string;
  };
  /** 鼠标教练瞄准（迭代12：战雷式虚拟教练，M 键开关） */
  readonly mouse: MouseAimConfig;
}

/** 鼠标教练瞄准配置（迭代12：战雷式虚拟教练） */
export interface MouseAimConfig {
  /** 首次进入是否默认开启鼠标教练（玩家可用开关键随时切换并持久化） */
  readonly enabledByDefault: boolean;
  /** 鼠标教练开关键（KeyboardEvent.code） */
  readonly toggleKey: string;
  /** 瞄准死区（rad）：机头与瞄准方向夹角小于该值时教练松杆（防末端抖动） */
  readonly aimDeadzoneRad: number;
  /** 拉杆增益（杆量/弧度误差）：机体系仰角误差 → 俯仰杆量 */
  readonly pitchGain: number;
  /** 转弯保持增益（杆量/弧度）：压坡且有方位误差时的持续拉杆分量
   *  （坡度×方位误差的乘积项——防"光压坡不拉杆"的死锁平衡点，
   *  方位误差闭合后该项自动消失） */
  readonly turnSustainGain: number;
  /** 滚转增益（杆量/弧度坡度差）：目标坡度-当前坡度 → 滚转杆量 */
  readonly rollGain: number;
  /** 教练自动转弯允许的最大目标坡度（rad） */
  readonly maxBankRad: number;
  /** 下视坡度延伸系数：目标低于机头时最大坡度按仰角差延伸
   *  （滚过 90° 侧立——拉杆产生向下转向分量，避免仰角大幅过冲后
   *  再靠受限推杆慢慢修回；总坡度钳制在 2.4 rad ≈ 137°） */
  readonly downBankExtension: number;
  /** 推杆杆量下限（0..1，负值=允许推杆；推杆受负 G 限约束故幅度收敛） */
  readonly pushStickLimit: number;
  /** 微舵启用阈值（rad）：世界系方位误差小于该值时叠加方向舵做末端修正 */
  readonly rudderThresholdRad: number;
  /** 微舵增益（杆量/弧度机体系方位误差；闭环收敛速率 ≈ yawRateMax×
   *  该增益×微舵上限，决定最后几度的收尾快慢） */
  readonly rudderGain: number;
  /** 微舵基础杆量上限（0..1，设置页可再缩放） */
  readonly rudderAuthority: number;
}

/** 机炮配置（Task 6.1） */
export interface GunConfig {
  /** 射速（发/秒） */
  readonly fireRate: number;
  /** 弹药基数 */
  readonly ammo: number;
  /** 炮口初速（m/s，叠加载机速度） */
  readonly muzzleSpeed: number;
  /** 单发伤害 */
  readonly damage: number;
  /** 散布角（rad） */
  readonly spreadRad: number;
  /** 曳光弹存活时间（秒） */
  readonly tracerLife: number;
  /** 弹道重力缩放系数（1=真实重力） */
  readonly tracerGravityScale: number;
  /** 炮口沿机头前向偏移（米） */
  readonly muzzleOffset: number;
}

/** 练习靶标配置（Task 6.2） */
export interface PracticeTargetsConfig {
  /** 单个靶标生命值 */
  readonly hp: number;
  /** 靶标命中判定半径（米，球体检测） */
  readonly hitRadius: number;
  /** 靶标生成位置列表 [x, y, z]（世界坐标，米） */
  readonly positions: readonly (readonly [number, number, number])[];
}

/** 导弹系统配置（Task 7） */
export interface MissileConfig {
  /** 锁定锥半角（度）：目标偏离机头超过该角度不在锥内 */
  readonly lockConeDeg: number;
  /** 最大锁定距离（米） */
  readonly lockRange: number;
  /** 完成锁定所需持续保持时间（秒） */
  readonly lockTime: number;
  /** 导弹弹药基数 */
  readonly ammo: number;
  /** 发射冷却（秒） */
  readonly cooldown: number;
  /** 出膛初速（m/s，沿机头方向） */
  readonly launchSpeed: number;
  /** 最大飞行速度（m/s） */
  readonly maxSpeed: number;
  /** 发动机加速度（m/s²） */
  readonly accel: number;
  /** 最大转向角速率（rad/s，受限追踪能力） */
  readonly turnRate: number;
  /** 近炸引信距离（米，对空中目标） */
  readonly proximityFuse: number;
  /** 对干扰弹的近炸判定距离（米，诱骗成功判定） */
  readonly flareFuse: number;
  /** 单发伤害 */
  readonly damage: number;
  /** 最大飞行时间（秒，超时自毁） */
  readonly life: number;
}

/** 干扰弹系统配置（Task 8） */
export interface FlareConfig {
  /** 干扰弹携带数量 */
  readonly count: number;
  /** 释放冷却（秒） */
  readonly cooldown: number;
  /** 干扰弹存活时间（秒） */
  readonly life: number;
  /** 释放时向后弹射速度（m/s） */
  readonly ejectBackSpeed: number;
  /** 释放时向上弹射速度（m/s） */
  readonly ejectUpSpeed: number;
  /** 下坠重力缩放系数 */
  readonly gravityScale: number;
  /** 诱骗判定范围（米）：来袭导弹距目标进入该范围才检查诱偏 */
  readonly deceptionRange: number;
  /** 单次诱偏成功概率 0..1 */
  readonly deceptionProbability: number;
}

/** 敌机 AI 配置（Task 9） */
export interface EnemyConfig {
  /** 敌机生命值 */
  readonly hp: number;
  /** 敌机命中判定半径（米） */
  readonly hitRadius: number;
  /** 敌机初始巡航速度（m/s） */
  readonly initialSpeed: number;
  /** 敌机导弹数量 */
  readonly missileAmmo: number;
  /** 敌机导弹发射冷却（秒） */
  readonly missileCooldown: number;
  /** 敌机机炮弹药（大数近似无限） */
  readonly gunAmmo: number;
  /** 进入攻击判定的最大距离（米） */
  readonly attackRange: number;
  /** 距玩家过近时脱离攻击的距离（米） */
  readonly breakOffRange: number;
  /** 机炮开火锥半角（度） */
  readonly gunConeDeg: number;
  /** 机炮开火最大距离（米） */
  readonly gunRange: number;
  /** 导弹发射锥半角（度） */
  readonly missileConeDeg: number;
  /** 导弹发射最小距离（米，避免近距离自伤） */
  readonly missileMinRange: number;
  /** 导弹发射最大距离（米） */
  readonly missileMaxRange: number;
  /** 规避机动持续时间（秒） */
  readonly evadeDuration: number;
  /** 追击占位距离（米，保持在玩家尾后该距离） */
  readonly chaseStandoff: number;
  /** 低空拉起保护高度（米，低于该高度满杆拉起） */
  readonly minAltitude: number;
  /** 敌机生成位置列表 [x, y, z]（世界坐标，米；距玩家足够远以留出起飞窗口） */
  readonly spawnPositions: readonly (readonly [number, number, number])[];
  /** 敌机机型名池（生成时轮询分配，HUD 锁定框显示） */
  readonly typeNames: readonly string[];
  /** 轰炸机机型名（HUD 锁定框显示） */
  readonly bomberTypeName: string;
}

/** 玩家生存配置（Task 9：可被敌武器击伤） */
export interface PlayerConfig {
  /** 玩家生命值 */
  readonly hp: number;
  /** 玩家命中判定半径（米） */
  readonly hitRadius: number;
}

/** 雷达配置（HUD 雷达显示范围） */
export interface RadarConfig {
  /** 雷达探测半径（米，超出目标钉在边缘） */
  readonly range: number;
}

/** 武器装填基准配置（敌机/僚机用；玩家按机型配置表差异化） */
export interface WeaponReloadConfig {
  /** 机炮装填时长（秒，弹药打空后整弹匣回满） */
  readonly gun: number;
  /** 导弹装填时长（秒） */
  readonly missile: number;
  /** 干扰弹装填时长（秒） */
  readonly flare: number;
}

/** 雷暴天气配置（迭代11：Task 38） */
export interface WeatherConfig {
  /** 是否开启雷暴天气 */
  readonly enabled: boolean;
  /** 雨粒子数量（相机跟随盒内线段） */
  readonly rainCount: number;
  /** 雨跟随盒边长（米，相机为中心） */
  readonly rainBoxSize: number;
  /** 雨下落速度（m/s） */
  readonly rainFallSpeed: number;
  /** 雨线段长度（米） */
  readonly rainStreakLength: number;
  /** 闪电最小间隔（秒） */
  readonly lightningMinInterval: number;
  /** 闪电最大间隔（秒） */
  readonly lightningMaxInterval: number;
  /** 闪电时日光脉冲强度 */
  readonly lightningIntensity: number;
  /** 闪电时天空增亮强度 */
  readonly lightningSkyBoost: number;
  /** 闪电视觉衰减时长（秒） */
  readonly lightningDecay: number;
  /** 雷声最远延迟（秒，随闪电方位随机 0.3~该值） */
  readonly thunderMaxDelay: number;
  /** 雷声音量（0..1） */
  readonly thunderVolume: number;
  /** 雨线整体不透明度（0..1） */
  readonly rainOpacity: number;
  /** 雷雨雾 near 系数（构造时基值快照 × 该系数，浓雾更近） */
  readonly fogNearScale: number;
  /** 雷雨雾 far 系数（构造时基值快照 × 该系数，浓雾视野更紧） */
  readonly fogFarScale: number;
  /** 雷雨日光压暗系数 */
  readonly sunDim: number;
  /** 雷雨半球光压暗系数 */
  readonly hemiDim: number;
}

/** 僚机配置（Task 16） */
export interface WingmanConfig {
  /** 僚机数量 */
  readonly count: number;
  /** 僚机生命值 */
  readonly hp: number;
  /** 僚机命中判定半径（米） */
  readonly hitRadius: number;
  /** 僚机导弹数量 */
  readonly missileAmmo: number;
  /** 僚机导弹发射冷却（秒） */
  readonly missileCooldown: number;
  /** 僚机机炮弹药（大数近似无限） */
  readonly gunAmmo: number;
  /** 编队跟随：侧向偏移（米，1 号僚机 -x / 2 号僚机 +x） */
  readonly formationSideOffset: number;
  /** 编队跟随：后向偏移（米，玩家机尾方向） */
  readonly formationBackOffset: number;
  /** 编队跟随：下方偏移（米） */
  readonly formationDownOffset: number;
  /** 编队位置到达判定距离（米，进入即松杆巡航） */
  readonly formationArriveRadius: number;
  /** 进攻/掩护模式接敌距离（米，超出则追向目标） */
  readonly engageRange: number;
  /** 机炮开火锥半角（度） */
  readonly gunConeDeg: number;
  /** 机炮开火最大距离（米） */
  readonly gunRange: number;
  /** 导弹发射最小距离（米） */
  readonly missileMinRange: number;
  /** 导弹发射最大距离（米） */
  readonly missileMaxRange: number;
  /** 导弹发射锥半角（度） */
  readonly missileConeDeg: number;
  /** 低空拉起保护高度（米） */
  readonly minAltitude: number;
  /** 规避机动持续时间（秒） */
  readonly evadeDuration: number;
  /** 掩护模式：锁定威胁玩家的敌机的最大玩家距离（米） */
  readonly coverThreatRange: number;
}

/** 敌机狗斗优化配置（Task 17） */
export interface DogfightConfig {
  /** 能量机动：攻击模式油门（低于追击，保留能量） */
  readonly attackThrottle: number;
  /** 能量机动：追击模式油门（全力） */
  readonly chaseThrottle: number;
  /** 近距格斗判定距离（米，进入后启用格斗机动） */
  readonly mergeRange: number;
  /** 侧滑规避：横向机动随机换向间隔（秒） */
  readonly weaveInterval: number;
  /** 侧滑规避：横向杆量幅度 */
  readonly weaveAmount: number;
  /** 过顶脱离：近距离交错后触发脱离的距离（米） */
  readonly overshootRange: number;
  /** 脱离机动持续时间（秒） */
  readonly breakAwayDuration: number;
  /** 被咬尾（玩家在敌机正后方锥内且近距）触发的紧急规避权重 */
  readonly tailThreatCos: number;
  /** 攻击模式对僚机目标切换判定距离差（米，更近者优先） */
  readonly targetSwitchMargin: number;
}

/** 游戏全局配置表（只读，数据驱动） */
export const gameConfig = {
  /** 主循环：固定 60Hz 模拟步长 + 插值渲染 */
  loop: {
    fixedTimestep: 1 / 60,
    maxFrameTime: 0.25,
    maxFixedStepsPerFrame: 5,
  } satisfies LoopConfig,
  /** 渲染器 */
  renderer: {
    antialias: true,
    maxPixelRatio: 2,
  } satisfies RendererConfig,
  /** 相机：基础参数 + 追尾跟随 */
  camera: {
    fov: 62,
    near: 0.1,
    far: 30000,
    chase: {
      distance: 30,
      height: 8,
      lookAhead: 70,
      positionLag: 5,
      fovLag: 2.5,
      fovBoost: 16,
      rollFollow: 0.35,
      noseAlignLag: 4,
      minGroundClearance: 3,
      shakeGThreshold: 3.5,
      shakeAmount: 0.7,
    } satisfies ChaseCameraConfig,
  } satisfies CameraConfig,
  /** 场景兜底背景 */
  scene: {
    background: 0x101418,
  } satisfies SceneConfig,
  /** 光照：日光 + 半球环境光 */
  lighting: {
    sunIntensity: 1.6,
    sunDirection: [4000, 6000, 3000],
    hemiSkyColor: 0xbfd7e8,
    hemiGroundColor: 0x46603f,
    hemiIntensity: 0.9,
  } satisfies LightingConfig,
  /** 天空穹与雾效 */
  sky: {
    zenithColor: 0x2e5c9a,
    horizonColor: 0xc3d9e8,
    domeRadius: 23000,
    fogColor: 0xc3d9e8,
    fogNear: 3500,
    fogFar: 15000,
  } satisfies SkyConfig,
  /** 地形环境：地面色块 / 跑道 / 战场边界 */
  environment: {
    groundSize: 20000,
    groundBaseColor: 0x47603f,
    groundPatchColors: [0x3c5535, 0x556b42, 0x6b7a4a, 0x8a8058, 0x405a3a],
    groundPatchCount: 110,
    groundSeed: 20260829,
    waterColor: 0x2f5a75,
    waterCenter: [0.78, 0.72],
    waterRadius: [0.3, 0.26],
    runwayWidth: 60,
    runwayLength: 1400,
    boundaryRadius: 9000,
    boundaryPillarCount: 36,
    boundaryPillarHeight: 600,
    boundaryPillarRadius: 22,
    boundaryPillarColor: 0xffb454,
    boundaryPillarOpacity: 0.55,
  } satisfies EnvironmentConfig,
  /** 街机飞行模型（迭代9：俯仰基准速率在迭代8 基础上再上调 50%，强化狗斗转向；
   *  迭代10：bestManeuverSpeed 最佳机动速度权限曲线） */
  flight: {
    pitchRateMax: 3.83,
    rollRateMax: 3.2,
    yawRateMax: 0.45,
    stallSpeed: 72,
    maxSpeed: 310,
    bestManeuverSpeed: 155,
    takeoffSpeed: 82,
    thrustAccel: 46,
    dragCoefficient: 0.00048,
    rollingResistance: 3,
    gravity: 9.81,
    gLimitPositive: 9,
    gLimitNegative: 3.5,
    inputResponseRate: 7,
    /** 杆量建立慢（0.33s 到满）：轻点轻拉精细瞄准，长按才满杆 */
    inputAttackRate: 3,
    throttleRate: 0.55,
    stallPitchDropRate: 0.55,
    stallSinkRate: 25,
    controlAuthorityFloor: 0.22,
    /** 街机 G 限容忍：允许实际 G 达到机型 G 限的 1.35 倍（0=严格物理钳制） */
    gLimiterRelax: 0.35,
    gearHeight: 2.4,
    groundMaxPitch: 0.21,
    liftoffPitch: 0.09,
    crashMargin: 0.5,
  } satisfies FlightConfig,
  /** 键盘输入（迭代11 重构：空格统一发射、R 换武器、X 切目标、Backspace 重置；←→ 滚转、A/D 踩舵） */
  input: {
    pitchSensitivity: 1,
    rollSensitivity: 1,
    yawSensitivity: 1,
    keys: {
      pitchPull: 'ArrowDown',
      pitchPush: 'ArrowUp',
      rollLeft: ['ArrowLeft'],
      rollRight: ['ArrowRight'],
      yawLeft: ['KeyA'],
      yawRight: ['KeyD'],
      throttleUp: 'KeyW',
      throttleDown: 'KeyS',
      fire: ['Space'],
      cycleWeapon: 'KeyR',
      switchTarget: 'KeyX',
      flare: 'KeyE',
      wingmanCommand: 'KeyC',
      reset: 'Backspace',
    },
    /** 鼠标教练瞄准（迭代12：光标=航向设定点，教练自动协调滚转+拉杆追踪；
     *  方向键按住时教练让位=手动接管，左键开火/滚轮换武器/右键切目标） */
    mouse: {
      enabledByDefault: true,
      toggleKey: 'KeyM',
      aimDeadzoneRad: 0.02,
      pitchGain: 2.6,
      turnSustainGain: 2.2,
      rollGain: 3.2,
      maxBankRad: 1.22,
      downBankExtension: 1.2,
      pushStickLimit: 0.55,
      rudderThresholdRad: 0.12,
      rudderGain: 6,
      rudderAuthority: 0.5,
    },
  } satisfies InputConfig,
  /** 机炮 */
  gun: {
    fireRate: 14,
    ammo: 600,
    muzzleSpeed: 880,
    damage: 10,
    spreadRad: 0.008,
    tracerLife: 1.8,
    tracerGravityScale: 0.5,
    muzzleOffset: 9,
  } satisfies GunConfig,
  /** 空中静态练习靶标布点 */
  practiceTargets: {
    hp: 40,
    hitRadius: 14,
    positions: [
      [0, 500, -1500],
      [-600, 350, -2200],
      [700, 450, -2600],
      [-1200, 700, -3200],
      [900, 900, -3600],
      [0, 1100, -4200],
      [-1800, 550, -4800],
      [1500, 1200, -5200],
    ],
  } satisfies PracticeTargetsConfig,
  /** 导弹系统 */
  missile: {
    lockConeDeg: 16,
    lockRange: 3600,
    lockTime: 1.1,
    ammo: 12,
    cooldown: 1.3,
    launchSpeed: 170,
    maxSpeed: 520,
    accel: 240,
    turnRate: 2.1,
    proximityFuse: 18,
    flareFuse: 9,
    damage: 90,
    life: 9,
  } satisfies MissileConfig,
  /** 干扰弹系统（迭代11：冷却大幅降低允许连按规避） */
  flare: {
    count: 6,
    cooldown: 0.15,
    life: 3.2,
    ejectBackSpeed: 50,
    ejectUpSpeed: 15,
    gravityScale: 0.55,
    deceptionRange: 320,
    deceptionProbability: 0.65,
  } satisfies FlareConfig,
  /** 敌机 AI */
  enemy: {
    hp: 60,
    hitRadius: 15,
    initialSpeed: 150,
    missileAmmo: 2,
    missileCooldown: 7,
    gunAmmo: 9999,
    attackRange: 1700,
    breakOffRange: 300,
    gunConeDeg: 8,
    gunRange: 1000,
    missileConeDeg: 15,
    missileMinRange: 600,
    missileMaxRange: 3000,
    evadeDuration: 3.0,
    chaseStandoff: 340,
    minAltitude: 300,
    spawnPositions: [
      [-1200, 800, -6200],
      [1200, 850, -6600],
      [0, 1100, -8000],
    ],
    typeNames: ['Su-35S', 'Rafale-M', 'MiG-29K', 'F/A-18E', 'J-16', 'Typhoon-FGR'],
    bomberTypeName: 'Tu-95MS',
  } satisfies EnemyConfig,
  /** 玩家生存 */
  player: {
    hp: 100,
    hitRadius: 12,
  } satisfies PlayerConfig,
  /** 雷达 */
  radar: {
    range: 4000,
  } satisfies RadarConfig,
  /** 武器装填基准（敌机/僚机；玩家按机型差异化，见 fighterConfig） */
  weaponReload: {
    gun: 14,
    missile: 24,
    flare: 12,
  } satisfies WeaponReloadConfig,
  /** 雷暴天气（迭代11：暴雨/闪电/雷声/暗色雷雨氛围） */
  weather: {
    enabled: true,
    rainCount: 3200,
    rainBoxSize: 90,
    rainFallSpeed: 55,
    rainStreakLength: 3.2,
    rainOpacity: 0.42,
    lightningMinInterval: 4,
    lightningMaxInterval: 12,
    lightningIntensity: 3.2,
    lightningSkyBoost: 1.6,
    lightningDecay: 0.3,
    thunderMaxDelay: 2.5,
    thunderVolume: 0.45,
    /** 雷雨雾系数（浓雾：near 更近、far 收得更紧） */
    fogNearScale: 0.32,
    fogFarScale: 0.42,
    /** 雷雨日光/半球光压暗系数 */
    sunDim: 0.3,
    hemiDim: 0.5,
  } satisfies WeatherConfig,
  /** 僚机系统 */
  wingman: {
    count: 2,
    hp: 70,
    hitRadius: 14,
    missileAmmo: 3,
    missileCooldown: 9,
    gunAmmo: 9999,
    formationSideOffset: 55,
    formationBackOffset: 42,
    formationDownOffset: 12,
    formationArriveRadius: 45,
    engageRange: 3600,
    gunConeDeg: 9,
    gunRange: 1050,
    missileMinRange: 700,
    missileMaxRange: 3200,
    missileConeDeg: 16,
    minAltitude: 260,
    evadeDuration: 2.8,
    coverThreatRange: 1800,
  } satisfies WingmanConfig,
  /** 敌机狗斗优化 */
  dogfight: {
    attackThrottle: 0.72,
    chaseThrottle: 0.95,
    mergeRange: 900,
    weaveInterval: 1.6,
    weaveAmount: 0.75,
    overshootRange: 260,
    breakAwayDuration: 2.4,
    tailThreatCos: 0.88,
    targetSwitchMargin: 250,
  } satisfies DogfightConfig,
} as const;
