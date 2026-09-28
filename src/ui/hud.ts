import { gameConfig } from '../config';
import type { GameEvent, PlayerFlightSnapshot } from '../simulation';

/**
 * 锁定框屏幕定位数据（由 main.ts 结合渲染层投影组装）
 */
export interface HudLockInfo {
  /** 锁定状态：none=无目标 / locking=锁定中 / locked=锁定完成 */
  readonly state: 'none' | 'locking' | 'locked';
  /** 锁定进度 0..1（locking 阶段显示百分比） */
  readonly progress: number;
  /** 目标屏幕横坐标（像素） */
  readonly screenX: number;
  /** 目标屏幕纵坐标（像素） */
  readonly screenY: number;
  /** 目标是否在屏幕内（false 时隐藏锁定框） */
  readonly onScreen: boolean;
  /** 锁定目标机型名（locked 阶段显示，如 Su-35S） */
  readonly targetName: string;
  /** 锁定目标距离（米，locked 阶段显示） */
  readonly distance: number;
}

/**
 * 全目标屏幕标记（由 main.ts 结合渲染层投影组装）
 *
 * 功能：视线内目标显示小标记框+距离；出屏目标显示屏幕边缘
 * 箭头（edgeAngleDeg 指示转向方向）；来袭导弹为红色高威胁标记
 */
export interface HudTargetMarker {
  /** 标记种类（enemy/bomber/ally/wingman/ground/missile） */
  readonly kind: string;
  /** 屏幕横坐标（像素；视线内=目标位置，出屏=边缘箭头位置） */
  readonly screenX: number;
  /** 屏幕纵坐标（像素；同上） */
  readonly screenY: number;
  /** 是否在视线内（true=标记框，false=边缘箭头） */
  readonly onScreen: boolean;
  /** 出屏箭头朝向（度，0=上，顺时针；onScreen 时忽略） */
  readonly edgeAngleDeg: number;
  /** 与玩家距离（米） */
  readonly distance: number;
  /** 是否来袭导弹（红色高威胁闪烁标记） */
  readonly incoming: boolean;
}

/**
 * COD 风格得分弹出（由 main.ts 结合渲染层投影组装）
 */
export interface HudScorePopup {
  /** 屏幕横坐标（像素，目标位置） */
  readonly screenX: number;
  /** 屏幕纵坐标（像素） */
  readonly screenY: number;
  /** 得分文本（如 "+100"） */
  readonly text: string;
  /** 是否大号金色（击坠；false=小号白色命中） */
  readonly kill: boolean;
}

/**
 * HUD 统计数据（由 main.ts 每帧喂入）
 */
export interface HudStats {
  /** 平均 FPS */
  readonly fps: number;
  /** 平均帧耗时（毫秒） */
  readonly frameMs: number;
  /** 模拟累计时间（秒） */
  readonly simTime: number;
  /** 存活实体数量 */
  readonly entityCount: number;
  /** 玩家飞行快照（未生成玩家时为 null） */
  readonly flight: PlayerFlightSnapshot | null;
  /** 锁定框屏幕定位数据（无锁定目标时为 null） */
  readonly lock: HudLockInfo | null;
  /** 全目标屏幕标记列表（敌机/轰炸机/地面/友军/僚机/来袭导弹） */
  readonly markers: readonly HudTargetMarker[];
  /** 本帧得分弹出列表（命中/击坠，投影定位） */
  readonly scorePopups: readonly HudScorePopup[];
  /** 鼠标教练瞄准状态（null=未激活或非战斗：隐藏设定点环、准星回屏幕中心） */
  readonly mouseAim: { readonly cursorX: number; readonly cursorY: number } | null;
  /** 机头弹着点屏幕投影（鼠标教练激活时空中的可定位准星锚点；null=准星回屏幕中心） */
  readonly noseAim: { readonly x: number; readonly y: number } | null;
  /** 天气屏幕白闪强度（0..1，闪电时） */
  readonly weatherFlash: number;
  /** 本帧消费的模拟事件（命中/击毁/坠毁/导弹/干扰弹/锁定） */
  readonly events: readonly GameEvent[];
}

/**
 * HUD 控制接口
 */
export interface Hud {
  /** 每帧调用：刷新性能条（节流）与全部飞行仪表数值、雷达与锁定框、处理事件反馈 */
  update(stats: HudStats): void;
  /** 显示 WebGL 上下文丢失/致命错误提示遮罩 */
  showContextLost(message?: string): void;
  /** 隐藏上下文丢失提示遮罩 */
  hideContextLost(): void;
}

/** 上下文丢失默认文案 */
const DEFAULT_CONTEXT_LOST_MESSAGE = 'WebGL 上下文已丢失，正在等待浏览器恢复…';

