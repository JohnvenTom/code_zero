import { Vector3 } from 'three';
import { GameLoop } from './core/gameLoop';
import { InputManager } from './core/input';
import {
  loadUserSettings,
  onUserSettingsChanged,
  userSettings,
} from './core/settingsStore';
import { PerfProbe } from './diagnostics/perf';
import { createRenderApp, type RenderApp } from './render';
import { setPlayerFighter } from './render/objects/meshes';
import { SimulationWorld } from './simulation';
import type { GameEvent, MarkerInfo } from './simulation';
import { createHud, type Hud, type HudLockInfo, type HudScorePopup, type HudTargetMarker } from './ui';
import { createMissionUi, type MissionUi } from './ui';
import { createHangarUi, type HangarUi } from './ui';

/** 出屏标记贴边余量（像素，距屏幕边缘的安全距离） */
const EDGE_MARGIN_PX = 70;

/**
 * 计算出屏目标的屏幕边缘箭头位置与朝向
 *
 * 功能：按投影 NDC 方向（相机后方时取反）计算从屏幕中心指向
 * 目标的射线与屏幕内缩矩形的交点（贴边箭头位置），
 * 并换算 CSS rotate 朝向角（0=上，顺时针）
 * @param ndcX 投影 NDC 横坐标
 * @param ndcY 投影 NDC 纵坐标（NDC y 向上）
 * @param behind 是否在相机后方（方向须取反）
 * @returns 贴边坐标（像素）与箭头朝向角（度）；方向退化时返回 null
 * 异常：无
 * 注意事项：NDC y 向上而屏幕 y 向下，方向分量已转换；
 * 交点计算按 x/y 分别缩放取比例较小者（先碰到的边）
 */
function computeEdgeIndicator(
  ndcX: number,
  ndcY: number,
  behind: boolean,
): { x: number; y: number; angleDeg: number } | null {
  // 相机后方：NDC 方向镜像，取反获得真实方向
  const dirX = behind ? -ndcX : ndcX;
  const dirY = behind ? -ndcY : ndcY;
  if (Math.abs(dirX) < 1e-6 && Math.abs(dirY) < 1e-6) {
    return null;
  }

  // 屏幕坐标系：x 右为正，y 下为正（NDC y 向上需取反）
  const screenDirX = dirX;
  const screenDirY = -dirY;

  // 射线与内缩屏幕矩形的交点：t 取 x/y 方向碰边比例的较小者
  const halfW = window.innerWidth / 2 - EDGE_MARGIN_PX;
  const halfH = window.innerHeight / 2 - EDGE_MARGIN_PX;
  const tx = Math.abs(screenDirX) > 1e-6 ? halfW / Math.abs(screenDirX) : Infinity;
  const ty = Math.abs(screenDirY) > 1e-6 ? halfH / Math.abs(screenDirY) : Infinity;
  const t = Math.min(tx, ty);
  const edgeX = window.innerWidth / 2 + screenDirX * t;
  const edgeY = window.innerHeight / 2 + screenDirY * t;

  // CSS rotate 朝向角：0=上，顺时针（atan2(dx, -dy)）
  const angleDeg = (Math.atan2(screenDirX, -screenDirY) * 180) / Math.PI;
  return { x: edgeX, y: edgeY, angleDeg };
}

/**
 * 组装全目标屏幕标记列表（投影 + 边缘箭头）
 *
 * 功能：遍历世界层标记源数据，逐个经渲染层投影为屏幕坐标——
 * 视线内直接使用目标位置；出屏目标计算贴边箭头位置与朝向
 * @param flight 玩家飞行快照（含 markers 源数据）
 * @param renderApp 渲染应用（projectEntity 投影）
 * @returns HUD 标记列表（供 hud.update 消费）
 * 异常：无
 * 注意事项：实体已消亡（无渲染对象）时跳过该标记
 */
function assembleMarkers(
  flight: { markers: readonly MarkerInfo[] } | null,
  renderApp: RenderApp,
): HudTargetMarker[] {
  const result: HudTargetMarker[] = [];
  if (flight === null) {
    return result;
  }
  for (const info of flight.markers) {
    const projection = renderApp.projectEntity(info.id);
    if (projection === null) {
      continue;
    }
    if (projection.onScreen) {
      result.push({
        kind: info.kind,
        screenX: projection.x,
        screenY: projection.y,
        onScreen: true,
        edgeAngleDeg: 0,
        distance: info.distance,
        incoming: info.incoming,
      });
    } else {
      const edge = computeEdgeIndicator(projection.ndcX, projection.ndcY, projection.behind);
      if (edge === null) {
        continue;
      }
      result.push({
        kind: info.kind,
        screenX: edge.x,
        screenY: edge.y,
        onScreen: false,
        edgeAngleDeg: edge.angleDeg,
        distance: info.distance,
        incoming: info.incoming,
      });
    }
  }
  return result;
}

