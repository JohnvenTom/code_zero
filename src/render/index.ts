import { Vector3 } from 'three';
import type { Fog } from 'three';
import type { SimulationWorld } from '../simulation';
import type { GameEvent } from '../simulation';
import { createCamera } from './app/createCamera';
import { createChaseCamera } from './app/chaseCamera';
import { createEnvironment } from './app/createEnvironment';
import { createRenderer, type RendererHooks } from './app/createRenderer';
import { createScene } from './app/createScene';
import { AtmosphereController, createClouds, MISSION_TOTAL_TIME } from './app/atmosphere';
import { WeatherController } from './app/weather';
import { RenderBridge } from './adapters/renderBridge';
import { CombatEffects } from './effects/combatEffects';
import { WingtipVortices, type AircraftFrame } from './effects/wingtipVortices';

/** createRenderApp 参数：画布容器 + 上下文事件钩子 */
export interface RenderAppOptions extends RendererHooks {
  /** WebGL canvas 挂载的容器元素（index.html 中的 #app） */
  container: HTMLElement;
}

/** 实体屏幕投影结果（HUD 屏幕空间元素定位用） */
export interface ScreenProjection {
  /** 屏幕横坐标（像素，左上为原点） */
  readonly x: number;
  /** 屏幕纵坐标（像素，左上为原点） */
  readonly y: number;
  /** 是否在相机前视锥内（false=在屏幕外或相机后方） */
  readonly onScreen: boolean;
  /** NDC 横坐标（-1..1，出屏目标方向计算用；相机后方时方向需取反） */
  readonly ndcX: number;
  /** NDC 纵坐标（-1..1，NDC y 向上；出屏方向计算用） */
  readonly ndcY: number;
  /** 是否在相机正后方（z>1，投影方向镜像，边缘箭头方向须取反） */
  readonly behind: boolean;
}

/** 渲染应用统一接口（由主循环每帧驱动） */
export interface RenderApp {
  /**
   * 渲染一帧：先同步实体插值状态，再驱动追尾相机，最后绘制场景
   * @param world 模拟世界
   * @param alpha 插值系数
   * @param aimDir 鼠标瞄准方向（世界坐标，光标反投影；null=教练关闭）——
   *  迭代12：追尾相机按 aimFollow 比例朝该方向平移注视（镜头跟鼠标）
   */
  render(world: SimulationWorld, alpha: number, aimDir?: Vector3 | null): void;
  /** 提交本帧模拟事件（渲染层消费为战斗特效：爆炸/火花等） */
  handleEvents(events: readonly GameEvent[]): void;
  /** 将实体当前渲染帧位置投影为屏幕坐标（HUD 锁定框/得分弹出定位用） */
  projectEntity(entityId: number): ScreenProjection | null;
  /** 将实体机头前向某距离处的点投影为屏幕坐标（鼠标教练弹着点准星用） */
  projectForwardPoint(entityId: number, distance: number): ScreenProjection | null;
  /** 屏幕像素坐标 → 世界坐标视线方向（鼠标教练瞄准反投影，写入 out 返回） */
  screenToWorldDirection(cursorX: number, cursorY: number, out: Vector3): Vector3;
  /** 激活天气音频上下文（用户手势后调用，雷声用） */
  resumeWeatherAudio(): void;
  /** 获取屏幕白闪当前强度（HUD 天气闪屏消费；0=无闪） */
  getWeatherFlash(): number;
  /** 处理窗口尺寸变化（更新相机宽高比与渲染器尺寸） */
  resize(): void;
  /** 释放全部渲染资源并移除 canvas */
  dispose(): void;
}

/** 模块级复用对象：投影计算向量 */
const _projectVec = new Vector3();
/** 模块级复用对象：反投影计算向量 */
const _unprojectVec = new Vector3();

/** 地面爆炸判定高度（米，事件位置低于该值视为地面爆炸） */
const GROUND_BLAST_ALTITUDE = 60;

/**
 * 创建渲染应用（渲染层装配入口）
 *
 * 功能：创建渲染器（含上下文丢失处理）、场景（天空/雾/光照）、
 * 静态环境（地面/跑道/边界）、云层、大气控制器（昼夜光照）、
 * 战斗特效系统、追尾相机与渲染桥，
 * 并组装为统一的 RenderApp 接口供主循环驱动
 * @param options 容器与上下文丢失/恢复钩子
 * @returns 渲染应用实例
 * @throws 浏览器不支持 WebGL 时向上抛出异常，由调用方兜底提示
 * 注意事项：render() 每帧调用一次，负责实体状态同步、导弹烟迹
 * 排放、大气推进、追尾相机位姿更新与场景绘制；
 * handleEvents() 由 main.ts 在事件消费后转发（HUD 与特效共享事件）
 */