/** 性能状态条 DOM 刷新节流间隔（毫秒） */
const DOM_UPDATE_INTERVAL_MS = 250;

/** 高 G 告警阈值（G） */
const G_WARN_THRESHOLD = 7;

/** 雷达半径（像素，HUD 布局常量） */
const RADAR_RADIUS_PX = 78;

/** 雷达光点 DOM 池容量（敌机+轰炸机+友军+地面目标上限） */
const RADAR_BLIP_POOL = 32;

/** 屏幕标记 DOM 池容量（敌机+轰炸机+友军+僚机+地面+来袭导弹上限） */
const MARKER_POOL = 36;

/** 得分弹出 DOM 池容量 */
const SCORE_POOL = 8;

/** 雷达显示范围（米，来自配置表） */
const RADAR_RANGE_M = gameConfig.radar.range;

/**
 * 重放一次性 CSS 动画
 *
 * 功能：移除再强制重排后添加激活类，使 CSS animation 从头播放
 * @param element 目标元素
 * @param className 激活类名
 * @returns void
 * 异常：无
 * 注意事项：依赖 offsetWidth 读取强制同步重排触发动画重启
 */
function retriggerAnimation(element: HTMLElement, className: string): void {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

/**
 * 创建 HUD
 *
 * 功能：在指定根容器内构建完整战斗 HUD——左上角性能状态条、
 * 中央准星 + G 值 + 命中标记与击毁提示、左侧速度/油门面板、
 * 右侧高度面板、左下武器/生存面板（机炮/导弹/干扰弹/机体）、
 * 右下 north-up 固定方位雷达（N 标记 + 玩家航向箭头 +
 * 敌我识别光点 + 扫描线）、全目标屏幕标记池（视线内标记框+
 * 距离 / 出屏贴边箭头 / 来袭导弹红色高威胁标记）、
 * 真实战机风格四角锁定框（锁定完成显示目标型号+距离）、
 * 失速/导弹来袭/被锁定告警、坠毁提示、底部操作提示与
 * WebGL 上下文丢失遮罩
 * @param root HUD 根容器元素（index.html 中的 #hud-root）
 * @returns HUD 控制接口
 * @throws 无（DOM 构建失败由浏览器抛出的异常向上冒泡）
 * 注意事项：飞行数值每帧刷新（textContent 更新开销极低），
 * 性能状态条 0.25s 节流；雷达光点与屏幕标记均使用固定 DOM 池
 * 避免每帧重建；HUD 为 pointer-events:none 覆盖层
 */
export function createHud(root: HTMLElement): Hud {
  // ---- 左上角性能状态条 ----
  const strip = document.createElement('div');
  strip.className = 'hud-status-strip';
  const fpsValue = createStat(strip, 'FPS');
  const frameMsValue = createStat(strip, '帧耗时');
  const simTimeValue = createStat(strip, '模拟时间');
  const entityCountValue = createStat(strip, '实体');
  root.appendChild(strip);

  // ---- 中央动态准星（速度张合四支架 + 中心点，迭代11 删除旋转刻度环） ----
  const crosshair = document.createElement('div');
  crosshair.className = 'hud-crosshair';
  const crosshairDot = document.createElement('div');
  crosshairDot.className = 'hud-crosshair-dot';
  for (const side of ['t', 'b', 'l', 'r']) {
    const arm = document.createElement('div');
    arm.className = `hud-crosshair-arm arm-${side}`;
    crosshair.appendChild(arm);
  }
  crosshair.appendChild(crosshairDot);
  root.appendChild(crosshair);

  // ---- 命中标记（准星处的 X 形闪现） ----
  const hitmarker = document.createElement('div');
  hitmarker.className = 'hud-hitmarker';
  root.appendChild(hitmarker);

  // ---- 鼠标教练设定点环（光标位置的小圆环：教练追踪目标，默认隐藏） ----
  const aimCursor = document.createElement('div');
  aimCursor.className = 'hud-aim-cursor';
  root.appendChild(aimCursor);

  // ---- 击毁提示（准星上方短暂浮现） ----
  const killToast = document.createElement('div');
  killToast.className = 'hud-kill-toast';
  root.appendChild(killToast);

  // ---- G 值读数（准星下方） ----
  const gReadout = document.createElement('div');
  gReadout.className = 'hud-g';
  gReadout.textContent = 'G 1.0';
  root.appendChild(gReadout);

  // ---- 左侧速度/油门面板（含最佳机动速度 CNR 指示） ----
  const speedPanel = document.createElement('div');
  speedPanel.className = 'hud-panel hud-speed';
  const speedLabel = document.createElement('div');
  speedLabel.className = 'hud-panel-label';
  speedLabel.textContent = 'SPD km/h';
  const speedValue = document.createElement('div');
  speedValue.className = 'hud-panel-value';
  speedValue.textContent = '0';
  // CNR（corner speed 最佳机动速度，km/h）：当前速度处于最佳带内时速度值变绿
  const cnrRow = document.createElement('div');
  cnrRow.className = 'hud-cnr';
  cnrRow.textContent = 'CNR --';
  const throttleRow = document.createElement('div');
  throttleRow.className = 'hud-throttle';
  const throttleBar = document.createElement('div');
  throttleBar.className = 'hud-throttle-bar';
  const throttleFill = document.createElement('div');
  throttleFill.className = 'hud-throttle-fill';
  throttleBar.appendChild(throttleFill);
  const throttleText = document.createElement('span');
  throttleText.className = 'hud-throttle-text';
  throttleText.textContent = 'THR 0%';
  throttleRow.appendChild(throttleBar);
  throttleRow.appendChild(throttleText);
  speedPanel.appendChild(speedLabel);
  speedPanel.appendChild(speedValue);
  speedPanel.appendChild(cnrRow);
  speedPanel.appendChild(throttleRow);
  root.appendChild(speedPanel);

  // ---- 右侧高度面板 ----
  const altPanel = document.createElement('div');
  altPanel.className = 'hud-panel hud-alt';
  const altLabel = document.createElement('div');
  altLabel.className = 'hud-panel-label';
  altLabel.textContent = 'ALT m';
  const altValue = document.createElement('div');
  altValue.className = 'hud-panel-value';
  altValue.textContent = '0';
  altPanel.appendChild(altLabel);
  altPanel.appendChild(altValue);
  root.appendChild(altPanel);

  // ---- 左下武器/生存面板：机炮/导弹/干扰弹/特殊武器/机体/僚机/击坠 ----
  const weaponsPanel = document.createElement('div');
  weaponsPanel.className = 'hud-weapons';
  const gunValue = createWeaponRow(weaponsPanel, 'GUN', '');
  const missileValue = createWeaponRow(weaponsPanel, 'MSL', '');
  const flareValue = createWeaponRow(weaponsPanel, 'FLR', '');
  const specialValue = createWeaponRow(weaponsPanel, 'SPC', '');
  const hpValue = createWeaponRow(weaponsPanel, 'HP', '');
  const wingmanValue = createWeaponRow(weaponsPanel, '僚机', '');
  const enemyValue = createWeaponRow(weaponsPanel, '击坠', '');
  root.appendChild(weaponsPanel);

  // ---- 右下雷达：north-up 固定方位表盘 + 光点池 + 航向箭头 ----
  const radar = document.createElement('div');
  radar.className = 'hud-radar';
  const radarSweep = document.createElement('div');
  radarSweep.className = 'hud-radar-sweep';
  radar.appendChild(radarSweep);
  // 北方位标记（north-up 雷达固定朝上）
  const radarNorth = document.createElement('div');
  radarNorth.className = 'hud-radar-north';
  radarNorth.textContent = 'N';
  radar.appendChild(radarNorth);
  // 玩家航向箭头（随机头方向旋转，north-up 模式下不随滚转）
  const radarHeading = document.createElement('div');
  radarHeading.className = 'hud-radar-heading';
  radar.appendChild(radarHeading);
  const radarBlips: HTMLElement[] = [];
  for (let i = 0; i < RADAR_BLIP_POOL; i++) {
    const blip = document.createElement('div');
    blip.className = 'hud-radar-blip';
    blip.style.display = 'none';
    radar.appendChild(blip);
    radarBlips.push(blip);
  }
  root.appendChild(radar);

  // ---- 全目标屏幕标记池（标记框/边缘箭头） ----
  const markerEls: { root: HTMLElement; box: HTMLElement; arrow: HTMLElement; text: HTMLElement }[] = [];
  for (let i = 0; i < MARKER_POOL; i++) {
    const markerRoot = document.createElement('div');
    markerRoot.className = 'hud-marker';
    markerRoot.style.display = 'none';
    const markerBox = document.createElement('div');
    markerBox.className = 'hud-marker-box';
    markerRoot.appendChild(markerBox);
    const markerArrow = document.createElement('div');
    markerArrow.className = 'hud-marker-arrow';
    markerRoot.appendChild(markerArrow);
    const markerText = document.createElement('div');
    markerText.className = 'hud-marker-text';
    markerRoot.appendChild(markerText);
    root.appendChild(markerRoot);
    markerEls.push({ root: markerRoot, box: markerBox, arrow: markerArrow, text: markerText });
  }

  // ---- 屏幕空间锁定框（真实战机风格四角框） ----
  const lockBox = document.createElement('div');
  lockBox.className = 'hud-lockbox';
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    const cornerEl = document.createElement('div');
    cornerEl.className = `hud-lockbox-corner ${corner}`;
    lockBox.appendChild(cornerEl);
  }
  const lockLabel = document.createElement('div');
  lockLabel.className = 'hud-lockbox-label';
  lockBox.appendChild(lockLabel);
  root.appendChild(lockBox);

  // ---- COD 风格得分弹出池（DOM 复用，CSS 动画向上飘淡出） ----
  const scoreEls: HTMLElement[] = [];
  for (let i = 0; i < SCORE_POOL; i++) {
    const score = document.createElement('div');
    score.className = 'hud-score';
    score.style.display = 'none';
    root.appendChild(score);
    scoreEls.push(score);
  }

  // ---- 天气屏幕白闪（闪电触发时快速淡出，默认透明） ----
  const weatherFlashEl = document.createElement('div');
  weatherFlashEl.className = 'hud-weather-flash';
  root.appendChild(weatherFlashEl);

  // ---- 告警条：失速 / 导弹来袭 / 被锁定 ----
  const stallWarning = document.createElement('div');
  stallWarning.className = 'hud-warn hud-warn-stall';
  stallWarning.textContent = '失速 STALL';
  root.appendChild(stallWarning);

  const missileWarning = document.createElement('div');
  missileWarning.className = 'hud-warn hud-warn-missile';
  missileWarning.textContent = '⚠ 导弹来袭 MISSILE';
  root.appendChild(missileWarning);

  const lockWarning = document.createElement('div');
  lockWarning.className = 'hud-warn hud-warn-lock';
  lockWarning.textContent = '被锁定 LOCKED';
  root.appendChild(lockWarning);

  // ---- 坠毁提示 ----
  const crashPanel = document.createElement('div');
  crashPanel.className = 'hud-crash';
  const crashTitle = document.createElement('div');
  crashTitle.className = 'hud-crash-title';
  crashTitle.textContent = '已坠毁';
  const crashHint = document.createElement('div');
  crashHint.className = 'hud-crash-hint';
  crashHint.textContent = '按 Backspace 键重置到跑道';
  crashPanel.appendChild(crashTitle);
  crashPanel.appendChild(crashHint);
  root.appendChild(crashPanel);

  // ---- 底部操作提示（迭代12 鼠标教练文案） ----
  const chip = document.createElement('div');
  chip.className = 'hud-hint-chip';
  chip.textContent =
    '鼠标瞄准 · 左键 开火 · 滚轮 换武器 · 右键 切目标 · 方向键 手动接管 · W/S 油门 · C 僚机 · E 干扰弹 · M 鼠标教练开关 · Backspace 重置';
  root.appendChild(chip);

  // ---- WebGL 上下文丢失遮罩（默认隐藏） ----
  const overlay = document.createElement('div');
  overlay.className = 'hud-context-overlay';
  const message = document.createElement('div');
  message.className = 'hud-context-message';
  message.textContent = DEFAULT_CONTEXT_LOST_MESSAGE;
  overlay.appendChild(message);
  root.appendChild(overlay);

  let lastDomUpdateMs = 0;

  return {
    /**
     * 刷新 HUD
     *
     * 功能：节流刷新性能状态条；每帧刷新飞行仪表数值、雷达光点、
     * 锁定框与告警样式；消费模拟事件触发命中标记/击毁提示
     * @param stats 本帧统计数据、锁定框定位与模拟事件
     */
    update(stats: HudStats): void {
      // 性能状态条：0.25s 节流
      const nowMs = performance.now();
      if (nowMs - lastDomUpdateMs >= DOM_UPDATE_INTERVAL_MS) {
        lastDomUpdateMs = nowMs;
        fpsValue.textContent = stats.fps.toFixed(0);
        frameMsValue.textContent = `${stats.frameMs.toFixed(1)}ms`;
        simTimeValue.textContent = `${stats.simTime.toFixed(1)}s`;
        entityCountValue.textContent = `${stats.entityCount}`;
      }

      // 飞行仪表：每帧刷新
      const flight = stats.flight;
      if (flight !== null) {
        speedValue.textContent = flight.speedKmh.toFixed(0);
        altValue.textContent = flight.altitudeM.toFixed(0);
        gReadout.textContent = `G ${flight.gLoad.toFixed(1)}`;
        throttleFill.style.height = `${Math.round(flight.throttle * 100)}%`;
        throttleText.textContent = `THR ${Math.round(flight.throttle * 100)}%`;
        // CNR（最佳机动速度 km/h）：当前速度处于最佳带 ±8% 内速度值变绿
        cnrRow.textContent = `CNR ${flight.bestManeuverSpeedKmh.toFixed(0)}`;
        const optimalBand = flight.bestManeuverSpeedKmh * 0.08;
        speedValue.classList.toggle(
          'is-optimal',
          Math.abs(flight.speedKmh - flight.bestManeuverSpeedKmh) <= optimalBand,
        );
        // 武器面板：装填中显示琥珀色 RLD 倒计时（替换数字位），否则显示弹药数
        setWeaponValue(gunValue, flight.ammo, flight.gunReloadRemain);
        setWeaponValue(missileValue, flight.missileAmmo, flight.missileReloadRemain);
        setWeaponValue(flareValue, flight.flareCount, flight.flareReloadRemain);
        setWeaponValue(specialValue, flight.specialAmmo, flight.specialReloadRemain);
        hpValue.textContent = `${Math.max(0, Math.round(flight.hp))}`;
        const commandText =
          flight.wingmanCommand === 'attack'
            ? '进攻'
            : flight.wingmanCommand === 'cover'
              ? '掩护'
              : '集合';
        wingmanValue.textContent = `${flight.wingmenAlive}/${flight.wingmenTotal} ${commandText}`;
        enemyValue.textContent = `${flight.enemyKills}`;

        // 动态准星：支架张合随速度映射（低速张开大瞄准余裕、高速收拢稳定），
        // 高 G 抖动幅度，锁定状态联动变色（速度域用 km/h：极速约 1100+）
        const speedRatio = Math.min(flight.speedKmh / 1100, 1);
        const spread = 26 - speedRatio * 12;
        const jitter = Math.min(Math.max(Math.abs(flight.gLoad) - 4, 0) * 0.7, 2.6);
        const lockState = stats.lock !== null ? stats.lock.state : 'none';
        crosshair.classList.toggle('is-locking', lockState === 'locking');
        crosshair.classList.toggle('is-locked', lockState === 'locked');
        crosshair.style.setProperty('--cs-spread', `${spread.toFixed(1)}px`);
        crosshair.style.setProperty('--cs-jitter', `${jitter.toFixed(2)}px`);

        // 鼠标教练双标记：弹着点准星定位到机头前向投影（与设定点环分离
        // 表示机头收敛进度，重合即对准）；教练关闭/无投影时回屏幕中心
        if (stats.noseAim !== null) {
          crosshair.style.left = `${stats.noseAim.x.toFixed(0)}px`;
          crosshair.style.top = `${stats.noseAim.y.toFixed(0)}px`;
          crosshair.classList.add('is-aim-tracked');
        } else {
          crosshair.style.left = '';
          crosshair.style.top = '';
          crosshair.classList.remove('is-aim-tracked');
        }
        if (stats.mouseAim !== null) {
          aimCursor.style.display = 'block';
          aimCursor.style.left = `${stats.mouseAim.cursorX.toFixed(0)}px`;
          aimCursor.style.top = `${stats.mouseAim.cursorY.toFixed(0)}px`;
        } else {
          aimCursor.style.display = 'none';
        }

        gReadout.classList.toggle('is-high', flight.gLoad >= G_WARN_THRESHOLD);
        gReadout.classList.toggle('is-negative', flight.gLoad < -0.5);
        hpValue.classList.toggle('is-low', flight.hp <= flight.hpMax * 0.3);
        stallWarning.classList.toggle('is-active', flight.stalled && flight.alive);
        missileWarning.classList.toggle('is-active', flight.missileWarning && flight.alive);
        lockWarning.classList.toggle(
          'is-active',
          flight.lockWarning && !flight.missileWarning && flight.alive,
        );
        crashPanel.classList.toggle('is-active', !flight.alive);

        // 雷达光点：池化更新位置与显隐（heading-up 玩家朝向模式——
        // 光点按 -玩家航向角旋转到机头朝上坐标系）
        updateRadarBlipsHeadingUp(radarBlips, flight.radarBlips, flight.playerHeadingDeg);
        // 玩家箭头固定朝上（heading-up）；N 标记转出雷达外圈随航向指示北向
        radarHeading.style.transform = 'rotate(0deg)';
        radarNorth.style.transform = `rotate(${(-flight.playerHeadingDeg).toFixed(1)}deg)`;

        // 武器面板：当前选中武器高亮（is-selected 金色箭头）
        const sel = flight.selectedWeapon;
        gunValue.parentElement?.classList.toggle('is-selected', sel === 'gun');
        missileValue.parentElement?.classList.toggle('is-selected', sel === 'missile');
        specialValue.parentElement?.classList.toggle('is-selected', sel === 'special');
      } else {
        stallWarning.classList.remove('is-active');
        missileWarning.classList.remove('is-active');
        lockWarning.classList.remove('is-active');
        crashPanel.classList.remove('is-active');
        // 无飞行数据时重置准星状态与张合
        crosshair.classList.remove('is-locking', 'is-locked');
        crosshair.style.setProperty('--cs-spread', '26px');
        crosshair.style.setProperty('--cs-jitter', '0px');
      }

      // 鼠标教练标记兜底：flight 为 null（机库/简报）时同样复位
      if (stats.noseAim === null) {
        crosshair.style.left = '';
        crosshair.style.top = '';
        crosshair.classList.remove('is-aim-tracked');
      }
      if (stats.mouseAim === null) {
        aimCursor.style.display = 'none';
      }

      // 全目标屏幕标记：池化更新标记框/边缘箭头/来袭导弹
      updateMarkers(markerEls, stats.markers);

      // 锁定框：屏幕空间定位与状态样式
      updateLockBox(lockBox, lockLabel, stats.lock);

      // COD 得分弹出：池化写入（位置 + 得分文本 + 大小样式）
      updateScorePopups(scoreEls, stats.scorePopups);

      // 天气屏幕白闪：强度写入透明度（闪电时）
      weatherFlashEl.style.opacity = `${stats.weatherFlash.toFixed(3)}`;

      // 模拟事件反馈：命中标记与击毁提示
      let hasHit = false;
      let destroyedText: string | null = null;
      for (const event of stats.events) {
        if (event.type === 'gun-hit' || event.type === 'missile-hit') {
          hasHit = true;
        } else if (event.type === 'target-destroyed') {
          destroyedText =
            event.variant === 'enemy'
              ? '敌机击坠'
              : event.variant === 'bomber'
                ? '轰炸机击坠'
                : event.variant === 'ground-target-entity'
                  ? '地面目标摧毁'
                  : event.variant === 'ally'
                    ? '友军被击落！'
                    : '目标摧毁';
        } else if (event.type === 'special-launched') {
          destroyedText =
            event.weapon === 'multi-missile'
              ? '多目标导弹齐射！'
              : event.weapon === 'cluster-bomb'
                ? '集束炸弹投放！'
                : '远程导弹发射！';
        } else if (event.type === 'wingman-command') {
          destroyedText =
            event.command === 'attack'
              ? '僚机指令：进攻'
              : event.command === 'cover'
                ? '僚机指令：掩护'
                : '僚机指令：集合';
        } else if (event.type === 'weapon-switched') {
          destroyedText =
            event.weapon === 'gun'
              ? '切换：机炮'
              : event.weapon === 'missile'
                ? '切换：导弹'
                : '切换：特殊武器';
        } else if (event.type === 'lock-target-switched') {
          destroyedText = '目标切换';
        }
      }
      if (hasHit) {
        retriggerAnimation(hitmarker, 'is-active');
        // 命中时准星同步开火脉冲反馈
        retriggerAnimation(crosshair, 'is-firing');
      }
      if (destroyedText !== null) {
        killToast.textContent = destroyedText;
        retriggerAnimation(killToast, 'is-active');
      }
    },

    /**
     * 显示上下文丢失/致命错误遮罩
     *
     * @param message 可选自定义文案，缺省使用默认恢复提示
     */
    showContextLost(text?: string): void {
      message.textContent = text ?? DEFAULT_CONTEXT_LOST_MESSAGE;
      overlay.classList.add('is-visible');
    },

    /**
     * 隐藏上下文丢失遮罩
     */
    hideContextLost(): void {
      overlay.classList.remove('is-visible');
    },
  };
}