/**
 * 组装 COD 风格得分弹出列表（事件 → 得分 + 屏幕投影）
 *
 * 功能：遍历本帧模拟事件——gun-hit/missile-hit → +100 命中（小号白色）；
 * target-destroyed → 按实体变体得分（敌机 +150 / 轰炸机 +250 /
 * 地面 +100，大号金色）；得分弹出在事件发生位置弹出（事件位置
 * 经世界层最近的实体投影——gun-hit 位置无法直接投影，此处用
 * 准星中心附近偏移模拟弹出位置）
 * @param events 本帧模拟事件列表
 * @param renderApp 渲染应用（projectEntity 投影）
 * @returns 得分弹出列表（供 hud.update 消费）
 * 异常：无
 * 注意事项：命中事件的位置是弹着点（无渲染对象不可投影），
 * 用屏幕中心 + 随机小偏移近似；击坠事件同样处理
 */
function assembleScorePopups(events: readonly GameEvent[]): HudScorePopup[] {
  const result: HudScorePopup[] = [];
  for (const event of events) {
    if (event.type === 'gun-hit' || event.type === 'missile-hit') {
      result.push({
        screenX: window.innerWidth / 2 + (Math.random() * 2 - 1) * 60,
        screenY: window.innerHeight / 2 + (Math.random() * 2 - 1) * 40,
        text: '+100',
        kill: false,
      });
    } else if (event.type === 'target-destroyed') {
      const score =
        event.variant === 'enemy'
          ? '+150'
          : event.variant === 'bomber'
            ? '+250'
            : event.variant === 'ground-target-entity'
              ? '+100'
              : '+100';
      result.push({
        screenX: window.innerWidth / 2 + (Math.random() * 2 - 1) * 80,
        screenY: window.innerHeight / 2 + (Math.random() * 2 - 1) * 50,
        text: score,
        kill: true,
      });
    }
  }
  return result;
}

/**
 * 应用引导函数
 *
 * 功能：按层装配全部子系统——键盘输入管理器、DOM HUD、机库选择
 * 界面、任务界面（简报/任务 HUD/结算）、渲染应用（天空/几何云/
 * 追尾相机/战斗特效）、性能探针与固定步长主循环；
 * 完整流程为：机库选机（3 架机型）→ 按所选机型生成玩家战机 →
 * 任务简报 → 玩家点击开始 → 任务推进 → 胜利/失败结算 → 重开
 * 参数：无
 * 返回值：void
 * @throws 容器元素缺失或 WebGL 初始化失败时抛出/向上冒泡异常
 * 注意事项：本函数是唯一的层间装配点，各层内部不互相直接引用；
 * 玩家实体在机库选择完成后才生成（机型决定属性/武器装配）；
 * 模拟事件每帧取出后同时分发给 HUD 与渲染层战斗特效；
 * 全目标屏幕标记（含出屏边缘箭头与来袭导弹标记）每帧组装
 */
