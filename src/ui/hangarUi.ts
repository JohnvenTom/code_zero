import { fighters } from '../config';

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