/**
 * 在状态条内创建单个统计项
 *
 * 功能：生成「label + value」的 DOM 结构并挂入状态条
 * @param strip 状态条容器
 * @param label 统计项名称
 * @returns 值元素（供后续更新 textContent）
 * 异常：无
 * 注意事项：仅供 createHud 内部使用
 */
function createStat(strip: HTMLElement, label: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'hud-stat';
  const labelEl = document.createElement('span');
  labelEl.className = 'hud-stat-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'hud-stat-value';
  valueEl.textContent = '--';
  item.appendChild(labelEl);
  item.appendChild(valueEl);
  strip.appendChild(item);
  return valueEl;
}

/**
 * 在武器面板内创建单行「label + value」
 *
 * 功能：生成武器/生存信息行并挂入面板
 * @param panel 武器面板容器
 * @param label 行名称
 * @param initial 初始值文案
 * @returns 值元素（供后续更新 textContent）
 * 异常：无
 * 注意事项：仅供 createHud 内部使用
 */
function createWeaponRow(panel: HTMLElement, label: string, initial: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'hud-weapon-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'hud-weapon-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'hud-weapon-value';
  valueEl.textContent = initial;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  panel.appendChild(row);
  return valueEl;
}

/**
 * 写入武器面板数值（弹药数 / 装填倒计时）
 *
 * 功能：装填中（reloadRemain 非空且弹药为 0）时显示琥珀色
 * "RLD 12s" 倒计时（替换数字位置）并挂 is-reloading 样式；
 * 装填完成恢复正常弹药数字；弹药为 0 且未装填（异常态）挂 is-empty
 * @param valueEl 武器行数值元素
 * @param ammo 当前弹药数
 * @param reloadRemain 装填剩余秒数（装填中为正数；未装填为 null）
 * @returns void
 * 异常：无
 * 注意事项：is-empty 与 is-reloading 互斥——装填中显示 RLD
 * 优先于打空告警
 */
