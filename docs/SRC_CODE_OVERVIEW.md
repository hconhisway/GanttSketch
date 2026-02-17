## GanttSketch：`src/` 代码结构总览

> 本文档用于快速理解 `src/` 下的整体代码结构与各文件职责。  
> 覆盖范围：`src/**/*.{ts,tsx,js,jsx,json,css}`（共 **91** 个文件，含测试与样式）。  
> 更新日期：2026-02-13

## 1. 总体架构（高层视角）

这是一个 **React + TypeScript** 的单页应用，核心目标是把“事件/trace 数据”映射成 **可交互的 Gantt/时间线视图**，并提供：

- **高性能渲染**：多层叠加渲染（可选 **WebGL2** 高吞吐条形 + **Canvas2D** 文本/覆盖 + **SVG** 坐标轴/连线/矢量元素）。
- **Streaming 取数**：按视口时间窗口与可见 lanes 按需请求，配合 **tile cache** 与 **Worker** 降低主线程压力。
- **LLM 辅助定制**：通过聊天面板让 LLM 生成/修改 `ganttConfig`、tracks 配置或 widgets，并提供 JSON 编辑器可人工修订。
- **标注与截图**：在图表上绘制标注并导出带标注的图片，支持图集管理。

## 2. 关键运行时主链路（从入口到渲染）

### 2.1 启动入口

- `src/index.tsx` 挂载 React Root，并渲染 `<App />`。
- `src/App.tsx` 是“编排中心”：聚合数据加载、配置/Widget 编辑、聊天 agent、图表渲染与 UI 布局。

### 2.2 数据加载与（可选）Streaming

核心在 `src/hooks/useDataFetching.ts`：

- **优先**从后端 API 拉取事件（默认同源 `/get-events`）；失败时回退到 `public/` 内置 trace；再失败提示用户上传本地文件。
- **Streaming 模式**开启时，结合 `src/hooks/useStreamingData.ts` 基于 `viewStateRef`（视口）持续生成请求（节流/缓冲）。
- WebGL 路径需要的 SoA 数据优先在 `src/workers/dataWorker.ts` 里处理（normalize + LOD 聚合 + SoA 打包并 transfer typed arrays）；并使用 `src/cache/tileCache.ts` 进行 tile 级缓存。

### 2.3 数据→聚合→渲染

`src/App.tsx` 在获得 normalized events 后：

- 用 `src/utils/dataProcessing.ts` 做 tracks 配置处理（筛选/分组/排序等）。
- 用 `src/hooks/useProcessAggregates.ts` 基于 hierarchy 聚合（例如按 `hierarchy1` 聚合进程/线程相关结构）。
- 最终交给 `src/hooks/useChartRenderer.ts` 执行渲染与交互（缩放、拖拽平移、hover tooltip、minimap 操作、展开/折叠等）。

### 2.4 WebGL vs Canvas 的选择逻辑（简述）

在 `src/hooks/useChartRenderer.ts` 中：

- 当 WebGL2 可用、配置允许（`ganttConfig.performance.webglEnabled !== false`）、且已准备好 `renderSoA`，并且 SoA 的 laneKeys 与当前可见 lanes 有重叠时，优先走 `src/rendering/webglRenderer.ts` 的 instanced 渲染路径。
- 否则走 Canvas2D/SVG 的逐 primitive 绘制路径，并受 `src/config/perfBudgets.ts` 的预算约束。

### 2.5 LLM 定制（Config / Tracks / Widget）

由 `src/hooks/useChatAgent.ts` 统一编排：

- Config 模式：通过 `src/agents/configAgent.ts` / `src/agents/configIndex.ts` / `src/config/ganttConfigSchema.ts` / `src/config/GANTT_CONFIG_SPEC.json` 组织 prompt 与语义索引，解析 LLM 输出的 patch 并应用（`applyGanttConfigPatch`）。
- Widget 模式：通过 `src/agents/widgetAgent.ts` 约束 LLM 输出结构，`src/config/widgetValidator.ts` 校验/自动修复，再由 `src/hooks/useWidgetBindings.ts` 绑定事件。

## 3. 目录结构速览

```text
src/
  App.tsx, index.tsx, *.css, setupTests.ts, react-app-env.d.ts
  agents/        # LLM 相关：analysis/config/widget agent 与索引
  cache/         # Streaming tile cache
  components/    # UI 组件：chart/chat/config/widget/layout/overlay
  config/        # 配置 spec、默认配置、LLM 配置、性能预算、validator
  hooks/         # 业务 hooks：渲染、取数、streaming、agent 编排、编辑器等
  rendering/     # WebGL 渲染器实现
  styles/        # 细分 CSS（App.css 统一 import）
  types/         # 核心类型契约
  utils/         # 数据处理、层级/排序、表达式、SoA/LOD、导出等工具
  workers/       # Web Worker：数据 normalize/聚合/SoA 打包
```

