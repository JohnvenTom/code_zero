import {
  AdditiveBlending,
  AmbientLight,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  LineSegments,
  LineBasicMaterial,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { gameConfig } from '../../config';

/** 天气配置的模块级引用 */
const weatherCfg = gameConfig.weather;

/**
 * 雷暴天气控制器（暴雨 / 闪电 / 雷声 / 暗色雷雨氛围）
 *
 * 功能：默认开启雷雨——
 * 1) 暴雨：相机跟随盒内 ~1500 条竖直微斜线段，下落循环回绕；
 * 2) 闪电：随机间隔 4-12s 触发——远处随机方位的临时强光脉冲
 *    （专用 DirectionalLight + 天空穹顶颜色瞬亮 + 0.3s 指数衰减）；
 * 3) 雷声：WebAudio 合成（低频噪声 buffer + lowpass + 指数衰减
 *    2-3s，音量随闪电方位距离），AudioContext 在首次用户交互时
 *    由调用方 resume；
 * 4) 雷雨氛围：日光强度×0.4 冷灰蓝、雾更浓偏蓝灰、天空穹顶
 *    暗灰蓝（与 AtmosphereController 的昼夜插值叠加——本控制器
 *    在 Atmosphere 之后 update 以叠加暗色修正）。
 * 边界约定：光照/雾/天空对象由 createScene 创建后注入；
 * 屏幕白闪由 HUD 层的 weather-flash 元素完成（本控制器只输出
 * flashPulse 供 HUD 查询衰减）。
 */
export class WeatherController {
  /** 雨粒子组（加入场景） */
  readonly group = new Group();

  /** 雨线段渲染对象 */
  private readonly rain: LineSegments;
  /** 雨粒子 Y 坐标数组（池化，X/Z 在跟随盒内随机） */
  private readonly rainY: Float32Array;
  /** 闪电专用平行光（远处方位强脉冲） */
  private readonly lightningLight: DirectionalLight;
  /** 闪电当前强度（0..1，衰减中） */
  private lightningIntensityNow = 0;
  /** 下次闪电倒计时（秒） */
  private nextLightningTimer: number;
  /** 闪电天空增亮当前值（0..1） */
  private skyBoostNow = 0;
  /** 屏幕白闪当前强度（0..1，HUD 查询消费） */
  private flashPulseNow = 0;
  /** 天空穹顶原始颜色（雷雨暗色基底，叠加闪电增亮） */
  private readonly stormSkyBase = new Color(0x2e3942);
  /** 注入引用 */
  private readonly camera: PerspectiveCamera;
  private readonly sunLight: DirectionalLight;
  private readonly hemiLight: HemisphereLight;
  private readonly ambientLightRef: AmbientLight;
  private readonly fog: Fog;
  private readonly skyDome: Mesh;
  /** WebAudio 上下文（懒创建） */
  private audioCtx: AudioContext | null = null;
  /** 雾距基值快照（构造时捕获，修复每帧乘法累积衰减 bug） */
  private readonly fogNearBase: number;
  private readonly fogFarBase: number;
  /** 雷雨雾色（更暗的浓雾灰蓝） */
  private readonly stormFogColor = new Color(0x4d5a64);
  /** 复用向量：闪电方位 */
  private readonly _boltDir = new Vector3();

  /**
   * 构造天气控制器
   *
   * @param camera 主相机（雨跟随）
   * @param sunLight 日光（注入，雷雨压暗）
   * @param hemiLight 半球光（注入）
   * @param ambientLight 环境光（注入，闪电时脉冲）
   * @param fog 场景雾（注入，雷雨加浓）
   * @param skyDome 天空穹顶（注入，雷雨暗色 + 闪电瞬亮）
   * 异常：无
   * 注意事项：未开启（配置 enabled=false）时 update 无操作，
   * 雨与光不加入场景
   */
  constructor(
    camera: PerspectiveCamera,
    sunLight: DirectionalLight,
    hemiLight: HemisphereLight,
    ambientLight: AmbientLight,
    fog: Fog,
    skyDome: Mesh,
  ) {
    this.camera = camera;
    this.sunLight = sunLight;
    this.hemiLight = hemiLight;
    this.ambientLightRef = ambientLight;
    this.fog = fog;
    this.skyDome = skyDome;
    this.nextLightningTimer = this.randomLightningInterval();
    // 雾距基值快照：后续每帧以绝对值写入（基值×系数），
    // 避免乘法累积把 near/far 衰减到 0 导致全屏灰雾
    this.fogNearBase = fog.near;
    this.fogFarBase = fog.far;

    if (!weatherCfg.enabled) {
      this.rain = new LineSegments(new BufferGeometry(), new LineBasicMaterial());
      this.rainY = new Float32Array(0);
      this.lightningLight = new DirectionalLight(0xffffff, 0);
      return;
    }

    // ---- 暴雨线段（相机跟随盒内竖直短线） ----
    const count = weatherCfg.rainCount;
    const box = weatherCfg.rainBoxSize;
    const positions = new Float32Array(count * 6);
    this.rainY = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 2 - 1) * box * 0.5;
      const z = (Math.random() * 2 - 1) * box * 0.5;
      const y = Math.random() * box;
      this.rainY[i] = y;
      const len = weatherCfg.rainStreakLength;
      // 微倾斜：线段沿 (0.12, -1, 0.06) 方向（斜雨）
      positions[i * 6] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x + len * 0.12;
      positions[i * 6 + 4] = y + len;
      positions[i * 6 + 5] = z + len * 0.06;
    }
    const rainGeo = new BufferGeometry();
    rainGeo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const rainMat = new LineBasicMaterial({
      color: 0xaebfd0,
      transparent: true,
      opacity: weatherCfg.rainOpacity,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.rain = new LineSegments(rainGeo, rainMat);
    this.rain.frustumCulled = false;
    this.group.add(this.rain);

    // ---- 闪电专用光（默认强度 0，触发时脉冲） ----
    this.lightningLight = new DirectionalLight(0xeaf2ff, 0);
    this.lightningLight.position.set(3000, 4000, -6000);
    // target 必须加入场景图才会更新 matrixWorld（否则方向固定指向世界原点）
    this.group.add(this.lightningLight);
    this.group.add(this.lightningLight.target);
  }

  /**
   * 激活音频上下文（用户点击开始任务后调用）
   *
   * 功能：创建 AudioContext 并 resume（浏览器自动播放策略要求
   * 用户手势后才能出声）；重复调用安全
   * @returns void
   * 异常：WebAudio 不可用时静默降级（无雷声）
   */
  resumeAudio(): void {
    if (this.audioCtx === null) {
      try {
        this.audioCtx = new AudioContext();
      } catch {
        return; // WebAudio 不可用：静默降级
      }
    }
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
    }
  }

  /**
   * 每渲染帧推进天气（在 AtmosphereController.update 之后调用）
   *
   * 功能：1) 雨粒子跟随相机（组位置吸附相机，Y 独立下落回绕）；
   * 2) 闪电计时与衰减（触发时随机方位强脉冲 + 天空瞬亮 + 屏幕白闪
   *    + 延迟雷声合成）；3) 雷雨氛围恒定叠加（压暗日光/雾加浓/
   *    天空暗灰蓝——写在本控制器以覆盖 Atmosphere 的正午/黄昏插值）
   * @param dt 帧间隔（秒）
   * @returns void
   * 异常：无
   * 注意事项：dt 钳制到 0.1s；flashPulse() 供 HUD 消费屏幕白闪
   */
  update(dt: number): void {
    if (!weatherCfg.enabled) {
      return;
    }
    const dtc = Math.min(Math.max(dt, 0), 0.1);

    // ---- 1) 雨：跟随相机 + 下落回绕 ----
    this.group.position.set(this.camera.position.x, 0, this.camera.position.z);
    const box = weatherCfg.rainBoxSize;
    const positions = this.rain.geometry.getAttribute('position');
    for (let i = 0; i < this.rainY.length; i++) {
      const newY = this.rainY[i]! - weatherCfg.rainFallSpeed * dtc;
      this.rainY[i] = newY < 0 ? box : newY;
      positions.setY(i * 2, this.rainY[i]!);
      positions.setY(i * 2 + 1, this.rainY[i]! + weatherCfg.rainStreakLength);
    }
    positions.needsUpdate = true;

    // ---- 2) 闪电计时与触发 ----
    this.nextLightningTimer -= dtc;
    if (this.nextLightningTimer <= 0) {
      this.nextLightningTimer = this.randomLightningInterval();
      this.triggerLightning();
    }
    // 闪电衰减（指数）
    if (this.lightningIntensityNow > 0) {
      this.lightningIntensityNow = Math.max(0, this.lightningIntensityNow - dtc / weatherCfg.lightningDecay);
      this.skyBoostNow = this.lightningIntensityNow;
      this.flashPulseNow = this.lightningIntensityNow * 0.25;
    } else {
      this.flashPulseNow = Math.max(0, this.flashPulseNow - dtc * 2);
    }
    this.lightningLight.intensity = this.lightningIntensityNow * weatherCfg.lightningIntensity;

    // ---- 3) 雷雨氛围（恒定叠加，覆盖昼夜插值）+ 闪电环境光脉冲 ----
    // 注意：sun/hemi 的强度由 Atmosphere 每帧先写绝对值、这里乘一次
    // 系数得到雷雨压暗（不累积）；雾 near/far Atmosphere 不重置，
    // 必须以构造时快照的基值×系数写绝对值（否则每帧乘法会累积
    // 衰减到 0，全屏只剩灰雾色）；系数全部来自 gameConfig.weather
    this.sunLight.intensity *= weatherCfg.sunDim;
    this.hemiLight.intensity *= weatherCfg.hemiDim;
    // 闪电环境光脉冲：强度随衰减曲线叠加到基准 0.25
    this.ambientLightRef.intensity = 0.25 + this.lightningIntensityNow * 1.2;
    this.fog.color.copy(this.stormFogColor);
    this.fog.near = this.fogNearBase * weatherCfg.fogNearScale;
    this.fog.far = this.fogFarBase * weatherCfg.fogFarScale;

    // 天空穹顶：雷雨暗灰蓝基底 + 闪电瞬亮
    const domeMat = this.skyDome.material;
    if (domeMat instanceof MeshBasicMaterial) {
      // 基底乘暗色 + 闪电增亮（加法混合白）
      const boost = this.skyBoostNow * weatherCfg.lightningSkyBoost;
      domeMat.color.setRGB(
        Math.min(1, this.stormSkyBase.r * 0.55 + boost),
        Math.min(1, this.stormSkyBase.g * 0.55 + boost),
        Math.min(1, this.stormSkyBase.b * 0.55 + boost),
      );
    }
  }

  /**
   * 获取屏幕白闪当前强度（HUD 屏幕闪消费）
   *
   * @returns 0..1 的白闪强度（0=无闪）
   */
  get flashPulse(): number {
    return this.flashPulseNow;
  }

  /**
   * 触发一次闪电（私有）
   *
   * 功能：随机远处方位设置闪电光方向，强度置 1 开始衰减；
   * 随机延迟后合成雷声（音量随方位距离感）
   * @returns void
   * 异常：无
   */
  private triggerLightning(): void {
    // 随机方位（远处）
    const angle = Math.random() * Math.PI * 2;
    this._boltDir.set(Math.cos(angle), 0.5 + Math.random() * 0.4, Math.sin(angle)).normalize();
    this.lightningLight.position
      .copy(this._boltDir)
      .multiplyScalar(8000)
      .add(this.camera.position);
    this.lightningLight.target.position.copy(this.camera.position);
    this.lightningIntensityNow = 1;
    this.skyBoostNow = 1;
    this.flashPulseNow = 0.25;

    // 延迟雷声（WebAudio 合成）
    const delay = 0.3 + Math.random() * weatherCfg.thunderMaxDelay;
    const volume = weatherCfg.thunderVolume * (0.6 + Math.random() * 0.4);
    window.setTimeout(() => {
      this.synthThunder(volume);
    }, delay * 1000);
  }

  /**
   * 合成雷声（私有：WebAudio 低频噪声 + lowpass + 指数衰减）
   *
   * @param volume 音量 0..1
   * @returns void
   * 异常：AudioContext 不可用时静默返回
   * 注意事项：噪声 buffer 每次生成（约 2.5s）；lowpass 中心
   * 频率随包络下扫模拟远雷低沉感
   */
  private synthThunder(volume: number): void {
    if (this.audioCtx === null || this.audioCtx.state !== 'running') {
      return;
    }
    const ctx = this.audioCtx;
    const duration = 2.6;
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);

    // 低频噪声 buffer（中心能量在低频）
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    let lastVal = 0;
    for (let i = 0; i < length; i++) {
      // 布朗噪声（积分白噪声→能量集中低频）
      const white = Math.random() * 2 - 1;
      lastVal = (lastVal + 0.02 * white) / 1.02;
      data[i] = lastVal * 3.5;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // lowpass 滤波（中心频率包络下扫）
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + duration);

    // 音量包络（快攻慢衰的雷声感）
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  }

  /**
   * 随机闪电间隔（私有）
   *
   * @returns min~max 区间的随机秒数
   */
  private randomLightningInterval(): number {
    return (
      weatherCfg.lightningMinInterval +
      Math.random() * (weatherCfg.lightningMaxInterval - weatherCfg.lightningMinInterval)
    );
  }
}