function setWeaponValue(
  valueEl: HTMLElement,
  ammo: number,
  reloadRemain: number | null,
): void {
  const reloading = reloadRemain !== null && ammo <= 0;
  if (reloading) {
    valueEl.textContent = `RLD ${Math.ceil(reloadRemain)}s`;
  } else {
    valueEl.textContent = `${ammo}`;
  }
  valueEl.classList.toggle('is-reloading', reloading);
  valueEl.classList.toggle('is-empty', ammo <= 0 && !reloading);
}

/**
 * 更新雷达光点（heading-up 玩家朝向模式，池化 DOM 复用）
 *
 * 功能：将模拟层 north-up 雷达光点（米，东=x / 北=y）旋转
 * -玩家航向角 变换到机头朝上坐标系后映射到雷达像素坐标——
 * 玩家转向时全部光点随坐标系反向旋转（玩家箭头固定朝上）；
 * 不足时隐藏多余光点；敌机红、轰炸机紫红、友军蓝、僚机青、
 * 地面/靶标橙
 * @param blipEls 光点 DOM 池
 * @param blips 本帧雷达光点数据（米，north-up 固定方位坐标）
 * @param playerHeadingDeg 玩家航向角（度，0=正北顺时针）
 * @returns void
 * 异常：无
 * 注意事项：旋转公式——屏幕 x = 东·cos(-h) - 北·sin(-h)，
 * 屏幕 y 上 = 东·sin(-h) + 北·cos(-h)（h 为航向角）；
 * 滚转不影响（雷达为平面方位图）；超出池容量时截断
 */
