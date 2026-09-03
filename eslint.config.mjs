import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".codegraph/**",
      ".deerhux/**",
      ".deerhux-build-home/**",
      "codeAgent/**",
      "src-tauri/target/**",
      "src-tauri/resources/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // TypeScript 项目约定：以 `_` 开头的参数/变量表示“故意未使用”（如 Port 接口
      // 要求的 throw not-implemented 占位参数）。与 next 默认的报错规则配合使用。
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["bin/**/*.js", "scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
