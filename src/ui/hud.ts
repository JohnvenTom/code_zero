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

  // ---- 中央准星 ----
  const crosshair = document.createElement('div');
  crosshair.className = 'hud-crosshair';
  const crosshairDot = document.createElement('div');
  crosshairDot.className = 'hud-crosshair-dot';
  crosshair.appendChild(crosshairDot);
  root.appendChild(crosshair);

  // ---- 命中标记（准星处的 X 形闪现） ----
  const hitmarker = document.createElement('div');
  hitmarker.className = 'hud-hitmarker';
  root.appendChild(hitmarker);

  // ---- 击毁提示（准星上方短暂浮现） ----
  const killToast = document.createElement('div');
  killToast.className = 'hud-kill-toast';
  root.appendChild(killToast);

  // ---- G 值读数（准星下方） ----
  const gReadout = document.createElement('div');
  gReadout.className = 'hud-g';
  gReadout.textContent = 'G 1.0';
  root.appendChild(gReadout);

  // ---- 左侧速度/油门面板 ----
  const speedPanel = document.createElement('div');
  speedPanel.className = 'hud-panel hud-speed';
  const speedLabel = document.createElement('div');
  speedLabel.className = 'hud-panel-label';
  speedLabel.textContent = 'SPD km/h';
  const speedValue = document.createElement('div');
  speedValue.className = 'hud-panel-value';
  speedValue.textContent = '0';
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
  crashHint.textContent = '按 R 键重置到跑道';
  crashPanel.appendChild(crashTitle);
  crashPanel.appendChild(crashHint);
  root.appendChild(crashPanel);

  // ---- 底部操作提示（迭代8 键位重映射后文案） ----
  const chip = document.createElement('div');
  chip.className = 'hud-hint-chip';
  chip.textContent =
    'W/S 油门 · ↑↓ 俯仰 · A/D 踩舵 · 小键盘4/6 滚转 · 空格 机炮 · F 导弹 · Q 特殊 · C 僚机 · E 干扰弹 · R 重置';
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
        gunValue.textContent = `${flight.ammo}`;
        missileValue.textContent = `${flight.missileAmmo}`;
        flareValue.textContent = `${flight.flareCount}`;
        specialValue.textContent = `${flight.specialAmmo}`;
        hpValue.textContent = `${Math.max(0, Math.round(flight.hp))}`;
        const commandText =
          flight.wingmanCommand === 'attack'
            ? '进攻'
            : flight.wingmanCommand === 'cover'
              ? '掩护'
              : '集合';
        wingmanValue.textContent = `${flight.wingmenAlive}/${flight.wingmenTotal} ${commandText}`;
        enemyValue.textContent = `${flight.enemyKills}`;

        gReadout.classList.toggle('is-high', flight.gLoad >= G_WARN_THRESHOLD);
        gReadout.classList.toggle('is-negative', flight.gLoad < -0.5);
        gunValue.classList.toggle('is-empty', flight.ammo <= 0);
        missileValue.classList.toggle('is-empty', flight.missileAmmo <= 0);
        flareValue.classList.toggle('is-empty', flight.flareCount <= 0);
        specialValue.classList.toggle('is-empty', flight.specialAmmo <= 0);
        hpValue.classList.toggle('is-low', flight.hp <= flight.hpMax * 0.3);
        stallWarning.classList.toggle('is-active', flight.stalled && flight.alive);
        missileWarning.classList.toggle('is-active', flight.missileWarning && flight.alive);
        lockWarning.classList.toggle(
          'is-active',
          flight.lockWarning && !flight.missileWarning && flight.alive,
        );
        crashPanel.classList.toggle('is-active', !flight.alive);

        // 雷达光点：池化更新位置与显隐（north-up 固定方位）
        updateRadarBlips(radarBlips, flight.radarBlips);
        // 玩家航向箭头：绕雷达中心随机头方向旋转（0=正北顺时针）
        radarHeading.style.transform = `rotate(${flight.playerHeadingDeg.toFixed(1)}deg)`;
      } else {
        stallWarning.classList.remove('is-active');
        missileWarning.classList.remove('is-active');
        lockWarning.classList.remove('is-active');
        crashPanel.classList.remove('is-active');
      }

      // 全目标屏幕标记：池化更新标记框/边缘箭头/来袭导弹
      updateMarkers(markerEls, stats.markers);

      // 锁定框：屏幕空间定位与状态样式
      updateLockBox(lockBox, lockLabel, stats.lock);

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
        }
      }
      if (hasHit) {
        retriggerAnimation(hitmarker, 'is-active');
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
 * 更新雷达光点（池化 DOM 复用）
 *
 * 功能：将模拟层 north-up 雷达光点（米，东=x / 北=y）映射到雷达
 * 像素坐标并写入光点池——北（y 正）映射为屏幕上方（负 y 偏移）；
 * 不足时隐藏多余光点；敌机红、轰炸机紫红、友军蓝、僚机青、
 * 地面/靶标橙
 * @param blipEls 光点 DOM 池
 * @param blips 本帧雷达光点数据（米，north-up 固定方位坐标）
 * @returns void
 * 异常：无
 * 注意事项：光点按固定世界方位放置，不随玩家航向/滚转变化；
 * 超出池容量时截断（数量远小于池容量）
 */
function updateRadarBlips(
  blipEls: readonly HTMLElement[],
  blips: readonly { x: number; y: number; kind: string }[],
): void {
  const count = Math.min(blips.length, blipEls.length);
  for (let i = 0; i < blipEls.length; i++) {
    const el = blipEls[i]!;
    if (i >= count) {
      el.style.display = 'none';
      continue;
    }
    const blip = blips[i]!;
    // 东(+x)=屏幕右，北(+y)=屏幕上（负 y 偏移）
    const px = (blip.x / RADAR_RANGE_M) * RADAR_RADIUS_PX;
    const py = -(blip.y / RADAR_RANGE_M) * RADAR_RADIUS_PX;
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
