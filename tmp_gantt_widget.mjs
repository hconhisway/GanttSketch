
const CSS_OVERRIDES = "html, body, #root, .App, .main-content, .left-panel {\n  width: 100%;\n  height: 100%;\n  margin: 0;\n}\n\n.right-panel,\n.controls {\n  display: none !important;\n}\n\n.left-panel {\n  padding: 0 !important;\n  gap: 0 !important;\n}\n\n.chart-container {\n  padding: 0 !important;\n  border-radius: 0 !important;\n  box-shadow: none !important;\n  background: #fff !important;\n}";

function render({ el, model }) {
  const wrapper = document.createElement("div");
  wrapper.style.width = "100%";
  wrapper.style.height = "100%";
  wrapper.style.boxSizing = "border-box";

  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");

  const css_b64 = model.get("css_b64") || "";
  const js_b64 = model.get("js_b64") || "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GanttSketch Widget</title>
    <link rel="stylesheet" href="data:text/css;base64,${css_b64}">
    <style>${CSS_OVERRIDES}</style>
  </head>
  <body>
    <div id="root"></div>
    <script src="data:text/javascript;base64,${js_b64}"></script>
  </body>
</html>`;

  iframe.srcdoc = html;
  wrapper.appendChild(iframe);
  el.appendChild(wrapper);

  const applySize = () => {
    const width = model.get("width") || "100%";
    const height = model.get("height") || "600px";
    el.style.width = width;
    el.style.height = height;
    wrapper.style.width = width;
    wrapper.style.height = height;
  };

  applySize();
  model.on("change:width", applySize);
  model.on("change:height", applySize);
}

export default { render };
