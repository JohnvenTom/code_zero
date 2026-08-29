import { GameLoop } from './core/gameLoop';
import { InputManager } from './core/input';
import { PerfProbe } from './diagnostics/perf';
import { createRenderApp, type RenderApp } from './render';
import { setPlayerFighter } from './render/objects/meshes';
import { SimulationWorld } from './simulation';
import { createHud, type Hud, type HudLockInfo } from './ui';
import { createMissionUi, type MissionUi } from './ui';
import { createHangarUi, type HangarUi } from './ui';

/**
 * 应用引导函数
 *
 * 功能：按层装配全部子系统——键盘输入管理器、DOM HUD、机库选择
 * 界面、任务界面（简报/任务 HUD/结算）、渲染应用（天空/地形/
 * 追尾相机）、性能探针与固定步长主循环；
 * 完整流程为：机库选机（3 架机型）→ 按所选机型生成玩家战机 →
 * 任务简报 → 玩家点击开始 → 任务推进 → 胜利/失败结算 → 重开
 * 参数：无
 * 返回值：void
 * @throws 容器元素缺失或 WebGL 初始化失败时抛出/向上冒泡异常
 * 注意事项：本函数是唯一的层间装配点，各层内部不互相直接引用；
 * 玩家实体在机库选择完成后才生成（机型决定属性/武器装配）；
 * 模拟事件每帧取出后同时分发给 HUD 与渲染层战斗特效
 */
function bootstrap(): void {
  // ---- core 层：键盘输入管理器（DOM → 纯数据输入快照） ----
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
      renderApp.render(world, alpha);

      const flight = world.getPlayerFlightData();
      const missionStatus = world.mission.getStatus();

      // 锁定框定位：锁定目标经渲染层投影为屏幕坐标
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
          };
        }
      }

      // 模拟事件：一次取出，HUD 与战斗特效共享消费
      const events = world.consumeEvents();
      renderApp.handleEvents(events);

      hud.update({
        fps: perf.fps,
        frameMs: perf.averageFrameMs,
        simTime: world.getElapsedTime(),
        entityCount: world.getEntities().length,
        flight,
        lock,
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