## 4. 逐文件说明（每个文件的功能与作用）

### 4.1 `src/` 根目录

- **`src/index.tsx`**：React 入口，创建 root 并渲染 `<App />`。
- **`src/App.tsx`**：应用编排中心；维护核心 state（数据、mapping、config、viewState、widgets、chat、drawing 等），串联各 hooks 并组装左右面板 UI。
- **`src/App.css`**：样式聚合入口（通过 `@import` 引入 `src/styles/*.css`）。
- **`src/index.css`**：全局基础样式/reset。
- **`src/setupTests.ts`**：Jest 测试初始化（`@testing-library/jest-dom`）。
- **`src/react-app-env.d.ts`**：React Scripts/CRA 的类型声明引用。
- **`src/GanttDrawingOverlay.js`**：旧版（JS）绘图覆盖层实现（历史遗留/兼容用途）；当前主路径使用 `components/chart/GanttDrawingOverlay.tsx`。
- **`src/GanttDrawingOverlay.css`**：绘图覆盖层样式（供 overlay 相关组件使用）。

### 4.2 `src/agents/`（LLM / 语义索引层）

- **`src/agents/index.ts`**：agent 聚合出口（统一 re-export）。
- **`src/agents/dataAnalysisAgent.ts`**：数据分析 agent；用 LLM 推断 `GanttDataMapping`，并提供 minimal 处理与从 mapping 派生 config patch 的逻辑。
- **`src/agents/dataAnalysisAgent.test.ts`**：数据分析 agent 的单测。
- **`src/agents/configAgent.ts`**：配置 agent；构建系统 prompt、校验/提取 patch/目标 path 等。
- **`src/agents/configIndex.ts`**：从 `GANTT_CONFIG_SPEC.json` 构建语义索引，支持按关键词/概念匹配配置项（用于 LLM 定位）。
- **`src/agents/configIndex.test.ts`**：config index 的单测。
- **`src/agents/widgetAgent.ts`**：widget agent；定义严格输出格式（JSON）与生成约束，指导 LLM 创建/更新 widget。

### 4.3 `src/cache/`

- **`src/cache/tileCache.ts`**：Streaming tile 级缓存（按时间分片/lane/key 复用 transformed 数据），降低重复窗口请求成本。

### 4.4 `src/components/`（UI 组件）

#### 4.4.1 `src/components/chart/`
- **`src/components/chart/GanttChart.tsx`**：图表容器组件；承载 chart/minimap/xAxis/yAxis 的 refs，叠加绘图 overlay 与 busy/loading 遮罩。
- **`src/components/chart/GanttDrawingOverlay.tsx`**：TS 版绘图覆盖层；用 SVG 记录笔迹并导出“带标注截图”（调用导出工具），并提供 DrawingControls。

#### 4.4.2 `src/components/chat/`
- **`src/components/chat/ChatInput.tsx`**：聊天输入区；发送消息、Widget 模式开关、截图/清空绘图等操作入口。
- **`src/components/chat/ChatMessages.tsx`**：消息列表渲染；支持把消息拆分成文本/code segments（用于更友好的展示）。
- **`src/components/chat/ChatMessages.test.tsx`**：ChatMessages 组件单测。

#### 4.4.3 `src/components/config/`
- **`src/components/config/ConfigPanel.tsx`**：右侧配置面板；按 UI spec 渲染配置按钮，并展示 widgets 列表入口。
- **`src/components/config/ConfigPanel.test.tsx`**：ConfigPanel 单测。
- **`src/components/config/ConfigEditorModal.tsx`**：JSON 编辑弹窗；编辑配置项或 Data Mapping，并提供导出相关动作。
- **`src/components/config/DataSetupModal.tsx`**：数据就绪但 mapping 未建立时的引导弹窗（运行分析/加载配置）。

#### 4.4.4 `src/components/widget/`
- **`src/components/widget/WidgetArea.tsx`**：widget 区域渲染；按配置展示卡片并提供 DOM 容器 ref（供事件绑定）。
- **`src/components/widget/WidgetEditorModal.tsx`**：widget JSON 编辑弹窗；保存/删除 widget。

