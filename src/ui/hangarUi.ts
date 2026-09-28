import { fighters } from '../config';
import { saveUserSettings, userSettings } from '../core/settingsStore';

/** 机库界面控制接口 */
export interface HangarUi {
  /** 显示机库（选择机型后回调） */
  show(onSelect: (fighterId: string) => void): void;
  /** 隐藏机库界面 */
  hide(): void;
}

/**
 * 属性条数值辅助（机库对比表用）
 *
 * @param value 当前值
 * @param min 全机型最小值
 * @param max 全机型最大值
 * @returns 0..1 归一化比例
 * 异常：无
 */
function normalizeStat(value: number, min: number, max: number): number {
  if (max <= min) {
    return 1;
  }
  return (value - min) / (max - min);
}

/**
 * 创建机库选择界面
 *
 * 功能：构建全屏机库模态——三张机型卡片（代号/定位/描述/三围属性条
 * 对比 + 特殊武器说明 + 配色预览块 + 部署按钮）；
 * 选中卡片高亮，点部署回调机型 ID 进入任务
 * @param root HUD 根容器元素
 * @returns 机库控制接口
 * @throws 无（DOM 构建失败由浏览器抛出的异常向上冒泡）
 * 注意事项：3D 预览由渲染层驱动（本界面仅提供卡片配色示意）；
 * 机库为 pointer-events:auto 模态层
 */
export function createHangarUi(root: HTMLElement): HangarUi {
  const overlay = document.createElement('div');
  overlay.className = 'hangar-overlay';

  const title = document.createElement('div');
  title.className = 'hangar-title';
  title.textContent = '机库 · 选择你的座机';
  overlay.appendChild(title);

  const cards = document.createElement('div');
  cards.className = 'hangar-cards';

  /** 卡片元素映射（机型 ID → 卡片根元素） */
  const cardEls = new Map<string, HTMLElement>();

  for (const fighter of fighters) {
    const card = document.createElement('div');
    card.className = 'hangar-card';

    // 机型头部：代号 + 定位
    const header = document.createElement('div');
    header.className = 'hangar-card-header';
    const nameEl = document.createElement('div');
    nameEl.className = 'hangar-card-name';
    nameEl.textContent = fighter.name;
    const roleEl = document.createElement('div');
    roleEl.className = 'hangar-card-role';
    roleEl.textContent = fighter.role;
    header.appendChild(nameEl);
    header.appendChild(roleEl);
    card.appendChild(header);

    // 配色预览条（机体主色 + 强调色）
    const swatch = document.createElement('div');
    swatch.className = 'hangar-card-swatch';
    const swatchBody = document.createElement('div');
    swatchBody.className = 'hangar-swatch-body';
    swatchBody.style.background = `#${fighter.bodyColor.toString(16).padStart(6, '0')}`;
    const swatchAccent = document.createElement('div');
    swatchAccent.className = 'hangar-swatch-accent';
    swatchAccent.style.background = `#${fighter.accentColor.toString(16).padStart(6, '0')}`;
    swatch.appendChild(swatchBody);
    swatch.appendChild(swatchAccent);
    card.appendChild(swatch);

    // 描述
    const descEl = document.createElement('p');
    descEl.className = 'hangar-card-desc';
    descEl.textContent = fighter.description;
    card.appendChild(descEl);

    // 三围属性条（速度/机动/装甲）
    const statsBlock = document.createElement('div');
    statsBlock.className = 'hangar-card-stats';
    appendStatBar(statsBlock, '速度', normalizeStat(fighter.stats.maxSpeed, 250, 350));
    appendStatBar(statsBlock, '机动', normalizeStat(fighter.stats.pitchRateMax, 1.2, 2.4));
    appendStatBar(statsBlock, '装甲', normalizeStat(fighter.stats.hp, 70, 170));
    card.appendChild(statsBlock);

    // 弹药基数行
    const ammoRow = document.createElement('div');
    ammoRow.className = 'hangar-card-ammo';
    ammoRow.textContent = `机炮 ${fighter.stats.gunAmmo} · 导弹 ${fighter.stats.missileAmmo} · 干扰弹 ${fighter.stats.flareCount}`;
    card.appendChild(ammoRow);

    // 特殊武器
    const specialEl = document.createElement('div');
    specialEl.className = 'hangar-card-special';
    specialEl.textContent = `特殊武器：${fighter.special.name} ×${fighter.special.ammo}`;
    card.appendChild(specialEl);

    // 部署按钮
    const deployBtn = document.createElement('button');
    deployBtn.className = 'hangar-deploy-button';
    deployBtn.type = 'button';
    deployBtn.textContent = '部署出击';
    card.appendChild(deployBtn);

    cards.appendChild(card);
    cardEls.set(fighter.id, card);
  }
  overlay.appendChild(cards);

  // ---- 输入设置面板（鼠标教练开关 + 手感滑条，即时生效并持久化） ----
  overlay.appendChild(createSettingsPanel());

  root.appendChild(overlay);

  return {
    /**
     * 显示机库
     *
     * @param onSelect 玩家选择机型后的回调（点击部署按钮触发）
     */
    show(onSelect): void {
      overlay.classList.add('is-visible');
      // 点击卡片 = 选中；点击部署按钮 = 确认出击
      for (const [fighterId, card] of cardEls) {
        const select = (): void => {
          for (const el of cardEls.values()) {
            el.classList.remove('is-selected');
          }
          card.classList.add('is-selected');
        };
        card.addEventListener('click', select);
        const btn = card.querySelector('.hangar-deploy-button');
        btn?.addEventListener('click', (event) => {
          event.stopPropagation();
          select();
          overlay.classList.remove('is-visible');
          onSelect(fighterId);
        });
      }
    },

    /**
     * 隐藏机库界面
     */
    hide(): void {
      overlay.classList.remove('is-visible');
    },
  };
}

