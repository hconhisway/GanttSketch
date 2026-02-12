from __future__ import annotations

import base64
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
JS_DIR = BUILD_DIR / "static" / "js"
CSS_DIR = BUILD_DIR / "static" / "css"


def pick_latest(paths: list[Path]) -> Path:
    if not paths:
        raise FileNotFoundError("No build assets found. Run npm run build first.")
    return max(paths, key=lambda p: p.stat().st_mtime)


def encode_base64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def chunk_string(value: str, size: int = 8192) -> list[str]:
    return [value[i : i + size] for i in range(0, len(value), size)]


def format_string_array(chunks: list[str]) -> str:
    rendered = ",\n  ".join(json.dumps(chunk) for chunk in chunks)
    return "[\n  " + rendered + "\n]"


def escape_template_literal(value: str) -> str:
    return value.replace("`", "\\`").replace("${", "\\${")


def main() -> None:
    js_file = pick_latest(list(JS_DIR.glob("main*.js")))
    css_file = pick_latest(list(CSS_DIR.glob("main*.css")))

    js_b64 = encode_base64(js_file)
    css_b64 = encode_base64(css_file)
    js_b64_array = format_string_array(chunk_string(js_b64))
    css_b64_array = format_string_array(chunk_string(css_b64))

    css_overrides = """
html, body, #root, .App, .main-content, .left-panel {
  width: 100%;
  height: 100%;
  margin: 0;
}

.right-panel,
.controls {
  display: none !important;
}

.left-panel {
  padding: 0 !important;
  gap: 0 !important;
}

.chart-container {
  padding: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  background: #fff !important;
}
"""

    css_overrides_escaped = escape_template_literal(css_overrides.strip())

    template = """# Auto-generated. Do not edit directly.
# Source: {js_name}, {css_name}
# Regenerate: python scripts/build_anywidget_singlefile.py
from __future__ import annotations

import anywidget
import traitlets


JS_B64 = "".join({js_b64_array})
CSS_B64 = "".join({css_b64_array})


class GanttWidget(anywidget.AnyWidget):
    \"\"\"Standalone Gantt chart widget (single-file build).\"\"\"

    width = traitlets.Unicode("100%").tag(sync=True)
    height = traitlets.Unicode("600px").tag(sync=True)
    js_b64 = traitlets.Unicode(JS_B64).tag(sync=True)
    css_b64 = traitlets.Unicode(CSS_B64).tag(sync=True)

    _esm = \"\"\"
const CSS_OVERRIDES = `{css_overrides}`;

function render({{ el, model }}) {{
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
    <title>OSFAT Widget</title>
    <link rel="stylesheet" href="data:text/css;base64,${{css_b64}}">
    <style>${{CSS_OVERRIDES}}</style>
  </head>
  <body>
    <div id="root"></div>
    <script src="data:text/javascript;base64,${{js_b64}}"></script>
  </body>
</html>`;

  iframe.srcdoc = html;
  wrapper.appendChild(iframe);
  el.appendChild(wrapper);

  const applySize = () => {{
    const width = model.get("width") || "100%";
    const height = model.get("height") || "600px";
    el.style.width = width;
    el.style.height = height;
    wrapper.style.width = width;
    wrapper.style.height = height;
  }};

  applySize();
  model.on("change:width", applySize);
  model.on("change:height", applySize);
}}

export default {{ render }};
\"\"\"


__all__ = ["GanttWidget"]
"""

    output = template.format(
        js_name=js_file.name,
        css_name=css_file.name,
        js_b64_array=js_b64_array,
        css_b64_array=css_b64_array,
        css_overrides=css_overrides_escaped,
    )

    output_path = ROOT / "gantt_anywidget.py"
    output_path.write_text(output, encoding="utf-8")
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()