#### 4.4.5 `src/components/layout/`
- **`src/components/layout/LeftPanel.tsx`**：左侧布局容器（包裹 chart + widget）。
- **`src/components/layout/RightPanel.tsx`**：右侧布局容器（包裹 config + chat）。

#### 4.4.6 `src/components/` 其他
- **`src/components/PerfOverlay.tsx`**：性能 overlay；展示渲染耗时等指标，并提供 Streaming Mode 开关。
- **`src/components/ImageGallery.tsx`**：截图图集（虚拟化网格），支持选择/删除。

### 4.5 `src/config/`（配置/spec/预算/LLM）

- **`src/config/GANTT_CONFIG_SPEC.json`**：配置 spec 的权威来源；定义 sections/entries（path/kind/default/description），并包含 rule DSL 的参考（ops/transform/context）。
- **`src/config/ganttConfig.ts`**：默认 `GanttConfig` 与工具函数：clone、normalize、patch 合并（`applyGanttConfigPatch`）等。
- **`src/config/ganttConfig.test.ts`**：ganttConfig 的单测（clone/patch/动态层级修复等）。
- **`src/config/ganttConfigSchema.ts`**：面向 LLM 的“配置 schema 文本化输出”，用于拼装 prompt。
- **`src/config/ganttConfigUiSpec.ts`**：把 `GANTT_CONFIG_SPEC.json` 转成 UI 面板可用的 `GANTT_CONFIG_UI_SPEC`。
- **`src/config/llmConfig.ts`**：LLM provider 配置与请求实现（含 streaming）。
- **`src/config/perfBudgets.ts`**：性能预算常量（例如 viewport primitives 上限）。
- **`src/config/tracksConfigPrompt.ts`**：tracks 配置相关 prompt/解析工具（把 LLM 输出转换成内部 tracksConfig）。
- **`src/config/widgetConfig.ts`**：widget 区域布局/样式配置的默认值与 patch 合并工具。
- **`src/config/widgetValidator.ts`**：widget 校验与自动修复（缺字段、id 冲突、listener 基础检查、脚本清理等）。
- **`src/config/widgetValidator.test.ts`**：widgetValidator 单测。

### 4.6 `src/hooks/`（业务 hooks）

- **`src/hooks/useChartRenderer.ts`**：核心渲染/交互 hook（D3 + Canvas/SVG + 可选 WebGL2）；负责场景初始化、缩放/平移/hover、minimap、展开折叠、性能采样等。
- **`src/hooks/useDataFetching.ts`**：数据获取中枢；支持 API/内置 trace/上传回退，Streaming 请求处理，Worker SoA 打包与 tileCache 协作。
- **`src/hooks/useStreamingData.ts`**：Streaming 请求生成器；基于 `viewStateRef` 推导时间窗口/laneIds，并节流发送。
- **`src/hooks/useProcessAggregates.ts`**：基于 hierarchy 的聚合计算（例如 per-hierarchy1 的线程映射与聚合 spans）。
- **`src/hooks/useGanttChart.ts`**：小型渲染辅助 hook；把渲染函数绑定到 effect/依赖更新上。
- **`src/hooks/useChatAgent.ts`**：聊天/LLM 编排 hook；管理 prompt、流式响应、解析 action，并把结果应用到 config/tracks/widgets。
- **`src/hooks/useConfigEditor.ts`**：配置/DataMapping 编辑器状态机；打开/保存/导出等逻辑。
- **`src/hooks/useWidgetEditor.ts`**：widget 编辑器状态机；打开/保存/删除等逻辑。
- **`src/hooks/useWidgetBindings.ts`**：widget 事件绑定；把 widget.listeners 绑定到 DOM，并在触发时执行 handler（运行时编译）。
- **`src/hooks/useImageCapture.ts`**：截图管理；调用 drawing overlay 导出图片并维护 gallery 的选择/删除。

### 4.7 `src/rendering/`

- **`src/rendering/webglRenderer.ts`**：WebGL2 渲染器实现（instanced rect + shader + palette texture）；提供创建/绘制/清理能力，供 `useChartRenderer` 调用。

### 4.8 `src/styles/`（样式文件，纯 CSS）

> 这些文件一般不包含业务逻辑；由 `src/App.css` 统一导入。

