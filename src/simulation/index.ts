/**
 * simulation 层入口：统一导出模拟层公共类型
 *
 * 边界约定：本层只包含纯模拟状态与规则（飞行模型/武器/AI/任务进度），
 * 严禁持有 Three.js 场景对象（Mesh/Object3D/Scene 等）；
 * 允许使用 three 的纯数学类（Vector3/Quaternion/Matrix4）承载状态计算，
 * 因其不依赖 WebGL/DOM/场景图。
 */
export * from './entity';
export * from './components';
export * from './events';
export * from './flightModel';
export * from './instructor';
export * from './gunSystem';
export * from './missileSystem';
export * from './flareSystem';
export * from './enemyAI';
export * from './mission';
export * from './specialWeaponSystem';
export * from './world';