function updateRadarBlipsHeadingUp(
  blipEls: readonly HTMLElement[],
  blips: readonly { x: number; y: number; kind: string }[],
  playerHeadingDeg: number,
): void {
  // 旋转角（弧度，负号=机头朝上坐标系相对北-up 的旋转）
  const rad = (-playerHeadingDeg * Math.PI) / 180;
  const cosH = Math.cos(rad);
  const sinH = Math.sin(rad);
  const count = Math.min(blips.length, blipEls.length);
  for (let i = 0; i < blipEls.length; i++) {
    const el = blipEls[i]!;
    if (i >= count) {
      el.style.display = 'none';
      continue;
    }
    const blip = blips[i]!;
    // 世界 east/north → 机头朝上坐标（x 右 / y 上）
    const rx = blip.x * cosH - blip.y * sinH;
    const ry = blip.x * sinH + blip.y * cosH;
    const px = (rx / RADAR_RANGE_M) * RADAR_RADIUS_PX;
    const py = -(ry / RADAR_RANGE_M) * RADAR_RADIUS_PX;
    el.style.display = 'block';
    el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
    el.classList.toggle('is-enemy', blip.kind === 'enemy');
    el.classList.toggle('is-bomber', blip.kind === 'bomber');
    el.classList.toggle('is-ally', blip.kind === 'ally');
    el.classList.toggle('is-wingman', blip.kind === 'wingman');
    el.classList.toggle('is-ground', blip.kind === 'ground' || blip.kind === 'target');
  }
}

