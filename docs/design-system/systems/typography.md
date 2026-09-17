# 字体

排版系统为紧凑工作台、长文本和技术内容提供稳定层级。

## 当前规则

- 产品 UI 使用系统无衬线字体；代码、路径、模型 ID 和技术参数使用 `--font-mono`。Noto Sans Mono 由根布局注入并带系统等宽回退。
- 字号使用 `--text-2xs` 至 `--text-xl` 六档，不随视口宽度缩放。
- 字重使用 `--weight-regular`、`--weight-medium`、`--weight-semibold`、`--weight-bold`。
- 行高使用 `--leading-tight`、`--leading-normal`、`--leading-relaxed`：单行控件与标题用 tight，说明与元数据用 normal，长正文用 relaxed。
- 字母间距默认 `0`；匹配码等需要逐字符辨识的专用输入可作为局部例外。界面缩放时内容不得被固定高度裁切。

## 引用

- Token：`app/design-tokens.css`、`app/globals.css` 的 `--font-mono`。
- 字体载入：`app/layout.tsx`。
- 示例：`components/ui/Form.module.css`、`components/chat-surface.css`。

## 例外或待确认

部分历史组件仍使用裸字号和字重，按代表性场景逐步归并到现有档位。
