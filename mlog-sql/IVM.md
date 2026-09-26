

# Incremental View Maintenance (IVM)

- if we support IVM it means summary data computation can run over new rows added (or changed), rather than summary data computation over the entire set of something
- for streaming mode, IVM is not required, but if it's easy, we should do it, I mean incrementally computing summary data, etc, from batch set updates, not over the whole dataset. we shall see where this goes.


## output from Gemini 3.8 reguarding IVM support from echarts



Apache ECharts supports streaming, appending, and partial updates through several mechanisms, depending on whether you need high-performance streaming or selective property patching.

---

### 1. The `appendData` API (High-Performance Streaming)

For streaming real-time or time-series data without passing the entire array, ECharts provides the chart instance method `appendData`.

```javascript
myChart.appendData({
  seriesIndex: 0, // Target series index or seriesId
  data: [
    ["2026-03-30 10:00:05", 42],
    ["2026-03-30 10:00:06", 45],
  ],
});
```

- **How it works:** It bypasses full option diffing and pushes raw data points directly into the series storage engine.
- **Best used for:** High-frequency streams (scatter plots, line charts, linesGL).
- **Limitations:**
- Only works on chart types that support incremental rendering (`scatter`, `lines`, GL charts, etc.).
- Does not support automatic scale readjustment (if dynamic axis scaling is required, axis min/max won't recalculate unless triggered manually or combined with `setOption`).

---

### 2. Default `setOption` Merging (Partial Tree Updates)

By default, `setOption` performs an object merge rather than replacing the entire state:

```javascript
// Initial configuration
myChart.setOption({
  xAxis: { type: "category", data: ["A", "B"] },
  yAxis: { type: "value" },
  series: [{ id: "series-1", type: "bar", data: [10, 20] }],
});

// Update: Only target 'series-1'
myChart.setOption({
  series: [
    {
      id: "series-1",
      data: [15, 25], // Replaces only the data array for this specific series
    },
  ],
});
```

- **Options merge by default:** ECharts matches existing series via `id` or index. Unmentioned configuration (axes, legend, tooltips, other series) remains untouched.
- **Array handling behavior:** While top-level objects merge, array fields (like `series[].data`) are replaced entirely unless using `appendData`.

---

### 3. Progressive Rendering / Chunk Loading (`progressive`)

If you are dealing with massive datasets loaded incrementally, enable progressive rendering:

```javascript
myChart.setOption({
  series: [
    {
      type: "scatter",
      progressive: 5000, // Renders 5,000 items per frame
      progressiveThreshold: 10000,
      data: largeDataset,
    },
  ],
});
```

Combined with `appendData`, this prevents the UI thread from freezing when piping in tens of thousands of data points chunk by chunk.

---

### 4. Sliding Window Pattern (FIFO Queue)

For real-time dashboards where you want to show a moving window (e.g., last 100 points):

```javascript
// Add new point and shift out the oldest
dataArray.push(newPoint);
dataArray.shift();

myChart.setOption({
  series: [
    {
      id: "liveSeries",
      data: dataArray,
    },
  ],
});
```

ECharts optimizes array re-rendering by tracking point transitions using `series.animation: true`, animating the shift smoothly without re-initializing chart components.
