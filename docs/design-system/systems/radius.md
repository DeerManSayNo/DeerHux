# 圆角

圆角系统统一控件、面板、输入区、窗口和圆形元素的轮廓层级。

## 当前规则

- 只从 `--radius-small`、`--radius-control`、`--radius-panel`、`--radius-composer`、`--radius-window`、`--radius-circle` 中选择。
- 小型标记用 small，按钮和输入用 control，内容面板用 panel，输入组合区用 composer，顶层工作区和二级窗口用 window。
- 嵌套表面的圆角不大于外层；只有头像、圆形图标容器和明确的圆形控制使用 circle。

## 引用

- Token：`app/design-tokens.css`。
- 实现：`components/ui/Button.module.css`、`components/ui/Modal.module.css`、`components/ui/Form.module.css`。

## 例外或待确认

历史样式中的裸圆角按任务迁移，不扩充为新的全局档位。