/**
 * 更新 COD 风格得分弹出（池化 DOM 复用）
 *
 * 功能：将得分弹出列表写入 DOM 池——设置位置与文本，挂 kill
 * 大号金色 / hit 小号白色样式，重放向上飘 40px + 淡出 0.8s 的
 * CSS 动画；同帧多命中按池序天然错开位置
 * @param scoreEls 得分弹出 DOM 池
 * @param popups 本帧得分弹出列表
 * @returns void
 * 异常：无
 * 注意事项：DOM 池 8 个循环复用；重放动画用 retriggerAnimation
 */
function updateScorePopups(
  scoreEls: readonly HTMLElement[],
  popups: readonly { screenX: number; screenY: number; text: string; kill: boolean }[],
): void {
  const count = Math.min(popups.length, scoreEls.length);
  for (let i = 0; i < scoreEls.length; i++) {
    const el = scoreEls[i]!;
    if (i >= count) {
      el.style.display = 'none';
      continue;
    }
    const popup = popups[i]!;
    el.style.display = 'block';
    el.style.left = `${popup.screenX.toFixed(0)}px`;
    el.style.top = `${popup.screenY.toFixed(0)}px`;
    el.textContent = popup.text;
    el.classList.toggle('is-kill', popup.kill);
    el.classList.toggle('is-hit', !popup.kill);
    retriggerAnimation(el, 'is-active');
  }
}

