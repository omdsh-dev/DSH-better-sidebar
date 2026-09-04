// ESLint flat config（最小规则集）：
// - 基础：@eslint/js recommended + typescript-eslint recommended（非 type-checked 档，
//   全量 type-checked 需要项目服务且更慢，当前收益不足以引入）；
// - react-hooks recommended：client 侧是 React 重镇，依赖数组豁免注释
//   （react-hooks/exhaustive-deps）由此规则消费；
// - globals 按运行域分治：client bundle → browser，host/脚本 → node，tests → 混合。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // 构建产物 / 工具目录不参与 lint（node_modules 与点开头目录默认也不进）。
  {
    ignores: [
      'lib/',
      'dist/',
      'coverage/',
      'registry/',
      'playwright-report/',
      'test-results/',
      'node_modules/',
      '.worktrees/',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,

  // react-hooks v7 的 recommended 捆绑了 React Compiler 语义规则（purity /
  // immutability / refs / set-state-in-effect 等）：本仓库对 CodeMirror / xterm
  // 等命令式集成大量依赖 render 期读 ref、effect 内同步 setState 的既有模式，
  // 57 处存量报错均为噪音级误报，先整体关闭该档，只保留经典双规则
  // （rules-of-hooks / exhaustive-deps——后者消费代码里带理由的豁免注释）。
  {
    rules: Object.fromEntries(
      [
        'config',
        'error-boundaries',
        'gating',
        'globals',
        'immutability',
        'incompatible-library',
        'preserve-manual-memoization',
        'purity',
        'refs',
        'set-state-in-effect',
        'static-components',
        'unsupported-syntax',
        'use-memo',
      ].map(rule => [`react-hooks/${rule}`, 'off']),
    ),
  },

  // 孤儿 eslint-disable 注释（规则未实际触发）直接报错，防止豁免残留。
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },

  // no-unused-vars 对齐仓库既有约定：下划线前缀 = 刻意不用的占位（mock 桩等）。
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  // client bundle 运行在浏览器（portal 侧边栏 / 各视图 / 拦截层）。
  {
    files: ['src/client/**/*.{js,mjs,cjs,ts,tsx,jsx}'],
    languageOptions: { globals: globals.browser },
  },

  // host 侧插件入口与构建/运维脚本跑在 Node。eslint.config.js 自身不 ignore：
  // 它就是一个普通 ESM 脚本，走 js recommended + node globals 正常通过。
  {
    files: ['src/*.{js,mjs,cjs,ts}', 'scripts/**/*.{js,mjs,cjs,ts}', '*.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },

  // tests：Node 里跑（vitest / fs fixtures），jsdom 组件测试又摸浏览器全局。
  {
    files: ['tests/**/*.{js,mjs,cjs,ts,tsx,jsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
