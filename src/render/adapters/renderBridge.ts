import { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { SimulationWorld } from '../../simulation';
import { createEntityMesh } from '../objects/meshes';

/**
 * 渲染桥：模拟实体 → Three.js 场景对象的同步适配器
 *
 * 功能：每渲染帧按插值系数 alpha 在实体 prev/curr 状态间插值，
 * 并同步到对应的 Object3D；实体首次出现时按类别/变体创建渲染网格，
 * 消失/死亡时移除渲染对象并释放 GPU 资源；
 * 战机实体的尾焰亮度按油门实时调节。
 * 注意事项：本类是渲染层读取模拟状态的唯一入口，
 * 保证“模拟状态不驻留于 Three.js 对象”的架构边界
 */
export class RenderBridge {
  /** 模拟实体 ID → 渲染对象 的映射 */
  private readonly objects = new Map<number, Object3D>();
  /** 所有实体渲染对象统一挂载的组（加入场景便于整体管理） */
  readonly group = new Group();

  /**
   * 同步世界状态到渲染对象
   *
   * 功能：遍历存活实体，按 alpha 在 prev/curr 间插值更新位置与姿态；
   * 新实体创建渲染网格，已消失实体的渲染对象被移除并释放
   * @param world 模拟世界（只读访问）
   * @param alpha 插值系数 ∈ [0,1)
   * @returns void
   * 异常：无（单个对象创建失败不应中断整帧同步）
   * 注意事项：每渲染帧调用一次；插值保证 60Hz 模拟在任意刷新率下平滑
   */
  syncFrom(world: SimulationWorld, alpha: number): void {
    const seen = new Set<number>();
    for (const entity of world.getEntities()) {
      if (!entity.alive) {
        continue;
      }
      seen.add(entity.id);
      let obj = this.objects.get(entity.id);
      if (obj === undefined) {
        obj = createEntityMesh(entity);
        this.objects.set(entity.id, obj);
        this.group.add(obj);
      }
      // 线性插值位置、球面插值姿态（避免万向节问题，姿态连续平滑）
      obj.position.lerpVectors(entity.prevPosition, entity.position, alpha);
      obj.quaternion.slerpQuaternions(entity.prevQuaternion, entity.quaternion, alpha);

      // 战机尾焰亮度随油门调节（渲染表现读取模拟油门状态）
      if (entity.aircraft !== undefined) {
        const exhaust = obj.userData['exhaustMaterial'];
        if (exhaust instanceof MeshStandardMaterial) {
          exhaust.emissiveIntensity = 0.4 + entity.aircraft.throttle * 3.2;
        }
      }
    }
    // 移除并释放已消失实体的渲染对象
    for (const [id, obj] of this.objects) {
      if (!seen.has(id)) {
        this.group.remove(obj);
        this.disposeObject(obj);
        this.objects.delete(id);
      }
    }
  }

  /**
   * 获取实体对应的插值渲染对象
   *
   * 功能：供相机等渲染层组件读取实体在当前渲染帧的插值位姿
   * @param id 模拟实体 ID
   * @returns 渲染对象；实体尚无渲染对象（未出现或已消亡）时返回 undefined
   * 异常：无
   * 注意事项：返回对象的 position/quaternion 已是本帧插值结果，
   * 直接读取即可，勿在渲染前再行修改
   */
  getObject(id: number): Object3D | undefined {
    return this.objects.get(id);
  }

  /**
   * 释放渲染对象及其 GPU 资源（私有）
   *
   * 功能：递归遍历对象子树，销毁全部网格的几何体与材质
   * @param obj 待释放的渲染对象
   * @returns void
   * 异常：无
   * 注意事项：材质可能为数组（多材质网格），需分别释放
   */
  private disposeObject(obj: Object3D): void {
    obj.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) {
          for (const m of material) {
            m.dispose();
          }
        } else {
          material.dispose();
        }
      }
    });
  }

  /**
   * 释放全部渲染对象
   *
   * 功能：移除并释放桥接的全部渲染对象与 GPU 资源，清空映射
   * 参数：无
   * 返回值：void
   * 异常：无
   * 注意事项：仅在应用销毁时调用（页面卸载/重建渲染器）
   */
  dispose(): void {
    for (const obj of this.objects.values()) {
      this.group.remove(obj);
      this.disposeObject(obj);
    }
    this.objects.clear();
  }
}