/**
 * 更新全目标屏幕标记（池化 DOM 复用）
 *
 * 功能：按标记数据写入标记池——视线内目标显示小标记框+距离文本；
 * 出屏目标隐藏标记框、显示贴边箭头（按 edgeAngleDeg 旋转指向
 * 转向方向）+距离；来袭导弹为红色高威胁标记（闪烁 + MSL 字样）；
 * 按种类着色（敌机红/轰炸机紫/友军蓝/僚机青/地面橙/导弹红闪）
 * @param markerEls 标记 DOM 池
 * @param markers 本帧标记数据
 * @returns void
 * 异常：无
 * 注意事项：标记元素 translate(-50%,-50%) 居中于目标位置；
 * 边缘箭头位置由 main.ts 计算并写入 screenX/screenY
 */
function updateMarkers(
  markerEls: readonly {
    root: HTMLElement;
    box: HTMLElement;
    arrow: HTMLElement;
    text: HTMLElement;
  }[],
  markers: readonly HudTargetMarker[],
): void {
  const count = Math.min(markers.length, markerEls.length);
  for (let i = 0; i < markerEls.length; i++) {
    const widgets = markerEls[i]!;
    if (i >= count) {
      widgets.root.style.display = 'none';
      continue;
    }
    const marker = markers[i]!;
    widgets.root.style.display = 'block';
    widgets.root.style.left = `${marker.screenX.toFixed(0)}px`;
    widgets.root.style.top = `${marker.screenY.toFixed(0)}px`;

    // 视线内=标记框+距离；出屏=贴边箭头
    widgets.box.style.display = marker.onScreen ? 'block' : 'none';
    widgets.arrow.style.display = marker.onScreen ? 'none' : 'block';
    if (!marker.onScreen) {
      widgets.arrow.style.transform = `rotate(${marker.edgeAngleDeg.toFixed(0)}deg)`;
    }

    // 文本：视线内显示距离（出屏也显示距离辅助判断）；导弹显示 MSL
    widgets.text.textContent = marker.incoming
      ? `MSL ${marker.distance.toFixed(0)}m`
      : `${marker.distance.toFixed(0)}m`;

    // 种类与威胁样式
    const root = widgets.root;
    root.classList.toggle('is-enemy', marker.kind === 'enemy');
    root.classList.toggle('is-bomber', marker.kind === 'bomber');
    root.classList.toggle('is-ally', marker.kind === 'ally');
    root.classList.toggle('is-wingman', marker.kind === 'wingman');
    root.classList.toggle('is-ground', marker.kind === 'ground');
    root.classList.toggle('is-missile', marker.kind === 'missile' || marker.incoming);
    root.classList.toggle('is-offscreen', !marker.onScreen);
  }
}

