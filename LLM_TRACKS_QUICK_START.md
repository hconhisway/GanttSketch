# LLM Tracks Configuration - Quick Start Guide

Get started with intelligent, conversational track configuration in under 5 minutes!

## 🚀 Quick Setup

### Prerequisites
✅ GanttSketch application running  
✅ LLM API configured (see [LLM_SETUP.md](./LLM_SETUP.md))  
✅ Chart displaying data  

No additional setup needed - the feature works out of the box!

## 💬 Your First Commands

### 1. Simple Filtering

Open the chat panel and type:

```
Show only tracks 5 to 10
```

**What happens:**
- LLM understands your request
- Generates a filter configuration
- Chart updates automatically
- Green confirmation message appears: "✅ Track configuration applied: Showing only tracks 5-10"

**Your chart now shows:** Only tracks 5, 6, 7, 8, 9, and 10

---

### 2. Pattern-Based Filtering

Type:

```
Show all CPU tracks
```

**What happens:**
- LLM creates a pattern filter for "CPU"
- Chart filters to tracks containing "CPU"
- Confirmation message appears

**Your chart now shows:** Only tracks with "CPU" in their name (e.g., CPU_0, CPU_1, CPU_2)

---

### 3. Top Performers

Type:

```
Show me the 5 busiest tracks
```

**What happens:**
- LLM understands you want the top 5 by utilization
- System calculates utilization for all tracks
- Chart displays the 5 most active tracks
- Confirmation message appears

**Your chart now shows:** The 5 tracks with the highest average utilization

---

### 4. Grouping

Type:

```
Group tracks 0-5 as "High Priority" and 6-10 as "Low Priority"
```

**What happens:**
- LLM creates two groups
- Chart organizes tracks into groups
- Visual separator line appears between groups
- Confirmation message appears

**Your chart now shows:** Two distinct groups with a dashed line separator

---

### 5. Reset to Default

Type:

```
Show all tracks
```

**What happens:**
- LLM removes all filters
- Chart displays all available tracks
- Confirmation message appears

**Your chart now shows:** All tracks in default order

## 🎨 With Visual Annotations (Vision Models Only)

### Prerequisites
- Vision-capable LLM (GPT-4 Vision or Claude 3)
- Drawing module enabled

### Steps:

1. **Enter Drawing Mode**
   - Click the "🖊️ Draw" button

2. **Annotate the Chart**
   - Circle the tracks you're interested in
   - Use different colors for different groups
   - Draw arrows to highlight specific areas

3. **Capture the Image**
   - Click the 📸 button in the chat panel
   - Image is saved and selected automatically

4. **Ask LLM**
   Type: `"Show only these tracks"`
   
5. **LLM Analyzes**
   - Reads your sketch
   - Identifies circled tracks
   - Generates appropriate configuration
   - Applies configuration automatically

## 📝 Command Templates

Copy and customize these templates:

### Filtering
```
Show only tracks [START] to [END]
Display tracks [TRACK1], [TRACK2], and [TRACK3]
Show tracks containing [PATTERN]
Filter to [CRITERIA] tracks only
```

### Sorting
```
Sort tracks ascending
Sort tracks descending
Reverse the track order
```

### Grouping
```
Group tracks [LIST1] as "[NAME1]" and [LIST2] as "[NAME2]"
Organize into [CATEGORY1] and [CATEGORY2]
Split tracks into [NUMBER] groups
```

### Analysis
```
Show me the [N] busiest tracks
Display the top [N] tracks by utilization
Show only active tracks
Filter to high utilization tracks
```

## ✨ Tips for Best Results

### 1. Be Specific
❌ "Filter the chart"  
✅ "Show only tracks 5 to 10"

### 2. Use Exact Names
❌ "Show some CPU stuff"  
✅ "Show tracks CPU_0, CPU_1, and CPU_2"

### 3. Specify Quantities
❌ "Show busy tracks"  
✅ "Show the 5 busiest tracks"

### 4. Name Your Groups
❌ "Make two groups"  
✅ "Group 0-5 as 'Critical' and 6-10 as 'Normal'"

### 5. One Request at a Time
❌ "Show tracks 5-10 and also group them by priority and sort descending"  
✅ First: "Show tracks 5-10"  
✅ Then: "Group these into priority levels"

## 🔄 Common Workflows

### Workflow 1: Progressive Filtering
```
1. "Show numeric tracks only"
2. "From these, show only even numbers"
3. "Sort them descending"
```

### Workflow 2: Analysis and Focus
```
1. "Show me the 10 busiest tracks"
2. "Group these into high (top 5) and medium (rest)"
```

### Workflow 3: Category Organization
```
1. "Show all CPU and GPU tracks"
2. "Group CPU tracks as 'Compute' and GPU tracks as 'Graphics'"
```

### Workflow 4: Visual + Text
```
1. Draw circles around interesting tracks
2. Capture image
3. "Show only these tracks and group them by utilization"
```

## 🐛 Troubleshooting

### Configuration Not Applied

**Problem:** LLM responds but chart doesn't change

**Solution:**
1. Check for green confirmation message
2. Open browser console (F12) and look for errors
3. Verify track names in your request match actual tracks
4. Try rewording your request

### Wrong Tracks Shown

**Problem:** Different tracks than expected

**Solution:**
1. Be more specific with track names/numbers
2. Check the confirmation message for what was applied
3. Use "Show all tracks" to reset and try again

### LLM Doesn't Understand

**Problem:** LLM gives explanation instead of configuration

**Solution:**
1. Use more direct language: "Configure tracks to..."
2. Explicitly mention filtering, sorting, or grouping
3. Try: "Generate a track configuration that..."

## 📚 Learn More

- **Full Documentation:** [LLM_TRACKS_CONFIG.md](./LLM_TRACKS_CONFIG.md)
- **Manual Configuration:** [TRACKS_CONFIG_GUIDE.md](./TRACKS_CONFIG_GUIDE.md)
- **Advanced Examples:** [TRACKS_CONFIG_EXAMPLES.md](./TRACKS_CONFIG_EXAMPLES.md)
- **LLM Setup:** [LLM_SETUP.md](./LLM_SETUP.md)

## 🎯 Next Steps

Now that you've mastered the basics:

1. **Experiment** with different command phrasings
2. **Combine** filtering and grouping in workflows
3. **Use visual annotations** if you have a vision model
4. **Save** successful commands for future use
5. **Share** your favorite commands with your team

## 💡 Pro Tips

1. **Conversation Context**: The LLM remembers recent messages, so you can build on previous configurations
2. **Reset Often**: Use "show all tracks" to reset and start fresh
3. **Iterate**: Refine configurations through conversation
4. **Check Names**: Use "What tracks are currently displayed?" to verify track names
5. **Be Patient**: Wait for the green confirmation before making another request

---

**Happy configuring! 🚀✨**

For questions or issues, check the full documentation or open an issue in the project repository.