function bootstrap(): void {
  // ---- core 层：用户设置加载（localStorage → 内存单例） ----
  loadUserSettings();

  // ---- core 层：键盘+鼠标输入管理器（DOM → 纯数据输入快照） ----
  const input = new InputManager();

  // ---- simulation 层：模拟世界（玩家战机在机库选择后生成） ----
  const world = new SimulationWorld();

  // ---- ui 层：DOM HUD + 任务界面 + 机库界面 ----
  const hudRoot = document.getElementById('hud-root');
  if (hudRoot === null) {
    throw new Error('找不到 #hud-root 容器：请检查 index.html');
  }
  const hud: Hud = createHud(hudRoot);
  const missionUi: MissionUi = createMissionUi(hudRoot);
  const hangarUi: HangarUi = createHangarUi(hudRoot);

  // ---- render 层：Three.js 渲染适配 ----
  const appContainer = document.getElementById('app');
  if (appContainer === null) {
    throw new Error('找不到 #app 容器：请检查 index.html');
  }
  let renderApp: RenderApp;
  try {
    renderApp = createRenderApp({
      container: appContainer,
      onContextLost: () => hud.showContextLost(),
      onContextRestored: () => hud.hideContextLost(),
    });
  } catch (error) {
    console.error('[CODE ZERO] WebGL 初始化失败：', error);
    hud.showContextLost('WebGL 初始化失败：当前浏览器或设备可能不支持 WebGL。');
    return;
  }

  // ---- diagnostics 层：性能探针 ----
  const perf = new PerfProbe();

  // ---- 鼠标教练装配：光标屏幕坐标 → 世界瞄准方向（纯数据进模拟层） ----
  /** 瞄准方向复用向量（提供者每固定步覆写，同步消费不逃逸） */
  const aimDir = new Vector3();
  input.setAimDirProvider((cursorX, cursorY) =>
    renderApp.screenToWorldDirection(cursorX, cursorY, aimDir),
  );
  // 设置页滑条 → 世界层教练调参（实时生效）
  const applyInstructorTuning = (): void => {
    world.tuneInstructor({
      pursuitResponse: userSettings.pursuitResponse,
      rudderAssist: userSettings.rudderAssist,
    });
  };
  applyInstructorTuning();
  onUserSettingsChanged(applyInstructorTuning);

  /** 结算界面是否已弹出（任务结束帧一次性触发） */
  let resultShown = false;

  // ---- core 层：固定时间步长主循环 ----
  const loop = new GameLoop({
    fixedUpdate: (dt) => {
      // 任务未激活且玩家未生成时机库阶段——无模拟推进
      if (world.getPlayer() !== null) {
        world.fixedUpdate(dt, input.sample());
      }
    },
    render: (alpha, frameDt) => {
      perf.update(frameDt);

      // 鼠标教练瞄准方向（光标反投影）：供追尾相机朝鼠标平移注视
      // （与固定步采样共用同一复用向量——同步消费不逃逸）
      const mouseAim = input.getMouseAimState();
      const aimRay =
        mouseAim.active && world.getPlayer() !== null
          ? renderApp.screenToWorldDirection(mouseAim.cursorX, mouseAim.cursorY, aimDir)
          : null;
      renderApp.render(world, alpha, aimRay);

      const flight = world.getPlayerFlightData();
      const missionStatus = world.mission.getStatus();

      // 战斗中隐藏系统光标（自定义设定点环替代视觉指示）
      document.body.classList.toggle(
        'mouse-aim-cursor-hidden',
        mouseAim.active && missionStatus === 'active',
      );
      // 弹着点准星：机头方向前向点投影（教练激活时空中的可定位准星；
      // 与设定点分离可视化"机头还在转过来"的收敛过程）
      let noseAim: { x: number; y: number } | null = null;
      if (mouseAim.active && flight !== null && flight.alive && !flight.onGround) {
        const player = world.getPlayer();
        const noseProjection =
          player !== null ? renderApp.projectForwardPoint(player.id, 4000) : null;
        if (noseProjection !== null && noseProjection.onScreen) {
          noseAim = { x: noseProjection.x, y: noseProjection.y };
        }
      }

      // 锁定框定位：锁定目标经渲染层投影为屏幕坐标（含机型名与距离）
      let lock: HudLockInfo | null = null;
      if (flight !== null && flight.lockTargetId !== null) {
        const projection = renderApp.projectEntity(flight.lockTargetId);
        if (projection !== null) {
          lock = {
            state: flight.lockState,
            progress: flight.lockProgress,
            screenX: projection.x,
            screenY: projection.y,
            onScreen: projection.onScreen,
            targetName: flight.lockTargetName,
            distance: flight.lockTargetDistance,
          };
        }
      }

      // 全目标屏幕标记：投影 + 出屏边缘箭头组装
      const markers = assembleMarkers(flight, renderApp);

      // 模拟事件：一次取出，HUD 与战斗特效共享消费
      const events = world.consumeEvents();
      renderApp.handleEvents(events);

      // COD 得分弹出：事件 → 得分文本 + 屏幕位置组装
      const scorePopups = assembleScorePopups(events);

      hud.update({
        fps: perf.fps,
        frameMs: perf.averageFrameMs,
        simTime: world.getElapsedTime(),
        entityCount: world.getEntities().length,
        flight,
        lock,
        markers,
        scorePopups,
        mouseAim:
          mouseAim.active && missionStatus === 'active'
            ? { cursorX: mouseAim.cursorX, cursorY: mouseAim.cursorY }
            : null,
        noseAim,
        weatherFlash: renderApp.getWeatherFlash(),
        events,
      });

      // 任务 HUD：阶段目标进度 + 总倒计时
      const phase =
        missionStatus === 'active'
          ? world.mission.getPhaseSnapshot(world.getEntities())
          : null;
      missionUi.updateHud(phase, world.getMissionTimeRemaining());

      // 任务结束 → 一次性弹出结算界面
      if (!resultShown && (missionStatus === 'victory' || missionStatus === 'failed')) {
        resultShown = true;
        const player = world.getPlayer();
        const result = world.mission.getResult(
          player?.health?.hp ?? 0,
          player?.missiles?.ammo ?? 0,
        );
        if (result !== null) {
          missionUi.hideHud();
          missionUi.showResult(result, () => {
            // 重开任务：整页刷新（回到机库重新选机）
            window.location.reload();
          });
        }
      }
    },
  });

  // ---- 流程装配：机库选机 → 生成玩家+僚机 → 任务简报 ----
  hangarUi.show((fighterId) => {
    // 按所选机型装配玩家（属性/武器）并同步渲染配色
    setPlayerFighter(fighterId);
    world.spawnPlayer(fighterId);
    world.spawnWingmen();
    // 选机完成 → 任务简报
    missionUi.showBriefing(() => {
      // 用户手势后激活天气音频（雷声合成用）
      renderApp.resumeWeatherAudio();
      world.mission.start();
    });
  });

  // 窗口 resize：画布与相机自适应（HUD 为 DOM 布局，随 CSS 自适应）
  window.addEventListener('resize', () => {
    renderApp.resize();
  });

  loop.start();
}

// 模块脚本在 DOM 就绪后执行，直接引导启动
bootstrap();
