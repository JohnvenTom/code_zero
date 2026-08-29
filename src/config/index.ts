/**
 * config 层入口：统一导出数据驱动配置表
 *
 * 边界约定：本层只存放纯数据与常量，不包含任何逻辑；
 * 战机、武器、任务等配置表将在后续任务中追加于此。
 */
export * from './gameConfig';
export * from './missionConfig';
export * from './fighterConfig';