- **`src/styles/AppLayout.css`**：整体布局（左右面板/主区域）。
- **`src/styles/States.css`**：loading/error/空态等通用状态样式。
- **`src/styles/GanttChart.css`**：图表容器与各渲染层（canvas/svg/minimap/y-axis 等）样式。
- **`src/styles/ChatPanel.css`**：右侧面板布局样式。
- **`src/styles/ChatInput.css`**：聊天输入区样式。
- **`src/styles/ConfigPanel.css`**：配置按钮区样式（active/highlight）。
- **`src/styles/ConfigEditorModal.css`**：配置编辑弹窗样式。
- **`src/styles/DataSetupModal.css`**：数据引导弹窗样式。
- **`src/styles/WidgetArea.css`**：widget 卡片区样式。
- **`src/styles/WidgetEditorModal.css`**：widget 编辑弹窗样式。
- **`src/styles/ImageGallery.css`**：截图图集样式。

### 4.9 `src/types/`（类型契约）

- **`src/types/ganttConfig.ts`**：核心类型（`GanttConfig`、rule DSL 类型、`GanttDataMapping`、ConfigSpec/Section/Entry 等）。
- **`src/types/data.ts`**：数据结构类型（raw/normalized events、render primitives、tracks config 等）。
- **`src/types/viewState.ts`**：视口与交互状态类型（timeDomain、可见 lanes、filters、selection 等）。
- **`src/types/chat.ts`**：聊天消息与 segment 类型。
- **`src/types/widget.ts`**：Widget 与 WidgetConfig 类型。

### 4.10 `src/utils/`（算法与工具层）

- **`src/utils/dataProcessing.ts`**：数据处理工具集合（trace 解析/字段抽取/tracksConfig 处理/统计等）。
- **`src/utils/dataProcessing.test.ts`**：dataProcessing 单测。
- **`src/utils/hierarchy.ts`**：层级相关工具（字段推断/归一、lane key 构造、LOD 解析、剪裁 config 等）。
- **`src/utils/hierarchy.test.ts`**：hierarchy 单测。
- **`src/utils/processOrder.ts`**：yAxis 排序规则与 transform 执行、lane 模式解析、以及构建 config patch 的工具函数。
- **`src/utils/processOrder.test.ts`**：processOrder 单测。
- **`src/utils/lodAggregation.ts`**：LOD 聚合（按像素窗口把事件合成更少的 spans）。
- **`src/utils/soaBuffers.ts`**：把 primitives 打包为 SoA chunk（供 WebGL 高效上传/绘制）。
- **`src/utils/streamingDataProvider.ts`**：Streaming provider 抽象（真实 API 或模拟 fetch）。
- **`src/utils/color.ts`**：颜色解析与文本色选择（包含规则/legacy 兼容）。
- **`src/utils/color.test.ts`**：color 单测。
- **`src/utils/tooltip.ts`**：tooltip HTML 生成工具。
- **`src/utils/expression.ts`**：表达式/谓词求值器（JSON AST 形式的规则引擎）。
- **`src/utils/expression.test.ts`**：expression 单测。
- **`src/utils/formatting.ts`**：时间/时长格式化、转义、脚本剥离、CSS size/clamp 等通用函数。
- **`src/utils/formatting.test.ts`**：formatting 单测。
- **`src/utils/perfMetrics.ts`**：性能采样存储与统计（例如 p95）；供 PerfOverlay/renderer 记录读取。
- **`src/utils/configPatch.ts`**：config 项扁平化与聊天消息分段解析（segments）。
- **`src/utils/configBundle.ts`**：把 dataMapping（及可选 patch）打包成 bundle 并触发下载。
- **`src/utils/widget.ts`**：widget 规范化与 handler 编译等工具函数。
- **`src/utils/ExportHelper.ts`**：导出工具：将 DOM/SVG 与 drawings 合成为 canvas 并导出图片。

### 4.11 `src/workers/`

- **`src/workers/dataWorker.ts`**：Web Worker：在子线程中完成 normalize/聚合/SoA 打包并 transfer buffers，减少主线程卡顿。

## 5. 横切关注点（读代码时最值得注意的几件事）

- **性能闭环**：`useChartRenderer.ts` + `webglRenderer.ts` + `lodAggregation.ts` + `soaBuffers.ts` + `perfBudgets.ts` + `perfMetrics.ts` + `PerfOverlay.tsx` 形成“预算约束 + 指标采样 + 可视化”的闭环。
- **状态管理风格**：大量使用 `useRef`（例如 `viewStateRef`/`viewRangeRef`/`ganttConfigRef`）保存“高频交互的可变快照”，避免频繁 setState 触发 React 重渲染。
- **扩展机制的安全边界**：widgets 通过 `dangerouslySetInnerHTML` 渲染 HTML，并用运行时编译的 handler 执行交互逻辑；虽有 `widgetValidator`/脚本剥离做基础防护，但仍应视为“强能力、低隔离”的扩展机制。

