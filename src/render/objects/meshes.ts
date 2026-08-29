import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { getFighterById } from '../../config';
import type { SimEntity } from '../../simulation';

/**
 * 战机配色方案
 *
 * 功能：以数据驱动方式描述低模战机的分区配色，
 * 玩家/敌方/僚机共用同一网格工厂、不同配色
 */
interface FighterPalette {
  /** 机身主色 */
  readonly body: number;
  /** 机翼/垂尾强调色 */
  readonly accent: number;
  /** 座舱盖色 */
  readonly canopy: number;
  /** 深色部件（尾喷管等） */
  readonly dark: number;
}

/** 玩家战机配色（机型未指定时的兜底：青绿强调） */
const PLAYER_PALETTE: FighterPalette = {
  body: 0x7f96a8,
  accent: 0x2fb999,
  canopy: 0x16323f,
  dark: 0x2c343c,
};

/** 敌方战机配色（暗红强调，供后续迭代使用） */
const ENEMY_PALETTE: FighterPalette = {
  body: 0x8a7f7f,
  accent: 0xd95555,
  canopy: 0x33201e,
  dark: 0x32292b,
};

/**
 * 创建程序化低模战机网格
 *
 * 功能：以基础几何体拼装战机——机身盒 + 四棱锥机头 + 座舱盖 +
 * 后掠主翼（左右各一）+ 垂尾 + 平尾 + 尾喷管与随油门发光的尾焰；
 * 全部平面着色呈现低多边形街机观感
 * @param palette 战机配色方案
 * @returns 战机网格组（机头朝 -Z，符合项目前向约定；
 *   userData.exhaustMaterial 为尾焰发光材质，供渲染桥按油门调节亮度）
 * 异常：无
 * 注意事项：整机长约 15 米、翼展约 11 米，与命中判定尺度一致；
 * 后续可整体替换为 GLB 资产而不影响模拟层
 */
function createFighterMesh(palette: FighterPalette): Group {
  const group = new Group();

  const bodyMat = new MeshStandardMaterial({ color: palette.body, flatShading: true, roughness: 0.6 });
  const accentMat = new MeshStandardMaterial({ color: palette.accent, flatShading: true, roughness: 0.6 });
  const canopyMat = new MeshStandardMaterial({
    color: palette.canopy,
    flatShading: true,
    roughness: 0.25,
    metalness: 0.4,
  });
  const darkMat = new MeshStandardMaterial({ color: palette.dark, flatShading: true, roughness: 0.8 });

  // 机身：细长盒（-Z 为机头方向，长约 11 米）
  const fuselage = new Mesh(new BoxGeometry(2.0, 1.8, 11), bodyMat);
  fuselage.position.set(0, 0, 0.5);
  group.add(fuselage);

  // 机头：四棱锥（锥顶朝 -Z），叠在机身前端
  const noseGeo = new ConeGeometry(1.0, 4.5, 4);
  noseGeo.rotateX(-Math.PI / 2);
  noseGeo.rotateZ(Math.PI / 4);
  const nose = new Mesh(noseGeo, bodyMat);
  nose.position.set(0, 0, -7.25);
  group.add(nose);

  // 座舱盖：机身前上部的小盒
  const canopy = new Mesh(new BoxGeometry(1.1, 0.7, 2.6), canopyMat);
  canopy.position.set(0, 1.05, -2.2);
  group.add(canopy);

  // 主翼：左右后掠（外翼尖偏向机尾方向）
  const wingGeo = new BoxGeometry(5.4, 0.22, 2.6);
  const leftWing = new Mesh(wingGeo, accentMat);
  leftWing.position.set(-3.2, 0.1, 1.1);
  leftWing.rotation.y = 0.32;
  group.add(leftWing);
  const rightWing = new Mesh(wingGeo, accentMat);
  rightWing.position.set(3.2, 0.1, 1.1);
  rightWing.rotation.y = -0.32;
  group.add(rightWing);

  // 垂尾：后上部、顶部后掠
  const fin = new Mesh(new BoxGeometry(0.22, 2.4, 1.8), accentMat);
  fin.position.set(0, 1.5, 5.0);
  fin.rotation.x = 0.3;
  group.add(fin);

  // 平尾
  const stabilizer = new Mesh(new BoxGeometry(4.6, 0.18, 1.4), bodyMat);
  stabilizer.position.set(0, 0.2, 5.3);
  group.add(stabilizer);

  // 尾喷管
  const nozzle = new Mesh(new CylinderGeometry(0.55, 0.7, 1.2, 8), darkMat);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0, 6.5);
  group.add(nozzle);

  // 尾焰：自发光材质，亮度随油门由渲染桥调节
  const exhaustMat = new MeshStandardMaterial({
    color: 0x1a1208,
    emissive: 0xff8c3a,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.9,
  });
  const exhaust = new Mesh(new CylinderGeometry(0.32, 0.5, 1.6, 8), exhaustMat);
  exhaust.rotation.x = Math.PI / 2;
  exhaust.position.set(0, 0, 7.3);
  group.add(exhaust);
  group.userData.exhaustMaterial = exhaustMat;

  return group;
}

