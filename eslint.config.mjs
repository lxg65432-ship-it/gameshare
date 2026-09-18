import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/release/**',
      '**/*.d.ts',
      '_probe.js',
      // 一次性探测脚本：留着是为了保住当初的实测记录，不打算再维护，
      // 所以不进规则（正式的验收在 scripts/check-*.cjs / smoke-*.mjs 里）
      '**/_probe*.cjs',
      // 验收脚本自己打包出来的中转产物（不是源码，也不该被规则检）
      '**/.cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // 本项目是诊断工具，日志输出是核心功能，不做限制
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    // 验收用的 Electron 主进程与 preload 必须是 CJS —— 这两处不能改写成 ESM，
    // 所以单独放行 require / __dirname。
    // scripts/ 下的诊断脚本同理：必须跑在 Electron 主进程里才能拿到 desktopCapturer。
    files: ['apps/desktop/test/electron/**/*.js', 'scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        // Electron 主进程里这两个是运行时全局，但不在 ES 的内置清单里
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
