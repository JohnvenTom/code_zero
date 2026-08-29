import { defineConfig } from 'vite';

/**
 * Vite 构建配置
 *
 * 功能：配置开发服务器与生产构建目标；base 使用相对路径以便任意静态目录托管部署
 * 参数：无（如需按环境区分可扩展为接收 `{ mode }` 的函数形式）
 * 返回值：Vite 配置对象（defineConfig 包装以获得类型提示）
 * 异常：无（配置错误由 Vite 在启动/构建时自行报告）
 * 注意事项：构建目标为 ES2022，与 tsconfig 的 target 保持一致
 */
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2022',
  },
});