/**
 * 更新屏幕空间锁定框（真实战机风格四角框）
 *
 * 功能：按锁定信息定位锁定框并切换状态样式——
 * locking=黄色四角框（L 形角标线）+LOCK 进度百分比；
 * locked=红色四角框+距离（米）与目标机型名（真实战机 HUD 风格）；
 * 无目标或目标出屏时隐藏
 * @param lockBox 锁定框元素（含四个 corner 子元素）
 * @param lockLabel 锁定框文案元素
 * @param lock 锁定定位数据（null=无目标）
 * @returns void
 * 异常：无
 * 注意事项：锁定框中心对齐目标屏幕坐标（CSS translate(-50%,-50%)）
 */
function updateLockBox(
  lockBox: HTMLElement,
  lockLabel: HTMLElement,
  lock: HudLockInfo | null,
): void {
  if (lock === null || lock.state === 'none' || !lock.onScreen) {
    lockBox.classList.remove('is-locking', 'is-locked');
    // 清空文案，避免下次锁定框重现瞬间闪现旧文本（如 LOCKED → LOCK 0%）
    lockLabel.textContent = '';
    return;
  }
  lockBox.style.left = `${lock.screenX.toFixed(0)}px`;
  lockBox.style.top = `${lock.screenY.toFixed(0)}px`;
  if (lock.state === 'locked') {
    lockBox.classList.remove('is-locking');
    lockBox.classList.add('is-locked');
    // 真实战机风格：型号名 + 距离（米）
    const nameText = lock.targetName.length > 0 ? lock.targetName : 'TGT';
    lockLabel.textContent = `${nameText} ${lock.distance.toFixed(0)}m`;
  } else {
    lockBox.classList.remove('is-locked');
    lockBox.classList.add('is-locking');
    lockLabel.textContent = `LOCK ${Math.round(lock.progress * 100)}%`;
  }
}
