# 阴影

阴影与层级系统表达控件、浮层、窗口和全局反馈的遮挡关系。

## 当前规则

- 普通控件、浮层和模态分别使用 `--shadow-control`、`--shadow-popover`、`--shadow-modal`；遮罩使用 `--shadow-overlay` 或 strong 变体。
- 浅色和深色主题分别定义阴影强度。稳定分区优先使用边框或表面对比，阴影只用于需要空间层级的元素。
- z-index 使用 `--z-sticky`、`--z-dropdown`、`--z-popover`、`--z-window`、`--z-window-raised`、`--z-dialog`、`--z-modal`、`--z-toast`。
- 新浮层选择与职责匹配的层级，不新增无归属的高位裸数值。

## 引用

- Token：`app/globals.css` 的阴影、`app/design-tokens.css` 的 z-index。
- 实现：`components/ui/Modal.module.css`、`components/ui/Button.module.css`。

## 例外或待确认

历史领域样式仍有裸阴影与 z-index，属于迁移项，不作为新层级依据。
