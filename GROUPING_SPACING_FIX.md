# Grouping Spacing Fix - 使用真实间距替代虚线

## 改进内容

用户反馈后，将groups之间的虚线分隔符改为真正的空白间距。

## 变更前后对比

### Before (虚线分隔)
```
Track 1  ■■■■
Track 2  ■■■
Track 3  ■■■■
Track 4  ■■■
━ ━ ━ ━ ━ ━  ← 虚线分隔符
Track 5  ■■■
Track 6  ■■■■
```

### After (真实间距)
```
Track 1  ■■■■
Track 2  ■■■
Track 3  ■■■■
Track 4  ■■■
                ← 真实的空白间距
Track 5  ■■■
Track 6  ■■■■
```

## 实现方法

### 1. 插入空白占位符

在`processTracksConfig`函数中，在groups之间插入特殊的spacer tracks：

```javascript
sortedGroups.forEach((group, groupIndex) => {
  // ... 添加group tracks
  
  // Add spacer between groups (except after the last group)
  if (groupIndex < sortedGroups.length - 1) {
    trackOrder.push(`__spacer_${groupIndex}__`);
  }
});
```

**占位符命名规则**：
- 格式：`__spacer_{index}__`
- 示例：`__spacer_0__`, `__spacer_1__`, `__spacer_ungrouped__`

### 2. 隐藏占位符标签

在Y轴配置中隐藏spacer的tick labels：

```javascript
y: {
  // ...
  tickFormat: (d) => d.toString().startsWith('__spacer_') ? '' : d
}
```

### 3. 移除虚线分隔符

完全删除了`Plot.line`绘制虚线的代码。

### 4. 更新标签和背景计算

- 使用实际track值而不是索引
- 确保spacer不影响group labels的位置
- 背景rectangles只覆盖实际tracks，不包括spacers

## 技术细节

### Spacer Tracks特性

1. **不显示数据**：processedData中不包含spacer tracks的数据
2. **不显示标签**：tickFormat返回空字符串
3. **占据空间**：在Y轴domain中占据一个位置
4. **透明背景**：不会被group background覆盖

### Domain构成

```javascript
// 示例：4 groups，每组2 tracks
trackOrder = [
  '1', '2',              // Group 1
  '__spacer_0__',        // 间距
  '3', '4',              // Group 2
  '__spacer_1__',        // 间距
  '5', '6',              // Group 3
  '__spacer_2__',        // 间距
  '7', '8'               // Group 4
]
```

### 视觉效果

现在groups之间有：
- ✅ 真实的垂直空白间距
- ✅ 清晰的视觉分离
- ✅ 更自然的外观（没有线条）
- ✅ Group标签
- ✅ 交替背景色

## 优势

1. **更清晰**：空白间距比虚线更自然、更清晰
2. **更简洁**：没有额外的视觉元素
3. **更灵活**：可以轻松调整间距大小（添加更多spacers）
4. **性能更好**：不需要绘制额外的线条

## 调整间距大小

如果需要更大的间距，可以在每个group之间添加多个spacers：

```javascript
// 添加2个spacers = 双倍间距
trackOrder.push(`__spacer_${groupIndex}_1__`);
trackOrder.push(`__spacer_${groupIndex}_2__`);
```

## 用户体验

- **直观**：空白间距更符合用户对"分组"的期待
- **可读性**：不同groups之间的界限更明显
- **美观**：整体视觉效果更简洁、专业

## 文件修改

### `src/App.js`

1. **processTracksConfig函数**：
   - 在groups之间插入spacer tracks
   - 处理ungrouped tracks的spacer

2. **Y轴配置**：
   - 添加tickFormat隐藏spacer标签
   - 保持padding为0.1（不再需要额外padding）

3. **图表渲染**：
   - 移除虚线分隔符绘制代码
   - 更新group labels使用实际track值
   - 更新background rectangles使用实际track值

## 测试

验证改进：
1. 选择"Grouped (Auto 2 Groups)"
2. **预期效果**：
   - Groups之间有明显的空白间距
   - 没有虚线
   - Group标签正确显示
   - 背景色正确交替

---

**Version:** 1.3.4  
**Date:** 2025-11-06  
**Improvement:** Replaced dashed separators with actual spacing  
**Status:** Implemented ✅







