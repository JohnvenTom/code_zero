import { campaignMission1 } from '../config';
import type { MissionPhaseSnapshot, MissionResult } from '../simulation';

/** 任务配置的模块级引用 */
const missionCfg = campaignMission1;

/** 目标类型的显示文案 */
const OBJECTIVE_LABELS: Record<string, string> = {
  'kill-enemies': '击坠敌机',
  'destroy-ground': '摧毁地面目标',
  'intercept-bombers': '拦截轰炸机',
  'protect-allies': '护卫友军存活',
};

/**
 * 任务界面控制接口
 */
export interface MissionUi {
  /** 显示任务简报（等待玩家点击开始，回调通知 main.ts 启动任务） */
  showBriefing(onStart: () => void): void;
  /** 隐藏简报界面 */
  hideBriefing(): void;
  /** 每帧刷新任务 HUD（阶段目标进度 + 倒计时） */
  updateHud(phase: MissionPhaseSnapshot | null, missionTimeRemaining: number): void;
  /** 隐藏任务 HUD（任务结束/重开时） */
  hideHud(): void;
  /** 显示结算界面（胜/负），重开按钮回调通知 main.ts */
  showResult(result: MissionResult, onRestart: () => void): void;
  /** 隐藏结算界面 */
  hideResult(): void;
}

/**
 * 创建任务界面（简报 / 任务 HUD / 结算）
 *
 * 功能：在 HUD 根容器内构建三块任务相关 DOM——
 * 1) 全屏任务简报：任务名 + 逐段叙事 + 开始按钮（点击后回调）；
 * 2) 顶部任务 HUD：阶段标题 + 目标进度行 + 任务总倒计时（右上角）；
 * 3) 全屏结算界面：胜负标题 + 失败原因 + 得分/评价/击坠/用时统计
 *    + 重开按钮。
 * @param root HUD 根容器元素（index.html 中的 #hud-root）
 * @returns 任务界面控制接口
 * @throws 无（DOM 构建失败由浏览器抛出的异常向上冒泡）
 * 注意事项：简报与结算界面为 pointer-events:auto 的模态层，
 * 任务 HUD 为 pointer-events:none 覆盖信息；
 * 结算数据在 showResult 调用时一次性写入
 */