/**
 * 创建空中练习靶标网格
 *
 * 功能：拼装静态练习靶标——橙色球体主体 + 深色线框经纬罩 +
 * 浅色赤道环，远距离亦可辨识
 * @returns 靶标网格组（半径约 9 米，与命中判定半径匹配）
 * 异常：无
 * 注意事项：靶标为静态实体，无 userData 动态部件
 */
function createPracticeTargetMesh(): Group {
  const group = new Group();

  const balloon = new Mesh(
    new SphereGeometry(9, 14, 10),
    new MeshStandardMaterial({ color: 0xff8c42, flatShading: true, roughness: 0.7 }),
  );
  group.add(balloon);

  const cage = new Mesh(
    new SphereGeometry(9.35, 8, 6),
    new MeshBasicMaterial({ color: 0x20262b, wireframe: true }),
  );
  group.add(cage);

  const ring = new Mesh(
    new TorusGeometry(12.5, 0.5, 6, 24),
    new MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.6 }),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  return group;
}

/**
 * 创建曳光弹网格
 *
 * 功能：生成沿 -Z 拉长的自发光小盒，作为机炮弹道曳光的可视化
 * @returns 曳光网格（长 5 米，姿态由实体四元数驱动对齐弹道）
 * 异常：无
 * 注意事项：MeshBasicMaterial 不受光照/雾衰影响过强，近距离明亮可读
 */
function createTracerMesh(): Mesh {
  return new Mesh(
    new BoxGeometry(0.3, 0.3, 5),
    new MeshBasicMaterial({ color: 0xffd166 }),
  );
}

/**
 * 创建导弹网格
 *
 * 功能：拼装导弹外观——细长圆柱弹体 + 四棱锥弹头 + 尾部发光喷焰，
 * 弹轴沿 -Z（与弹道姿态约定一致）
 * @returns 导弹网格组（全长约 3.6 米）
 * 异常：无
 * 注意事项：喷焰为自发光材质，保证远距离可见性；
 * 弹体白色 + 橙色头部便于敌我导弹统一辨识（敌我区分由雷达/告警承担）
 */
function createMissileMesh(): Group {
  const group = new Group();

  const bodyMat = new MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.5, metalness: 0.3 });
  const noseGeo = new ConeGeometry(0.22, 0.8, 6);
  noseGeo.rotateX(-Math.PI / 2);
  const nose = new Mesh(noseGeo, new MeshStandardMaterial({ color: 0xd95f2b, roughness: 0.5 }));
  nose.position.set(0, 0, -2.1);
  group.add(nose);

  const body = new Mesh(new CylinderGeometry(0.22, 0.22, 2.6, 8), bodyMat);
  body.rotation.x = Math.PI / 2;
  body.position.set(0, 0, -0.4);
  group.add(body);

  const plume = new Mesh(
    new CylinderGeometry(0.14, 0.3, 1.1, 8),
    new MeshBasicMaterial({ color: 0xffb454 }),
  );
  plume.rotation.x = Math.PI / 2;
  plume.position.set(0, 0, 1.5);
  group.add(plume);

  return group;
}

/**
 * 创建干扰弹网格
 *
 * 功能：生成小尺寸自发光球体，模拟热诱干扰弹的明亮光点
 * @returns 干扰弹网格（半径 1 米）
 * 异常：无
 * 注意事项：高亮黄色发光材质，在天空/地面背景下均醒目；
 * 寿命内持续可见（约 3 秒），消亡由渲染桥随实体移除
 */