export function createRenderApp(options: RenderAppOptions): RenderApp {
  const { renderer, canvas } = createRenderer(options.container, options);
  const { scene, sunLight, hemiLight, ambientLight, skyDome } = createScene();
  const camera = createCamera(window.innerWidth / window.innerHeight);
  const bridge = new RenderBridge();
  scene.add(bridge.group);

  const environment = createEnvironment();
  scene.add(environment.group);

  // 云层 + 大气控制器（昼夜光照氛围）
  const { group: cloudGroup, clouds } = createClouds();
  scene.add(cloudGroup);
  const atmosphere = new AtmosphereController(
    clouds,
    sunLight,
    hemiLight,
    scene.fog as Fog,
    skyDome,
  );

  // 雷暴天气控制器（暴雨/闪电/雷声/暗色氛围）
  const weather = new WeatherController(
    camera,
    sunLight,
    hemiLight,
    ambientLight,
    scene.fog as Fog,
    skyDome,
  );
  scene.add(weather.group);

  // 战斗特效系统（爆炸/火花/烟迹）+ 翼尖涡流
  const effects = new CombatEffects();
  scene.add(effects.group);
  const vortices = new WingtipVortices();
  scene.add(vortices.group);

  const chaseCamera = createChaseCamera(camera);
  let lastFrameMs = performance.now();

  /** 涡流帧数据复用数组（避免每帧分配） */
  const vortexFrames: AircraftFrame[] = [];

  /**
   * 将已就位的 _projectVec（相机投影后 NDC）组装为屏幕投影结果（私有）
   *
   * 功能：NDC → 屏幕像素换算 + 视锥内/后方判定，
   * projectEntity 与 projectForwardPoint 共用
   * @returns 屏幕投影结果
   */
  const buildProjection = (): ScreenProjection => {
    const behind = _projectVec.z > 1;
    return {
      x: (_projectVec.x * 0.5 + 0.5) * window.innerWidth,
      y: (-_projectVec.y * 0.5 + 0.5) * window.innerHeight,
      onScreen: !behind && Math.abs(_projectVec.x) <= 1 && Math.abs(_projectVec.y) <= 1,
      ndcX: _projectVec.x,
      ndcY: _projectVec.y,
      behind,
    };
  };

  return {
    /**
     * 渲染一帧
     *
     * @param world 模拟世界（读取实体插值状态与玩家引用）
     * @param alpha 插值系数 ∈ [0,1)
     * @param aimDir 鼠标瞄准方向（null=教练关闭，回退纯机头注视）
     */
    render(world, alpha, aimDir) {
      const now = performance.now();
      const frameDt = Math.min((now - lastFrameMs) / 1000, 0.1);
      lastFrameMs = now;

      bridge.syncFrom(world, alpha);

      // 导弹烟迹：为每枚存活导弹排放一粒烟点
      for (const entity of world.getEntities()) {
        if (entity.alive && entity.missile !== undefined) {
          effects.emitMissileTrail(entity.position);
        }
      }

      // 大气：云层漂移 + 按任务进度昼夜渐变（天气在其后叠加暗色修正）
      atmosphere.update(frameDt, world.mission.getMissionElapsedTime() / MISSION_TOTAL_TIME);
      weather.update(frameDt);

      // 特效粒子推进
      effects.update(frameDt);

      // 翼尖涡流：收集飞机实体插值位姿与 G 值
      vortexFrames.length = 0;
      for (const entity of world.getEntities()) {
        if (!entity.alive || entity.aircraft === undefined) {
          continue;
        }
        if (
          entity.variant === 'player' ||
          entity.variant === 'enemy' ||
          entity.variant === 'wingman'
        ) {
          const obj = bridge.getObject(entity.id);
          if (obj !== undefined) {
            vortexFrames.push({
              id: entity.id,
              position: obj.position,
              quaternion: obj.quaternion,
              gLoad: entity.aircraft.gLoad,
            });
          }
        }
      }
      vortices.update(vortexFrames);

      // 追尾相机：读取玩家插值位姿与飞行状态（坠毁后玩家对象被移除，相机保持原位）；
      // 鼠标教练激活时把瞄准方向传入（镜头按 aimFollow 朝鼠标平移注视）
      const player = world.getPlayer();
      if (player !== null && player.aircraft !== undefined) {
        const playerObject = bridge.getObject(player.id);
        if (playerObject !== undefined) {
          chaseCamera.update(
            playerObject.position,
            playerObject.quaternion,
            player.aircraft.speed,
            player.aircraft.gLoad,
            frameDt,
            aimDir,
          );
        }
      }

      renderer.render(scene, camera);
    },

    /**
     * 提交本帧模拟事件（战斗特效触发）
     *
     * 功能：将模拟事件映射为视觉特效——
     * missile-hit → 空中爆炸；missile-miss → 小型自毁爆闪；
     * target-destroyed → 按高度与实体类型分空爆（小/大）/地面爆炸；
     * player-crash → 大型爆炸；gun-hit → 命中火花
     * @param events 本帧模拟事件列表（只读）
     * @returns void
     * 异常：无
     * 注意事项：与 HUD 共享同一事件列表（先渲染后调用或顺序无关）；
     * 轰炸机/地面大目标用 large 规模（1.8 倍）
     */
    handleEvents(events) {
      for (const event of events) {
        switch (event.type) {
          case 'missile-hit':
            effects.spawnAirExplosion(event.position, 'small');
            break;
          case 'missile-miss':
            effects.spawnAirExplosion(event.position, 'small');
            break;
          case 'target-destroyed': {
            const kind =
              event.variant === 'bomber' || event.variant === 'ground-target-entity'
                ? 'large'
                : 'small';
            if (event.position.y < GROUND_BLAST_ALTITUDE) {
              effects.spawnGroundExplosion(event.position);
            } else {
              effects.spawnAirExplosion(event.position, kind);
            }
            break;
          }
          case 'player-crash':
            if (event.position.y < GROUND_BLAST_ALTITUDE) {
              effects.spawnGroundExplosion(event.position);
            } else {
              effects.spawnAirExplosion(event.position, 'large');
            }
            break;
          case 'gun-hit':
            effects.spawnHitSpark(event.position);
            break;
          default:
            break;
        }
      }
    },

    /**
     * 将实体当前渲染帧位置投影为屏幕坐标
     *
     * 功能：取实体渲染对象的插值位置，经相机投影矩阵变换为
     * NDC 坐标后换算为屏幕像素坐标；输出视锥内判定与原始 NDC
     * 分量（供 HUD 计算出屏目标的屏幕边缘箭头方向）
     * @param entityId 模拟实体 ID
     * @returns 屏幕投影；实体无渲染对象（未出现/已消亡）时返回 null
     * 异常：无
     * 注意事项：须在 render() 之后调用（插值位置已同步）；
     * NDC z>1 表示在相机后方（behind=true），此时 NDC 方向
     * 镜像，边缘箭头方向须取反
     */
    projectEntity(entityId) {
      const obj = bridge.getObject(entityId);
      if (obj === undefined) {
        return null;
      }
      _projectVec.copy(obj.position).project(camera);
      return buildProjection();
    },

    /**
     * 将实体机头前向某距离处的点投影为屏幕坐标
     *
     * 功能：取实体渲染对象的插值位姿，计算沿机头方向（本体 -Z）
     * 前向 distance 米处的世界点并投影为屏幕像素坐标——
     * 鼠标教练模式下 HUD 弹着点准星的定位源（机头方向 ≠ 屏幕中心，
     * 相机存在 height/lookAhead/rollFollow 固有偏差）
     * @param entityId 模拟实体 ID
     * @param distance 前向距离（米，建议远大于相机偏移量）
     * @returns 屏幕投影；实体无渲染对象时返回 null
     * 异常：无
     * 注意事项：须在 render() 之后调用（插值位姿已同步）
     */
    projectForwardPoint(entityId, distance) {
      const obj = bridge.getObject(entityId);
      if (obj === undefined) {
        return null;
      }
      _projectVec
        .set(0, 0, -1)
        .applyQuaternion(obj.quaternion)
        .multiplyScalar(distance)
        .add(obj.position)
        .project(camera);
      return buildProjection();
    },

    /**
     * 屏幕像素坐标 → 世界坐标视线方向
     *
     * 功能：将光标屏幕坐标换算为 NDC 后经相机反投影，返回从相机
     * 位置出发穿过该像素的世界单位方向向量——鼠标教练瞄准方向
     * 的来源（core 层 InputManager 经注入的提供者间接调用）
     * @param cursorX 光标横坐标（像素）
     * @param cursorY 光标纵坐标（像素）
     * @param out 输出向量（调用方持有，复用避免每固定步分配）
     * @returns 世界坐标单位方向（即 out 本身）
     * 异常：无
     * 注意事项：使用上一渲染帧的相机矩阵（固定步先于渲染执行），
     * 一帧滞后对瞄准无可感知影响
     */
    screenToWorldDirection(cursorX, cursorY, out) {
      _unprojectVec.set(
        (cursorX / window.innerWidth) * 2 - 1,
        -(cursorY / window.innerHeight) * 2 + 1,
        0.5,
      );
      _unprojectVec.unproject(camera).sub(camera.position).normalize();
      return out.copy(_unprojectVec);
    },

    /**
     * 激活天气音频上下文（用户手势后调用）
     *
     * 功能：创建/resume WebAudio AudioContext（雷声合成用）
     * @returns void
     * 异常：WebAudio 不可用时静默降级
     */
    resumeWeatherAudio(): void {
      weather.resumeAudio();
    },

    /**
     * 获取屏幕白闪当前强度
     *
     * @returns 0..1 的白闪强度（0=无闪，HUD 天气闪屏消费）
     */
    getWeatherFlash(): number {
      return weather.flashPulse;
    },

    /**
     * 处理窗口尺寸变化
     */
    resize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    },

    /**
     * 释放渲染资源
     */
    dispose() {
      bridge.dispose();
      effects.dispose();
      vortices.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