export function createMissionUi(root: HTMLElement): MissionUi {
  // ---- 任务简报界面（默认隐藏） ----
  const briefingOverlay = document.createElement('div');
  briefingOverlay.className = 'mission-overlay mission-briefing';
  const briefingCard = document.createElement('div');
  briefingCard.className = 'mission-card';
  const briefingTitle = document.createElement('div');
  briefingTitle.className = 'mission-card-title';
  briefingTitle.textContent = missionCfg.name;
  briefingCard.appendChild(briefingTitle);
  for (const paragraph of missionCfg.briefing) {
    const line = document.createElement('p');
    line.className = 'mission-briefing-line';
    line.textContent = paragraph;
    briefingCard.appendChild(line);
  }
  const briefingHint = document.createElement('div');
  briefingHint.className = 'mission-briefing-hint';
  briefingHint.textContent = '起飞准备就绪 · 点击开始任务后推满油门（W）滑跑起飞';
  briefingCard.appendChild(briefingHint);
  const startButton = document.createElement('button');
  startButton.className = 'mission-button';
  startButton.type = 'button';
  startButton.textContent = '开始任务';
  briefingCard.appendChild(startButton);
  briefingOverlay.appendChild(briefingCard);
  root.appendChild(briefingOverlay);

  // ---- 任务 HUD：顶部阶段目标 + 右上倒计时 ----
  const hud = document.createElement('div');
  hud.className = 'mission-hud';
  const phaseTitle = document.createElement('div');
  phaseTitle.className = 'mission-hud-title';
  hud.appendChild(phaseTitle);
  const objectiveList = document.createElement('div');
  objectiveList.className = 'mission-hud-objectives';
  hud.appendChild(objectiveList);
  root.appendChild(hud);

  const timer = document.createElement('div');
  timer.className = 'mission-timer';
  root.appendChild(timer);

  // 目标行 DOM 池（按需重建，阶段切换时刷新）
  let objectiveRows: { row: HTMLElement; value: HTMLElement }[] = [];

  // ---- 结算界面（默认隐藏） ----
  const resultOverlay = document.createElement('div');
  resultOverlay.className = 'mission-overlay mission-result';
  const resultCard = document.createElement('div');
  resultCard.className = 'mission-card';
  const resultTitle = document.createElement('div');
  resultTitle.className = 'mission-card-title mission-result-title';
  resultCard.appendChild(resultTitle);
  const resultReason = document.createElement('div');
  resultReason.className = 'mission-result-reason';
  resultCard.appendChild(resultReason);
  const resultStats = document.createElement('div');
  resultStats.className = 'mission-result-stats';
  resultCard.appendChild(resultStats);
  const restartButton = document.createElement('button');
  restartButton.className = 'mission-button';
  restartButton.type = 'button';
  restartButton.textContent = '重开任务';
  resultCard.appendChild(restartButton);
  resultOverlay.appendChild(resultCard);
  root.appendChild(resultOverlay);

  return {
    /**
     * 显示任务简报
     *
     * @param onStart 玩家点击开始按钮后的回调
     */
    showBriefing(onStart: () => void): void {
      const handler = (): void => {
        startButton.removeEventListener('click', handler);
        briefingOverlay.classList.remove('is-visible');
        onStart();
      };
      startButton.addEventListener('click', handler);
      briefingOverlay.classList.add('is-visible');
    },

    /**
     * 隐藏简报界面
     */
    hideBriefing(): void {
      briefingOverlay.classList.remove('is-visible');
    },

    /**
     * 刷新任务 HUD
     *
     * 功能：按阶段快照重建/更新目标进度行（含完成勾选样式），
     * 更新阶段标题与任务总倒计时（剩余<60s 变红闪烁）
     * @param phase 当前阶段快照（null=任务未激活，隐藏 HUD）
     * @param missionTimeRemaining 任务总剩余时间（秒）
     */
    updateHud(phase: MissionPhaseSnapshot | null, missionTimeRemaining: number): void {
      if (phase === null) {
        hud.classList.remove('is-visible');
        timer.classList.remove('is-visible');
        return;
      }
      hud.classList.add('is-visible');
      timer.classList.add('is-visible');

      // 阶段标题
      if (phaseTitle.textContent !== phase.title) {
        phaseTitle.textContent = phase.title;
        objectiveRows = [];
        objectiveList.innerHTML = '';
      }

      // 目标行：数量变化时重建，否则仅更新数值
      if (objectiveRows.length !== phase.objectives.length) {
        objectiveList.innerHTML = '';
        objectiveRows = phase.objectives.map(() => {
          const row = document.createElement('div');
          row.className = 'mission-hud-objective';
          const label = document.createElement('span');
          label.className = 'mission-hud-objective-label';
          row.appendChild(label);
          const value = document.createElement('span');
          value.className = 'mission-hud-objective-value';
          row.appendChild(value);
          objectiveList.appendChild(row);
          return { row, value };
        });
      }
      phase.objectives.forEach((objective, i) => {
        const widgets = objectiveRows[i]!;
        const labelEl = widgets.row.firstElementChild as HTMLElement;
        labelEl.textContent = OBJECTIVE_LABELS[objective.type] ?? objective.type;
        widgets.value.textContent = `${objective.current}/${objective.required}`;
        widgets.row.classList.toggle('is-done', objective.done);
      });

      // 任务总倒计时
      const minutes = Math.floor(missionTimeRemaining / 60);
      const seconds = Math.floor(missionTimeRemaining % 60);
      timer.textContent = `⏱ ${minutes}:${seconds.toString().padStart(2, '0')}`;
      timer.classList.toggle('is-urgent', missionTimeRemaining < 60);
    },

    /**
     * 隐藏任务 HUD
     */
    hideHud(): void {
      hud.classList.remove('is-visible');
      timer.classList.remove('is-visible');
    },

    /**
     * 显示结算界面
     *
     * 功能：写入胜负标题（胜利=金色"任务完成"，失败=红色失败原因）、
     * 得分/评价/击坠（战斗机+轰炸机）/摧毁/用时统计行，
     * 绑定重开按钮回调
     * @param result 任务结算结果
     * @param onRestart 玩家点击重开按钮后的回调
     */
    showResult(result: MissionResult, onRestart: () => void): void {
      resultTitle.textContent = result.victory ? '任务完成' : '任务失败';
      resultTitle.classList.toggle('is-victory', result.victory);
      resultTitle.classList.toggle('is-failed', !result.victory);
      const reasonText =
        result.failureReason === 'player-destroyed'
          ? '座机被击落'
          : result.failureReason === 'timeout'
            ? '任务超时'
            : result.failureReason === 'allies-destroyed'
              ? '护卫对象全部损毁'
              : '';
      resultReason.textContent = result.victory ? '' : `失败原因：${reasonText}`;
      resultReason.style.display = result.victory ? 'none' : 'block';

      const minutes = Math.floor(result.timeUsed / 60);
      const seconds = Math.floor(result.timeUsed % 60);
      resultStats.innerHTML = '';
      const rows: [string, string][] = [
        ['总得分', `${result.score}`],
        ['评价', result.grade],
        ['击坠敌机', `${result.enemyKills}`],
        ['击坠轰炸机', `${result.bomberKills}`],
        ['摧毁地面目标', `${result.groundKills}`],
        ['任务用时', `${minutes}分${seconds.toString().padStart(2, '0')}秒`],
      ];
      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'mission-result-stat-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'mission-result-stat-label';
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'mission-result-stat-value';
        valueEl.textContent = value;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        resultStats.appendChild(row);
      }

      const handler = (): void => {
        restartButton.removeEventListener('click', handler);
        resultOverlay.classList.remove('is-visible');
        onRestart();
      };
      restartButton.addEventListener('click', handler);
      resultOverlay.classList.add('is-visible');
    },

    /**
     * 隐藏结算界面
     */
    hideResult(): void {
      resultOverlay.classList.remove('is-visible');
    },
  };
}