function createFlareMesh(): Mesh {
  return new Mesh(
    new SphereGeometry(1, 8, 6),
    new MeshBasicMaterial({ color: 0xffe08a }),
  );
}

/** 轰炸机配色（暗绿庞然大物） */
const BOMBER_PALETTE: FighterPalette = {
  body: 0x5a6b58,
  accent: 0x3d4a3c,
  canopy: 0x2a3328,
  dark: 0x242a24,
};

/** 友军运输机配色（蓝灰民航涂装） */
const ALLY_PALETTE: FighterPalette = {
  body: 0xb8c4cc,
  accent: 0x4a7fa8,
  canopy: 0x1e3440,
  dark: 0x37404a,
};

/** 僚机配色（青色友军涂装，与敌机红色区分） */
const WINGMAN_PALETTE: FighterPalette = {
  body: 0x8fb5c9,
  accent: 0x35c4b0,
  canopy: 0x16323f,
  dark: 0x2c343c,
};

/**
 * 创建轰炸机网格
 *
 * 功能：拼装大型轰炸机——宽机身 + 大后掠厚主翼 + 双垂尾 + 四短舱，
 * 体型显著大于战斗机，远距离可辨识
 * @returns 轰炸机网格组（全长约 30 米、翼展约 36 米）
 * 异常：无
 * 注意事项：与拦截目标视觉匹配（大慢目标）
 */
function createBomberMesh(): Group {
  const group = new Group();
  const scale = 2.0;

  const bodyMat = new MeshStandardMaterial({ color: BOMBER_PALETTE.body, flatShading: true, roughness: 0.7 });
  const accentMat = new MeshStandardMaterial({ color: BOMBER_PALETTE.accent, flatShading: true, roughness: 0.7 });
  const darkMat = new MeshStandardMaterial({ color: BOMBER_PALETTE.dark, flatShading: true, roughness: 0.8 });

  // 宽机身
  const fuselage = new Mesh(new BoxGeometry(3.2 * scale, 3.0 * scale, 12 * scale), bodyMat);
  fuselage.position.set(0, 0, 0.5 * scale);
  group.add(fuselage);

  // 机头（钝圆四棱锥）
  const noseGeo = new ConeGeometry(1.6 * scale, 4 * scale, 4);
  noseGeo.rotateX(-Math.PI / 2);
  noseGeo.rotateZ(Math.PI / 4);
  const nose = new Mesh(noseGeo, bodyMat);
  nose.position.set(0, 0, -8 * scale);
  group.add(nose);

  // 厚主翼（大后掠）
  const wingGeo = new BoxGeometry(7.5 * scale, 0.5 * scale, 3.6 * scale);
  const leftWing = new Mesh(wingGeo, accentMat);
  leftWing.position.set(-4.4 * scale, 0.2 * scale, 1.4 * scale);
  leftWing.rotation.y = 0.42;
  group.add(leftWing);
  const rightWing = new Mesh(wingGeo, accentMat);
  rightWing.position.set(4.4 * scale, 0.2 * scale, 1.4 * scale);
  rightWing.rotation.y = -0.42;
  group.add(rightWing);

  // 双垂尾
  for (const side of [-1, 1]) {
    const fin = new Mesh(new BoxGeometry(0.3 * scale, 2.6 * scale, 1.9 * scale), accentMat);
    fin.position.set(side * 1.4 * scale, 2.0 * scale, 5.2 * scale);
    fin.rotation.x = 0.3;
    group.add(fin);
  }

  // 平尾
  const stabilizer = new Mesh(new BoxGeometry(6.4 * scale, 0.3 * scale, 1.8 * scale), bodyMat);
  stabilizer.position.set(0, 0.3 * scale, 5.6 * scale);
  group.add(stabilizer);

  // 四引擎短舱
  for (const side of [-1, 1]) {
    for (const offset of [2.6, 4.6]) {
      const pod = new Mesh(new CylinderGeometry(0.5 * scale, 0.5 * scale, 1.8 * scale, 8), darkMat);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * offset * scale, -0.6 * scale, 1.2 * scale);
      group.add(pod);
    }
  }

  return group;
}

/**
 * 创建友军运输机网格
 *
 * 功能：复用战斗机网格工厂，以蓝灰民航涂装呈现友军运输机
 * @returns 友军运输机网格组（与战机同尺寸）
 * 异常：无
 */
function createAllyMesh(): Group {
  return createFighterMesh(ALLY_PALETTE);
}