/**
 * 追加单条属性对比条
 *
 * 功能：生成「label + 条形图」DOM 并挂入容器
 * @param container 属性块容器
 * @param label 属性名
 * @param ratio 0..1 归一化比例
 * @returns void
 * 异常：无
 */
function appendStatBar(container: HTMLElement, label: string, ratio: number): void {
  const row = document.createElement('div');
  row.className = 'hangar-stat-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'hangar-stat-label';
  labelEl.textContent = label;
  const bar = document.createElement('div');
  bar.className = 'hangar-stat-bar';
  const fill = document.createElement('div');
  fill.className = 'hangar-stat-fill';
  fill.style.width = `${Math.round(Math.min(Math.max(ratio, 0.05), 1) * 100)}%`;
  bar.appendChild(fill);
  row.appendChild(labelEl);
  row.appendChild(bar);
  container.appendChild(row);
}

/**
 * 构建输入设置面板（迭代12：鼠标教练手感调参）
 *
 * 功能：生成「鼠标教练瞄准」开关 + 追踪响应/微调方向舵两条滑条——
 * 变更即时写入 settingsStore（持久化 + 广播世界层/HUD 同步），
 * 数值标签实时显示当前倍率；面板随机库展示，任务内可用 M 键
 * 随时开关教练
 * @returns 设置面板根元素
 * 异常：无
 * 注意事项：滑条范围与 settingsStore 的字段级校验范围一致
 * （追踪响应 0.4..2 / 微舵 0..2），越界值由存储层钳制
 */
function createSettingsPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'hangar-settings';

  const title = document.createElement('div');
  title.className = 'hangar-settings-title';
  title.textContent = '输入设置 · 鼠标教练瞄准';
  panel.appendChild(title);

  // 开关行：鼠标教练瞄准
  const toggleRow = document.createElement('label');
  toggleRow.className = 'hangar-settings-toggle';
  const toggleBox = document.createElement('input');
  toggleBox.type = 'checkbox';
  toggleBox.checked = userSettings.mouseAimEnabled;
  const toggleText = document.createElement('span');
  toggleText.textContent = '鼠标教练瞄准（光标指哪飞哪，M 键随时开关）';
  toggleRow.appendChild(toggleBox);
  toggleRow.appendChild(toggleText);
  toggleBox.addEventListener('change', () => {
    saveUserSettings({ mouseAimEnabled: toggleBox.checked });
  });
  panel.appendChild(toggleRow);

  // 滑条行：追踪响应（教练拉杆/滚转增益倍率）
  panel.appendChild(
    createSliderRow('追踪响应', 0.4, 2, 0.1, () => userSettings.pursuitResponse, (value) => {
      saveUserSettings({ pursuitResponse: value });
    }),
  );
  // 滑条行：微调方向舵（末端对准修正量）
  panel.appendChild(
    createSliderRow('微调方向舵', 0, 2, 0.1, () => userSettings.rudderAssist, (value) => {
      saveUserSettings({ rudderAssist: value });
    }),
  );

  return panel;
}

/**
 * 构建单条「label + 滑条 + 数值」设置行
 *
 * @param label 设置项名称
 * @param min 滑条下限
 * @param max 滑条上限
 * @param step 步长
 * @param read 当前值读取器
 * @param write 变更写入回调
 * @returns 设置行元素
 */
function createSliderRow(
  label: string,
  min: number,
  max: number,
  step: number,
  read: () => number,
  write: (value: number) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'hangar-settings-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'hangar-settings-label';
  labelEl.textContent = label;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(read());
  const valueEl = document.createElement('span');
  valueEl.className = 'hangar-settings-value';
  valueEl.textContent = `×${read().toFixed(1)}`;
  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    if (Number.isFinite(value)) {
      valueEl.textContent = `×${value.toFixed(1)}`;
      write(value);
    }
  });
  row.appendChild(labelEl);
  row.appendChild(slider);
  row.appendChild(valueEl);
  return row;
}