/**
 * 创建地面防空阵地目标网格
 *
 * 功能：拼装地面目标——基座 + 旋转雷达罩/炮塔 + 发光核心，
 * 玩家俯冲攻击时清晰可辨
 * @returns 地面目标网格组（约 14 米高）
 * 异常：无
 * 注意事项：核心发光材质保证远距离可见性
 */
function createGroundTargetMesh(): Group {
  const group = new Group();

  // 混凝土基座
  const base = new Mesh(
    new CylinderGeometry(7, 9, 3, 8),
    new MeshStandardMaterial({ color: 0x6f6a60, flatShading: true, roughness: 0.9 }),
  );
  base.position.y = 1.5;
  group.add(base);

  // 支柱
  const mast = new Mesh(
    new CylinderGeometry(1.2, 1.6, 7, 6),
    new MeshStandardMaterial({ color: 0x50565c, flatShading: true, roughness: 0.8 }),
  );
  mast.position.y = 6.5;
  group.add(mast);

  // 顶部碟形天线/炮塔
  const dish = new Mesh(
    new SphereGeometry(3.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    new MeshStandardMaterial({ color: 0x8a9096, flatShading: true, roughness: 0.6, metalness: 0.3 }),
  );
  dish.position.y = 10.4;
  dish.rotation.x = Math.PI;
  group.add(dish);

  // 发光核心（命中判定视觉参照）
  const core = new Mesh(
    new SphereGeometry(1.6, 8, 6),
    new MeshBasicMaterial({ color: 0xff6b4a }),
  );
  core.position.y = 10.2;
  group.add(core);

  return group;
}

/** 当前玩家机型配色缓存（渲染桥装配时由 setPlayerFighter 写入） */
let playerPalette: FighterPalette = PLAYER_PALETTE;

/**
 * 设置玩家机型配色（渲染层装配入口调用）
 *
 * 功能：按玩家所选机型更新玩家战机网格配色（机身主色/强调色）
 * @param fighterId 机型 ID（'kestrel' | 'bastion' | 'falcon'）
 * @returns void
 * 异常：无
 * 注意事项：须在玩家实体生成（网格创建）之前调用，
 * 未知机型保持兜底配色
 */
export function setPlayerFighter(fighterId: string): void {
  const fighter = getFighterById(fighterId);
  if (fighter !== null) {
    playerPalette = { ...PLAYER_PALETTE, body: fighter.bodyColor, accent: fighter.accentColor };
  }
}

/**
 * 获取玩家机型配色（私有）
 *
 * @returns 当前玩家配色方案
 */
function getPlayerPalette(): FighterPalette {
  return playerPalette;
}

/**
 * 按模拟实体创建对应渲染网格
 *
 * 功能：根据实体类别与变体标记选择网格工厂——
 * 玩家/敌方战机、练习靶标、曳光弹、导弹、干扰弹与地面目标占位
 * @param entity 模拟实体（只读其 kind/variant）
 * @returns 渲染网格对象
 * 异常：无
 * 注意事项：本函数是渲染层“状态→外观”映射的唯一入口，
 * 新增实体变体时在此登记工厂即可
 */
export function createEntityMesh(entity: SimEntity): Group | Mesh {
  switch (entity.kind) {
    case 'aircraft':
      if (entity.variant === 'practice-target') {
        return createPracticeTargetMesh();
      }
      if (entity.variant === 'bomber') {
        return createBomberMesh();
      }
      if (entity.variant === 'ally') {
        return createAllyMesh();
      }
      if (entity.variant === 'wingman') {
        return createFighterMesh(WINGMAN_PALETTE);
      }
      if (entity.variant === 'player') {
        // 玩家战机按机型配色（配置表 bodyColor/accentColor）
        return createFighterMesh(getPlayerPalette());
      }
      return createFighterMesh(ENEMY_PALETTE);
    case 'projectile':
      if (entity.variant === 'missile') {
        return createMissileMesh();
      }
      return createTracerMesh();
    case 'ground-target':
      return createGroundTargetMesh();
    case 'effect':
      if (entity.variant === 'flare') {
        return createFlareMesh();
      }
      // 瞬时效果占位网格（爆炸特效在迭代6实现）
      return new Mesh(
        new BoxGeometry(2, 2, 2),
        new MeshStandardMaterial({ color: 0xef476f, wireframe: true }),
      );
  }
}
