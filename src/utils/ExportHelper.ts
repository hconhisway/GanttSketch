/**
 * Export the chart (with optional sketch paths) as a PNG blob.
 */

interface DrawingPath {
  id?: string;
  path: string;
  color?: string;
  width?: number;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Pick the largest SVG inside `root`, optionally skipping the drawing overlay. */
function findMainSVG(root: Element): SVGElement | null {
  let best: SVGElement | null = null;
  let maxArea = 0;
  for (const el of Array.from(root.querySelectorAll<SVGElement>('svg'))) {
    if (el.classList.contains('gantt-drawing-canvas-overlay')) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > maxArea) { maxArea = area; best = el; }
  }
  return best;
}

/** Read pixel dimensions from an SVG: explicit attrs → BBox → viewBox. */
function getSVGDimensions(svg: SVGElement): { width: number; height: number } {
  const aw = parseFloat(svg.getAttribute('width') || '0');
  const ah = parseFloat(svg.getAttribute('height') || '0');
  if (aw > 0 && ah > 0) return { width: Math.round(aw), height: Math.round(ah) };
  const r = svg.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) return { width: Math.round(r.width), height: Math.round(r.height) };
  const vb = svg.getAttribute('viewBox')?.split(/\s+/);
  if (vb?.length === 4) return { width: parseFloat(vb[2]), height: parseFloat(vb[3]) };
  return { width: 0, height: 0 };
}

/** Render canvas contents as a PNG blob (with a 15 s timeout). */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Export timeout')), 15_000);
    canvas.toBlob((blob) => {
      clearTimeout(timer);
      blob ? resolve(blob) : reject(new Error('Blob creation failed'));
    }, 'image/png', 1.0);
  });
}

/** Serialize an SVG element and draw it onto ctx at the given size. */
function drawSVGOnCanvas(
  ctx: CanvasRenderingContext2D,
  svg: SVGElement,
  width: number,
  height: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SVG load timeout')), 10_000);
    const url =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(new XMLSerializer().serializeToString(svg));
    const img = new Image();
    img.onload = () => { clearTimeout(timer); ctx.drawImage(img, 0, 0, width, height); resolve(); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('SVG image load failed')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Sketch-path rendering
// ---------------------------------------------------------------------------

/**
 * Compute the affine transform that maps overlay-local sketch coordinates
 * to export-canvas pixel coordinates.
 *
 * The drawing overlay covers the *visible* chart viewport (right of y-axis).
 * The export canvas covers the full SVG (including the scrolled-away portion),
 * so scrollTop is added to the Y offset.
 */
function getDrawingTransform(
  container: HTMLElement,
  referenceSVG: SVGElement,
  targetWidth: number,
  targetHeight: number
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } | null {
  const overlay = container.querySelector('.gantt-drawing-canvas-overlay');
  if (!overlay) return null;
  const or = overlay.getBoundingClientRect();
  if (or.width <= 0 || or.height <= 0) return null;
  const sr = referenceSVG.getBoundingClientRect();
  const scaleX = targetWidth / or.width;
  const scaleY = targetHeight / or.height;
  const offsetX = (or.left - sr.left) * scaleX;
  let offsetY = (or.top - sr.top) * scaleY;
  const scrollBody = container.querySelector('.gantt-scroll-body') as HTMLElement | null;
  if (scrollBody) offsetY += scrollBody.scrollTop * scaleY;
  return { scaleX, scaleY, offsetX, offsetY };
}

/** Draw M/L paths onto a canvas context using the given transform. */
function drawPathsOnCanvas(
  ctx: CanvasRenderingContext2D,
  drawings: DrawingPath[],
  { scaleX, scaleY, offsetX, offsetY }: { scaleX: number; scaleY: number; offsetX: number; offsetY: number }
) {
  const scale = Math.max(scaleX, scaleY);
  for (const p of drawings) {
    if (!p?.path) continue;
    ctx.save();
    ctx.strokeStyle = p.color ?? '#ff0000';
    ctx.lineWidth = (p.width ?? 3) * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const m of p.path.matchAll(/([ML])\s*([\d.-]+)\s+([\d.-]+)/g)) {
      const px = parseFloat(m[2]) * scaleX + offsetX;
      const py = parseFloat(m[3]) * scaleY + offsetY;
      m[1] === 'M' ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Full left-panel export (D3 Gantt main path)
// ---------------------------------------------------------------------------

/**
 * Capture the entire left panel (widget area + chart topbar + y-axis + chart)
 * via html2canvas, then overlay sketch paths.
 *
 * Falls back to chart-container-only export if html2canvas is unavailable.
 */
async function exportFullLeftPanel(
  leftPanel: HTMLElement,
  drawings: DrawingPath[] | null | undefined
): Promise<Blob | null> {
  let html2canvasFn: (el: HTMLElement, opts?: any) => Promise<HTMLCanvasElement>;
  try {
    const mod = await import('html2canvas');
    html2canvasFn = mod.default;
  } catch {
    console.warn('html2canvas unavailable, falling back to chart-container export');
    const chartContainer = leftPanel.querySelector('.chart-container') as HTMLElement | null;
    return chartContainer ? exportDOMToCanvas(chartContainer, drawings) : null;
  }

  const canvas = await html2canvasFn(leftPanel, {
    width: leftPanel.offsetWidth,
    height: leftPanel.offsetHeight,
    useCORS: true,
    allowTaint: true,
    backgroundColor: '#ffffff',
    scale: 1,
    logging: false
  });

  if (drawings?.length) {
    const overlay = leftPanel.querySelector('.gantt-drawing-canvas-overlay');
    if (overlay) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const pr = leftPanel.getBoundingClientRect();
        const or = overlay.getBoundingClientRect();
        drawPathsOnCanvas(ctx, drawings, {
          scaleX: 1,
          scaleY: 1,
          offsetX: or.left - pr.left,
          offsetY: or.top - pr.top
        });
      }
    }
  }

  return canvasToBlob(canvas);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export the chart with any sketch drawings as a PNG blob.
 *
 * Three rendering paths:
 *   1. `.left-panel` root  → html2canvas full-panel capture  (D3 Gantt, main path)
 *   2. Observable Plot `<figure>` exists → foreignObject SVG → canvas image
 *   3. D3 Gantt chart-container → composite WebGL + 2D canvas + dependency SVG
 */
export async function exportDOMToCanvas(
  containerElement: HTMLElement,
  drawings: DrawingPath[] | null | undefined
): Promise<Blob | null> {
  try {
    // Path 1: full panel via html2canvas
    if (containerElement.classList.contains('left-panel')) {
      return exportFullLeftPanel(containerElement, drawings);
    }

    const chartDiv = containerElement.querySelector('.chart');
    if (!chartDiv) { console.error('Chart div (.chart) not found'); return null; }

    const figure = chartDiv.querySelector('figure');
    const svg = findMainSVG(figure ?? chartDiv);
    if (!svg) { console.error('No chart SVG found'); return null; }

    const { width, height } = figure
      ? (() => { const r = figure.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; })()
      : getSVGDimensions(svg);

    if (width < 10 || height < 10) {
      console.error('Invalid export dimensions:', width, 'x', height);
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) { console.error('Could not get canvas context'); return null; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (figure) {
      // Path 2: Observable Plot — wrap figure in foreignObject SVG and render as image
      const exportSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      exportSVG.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      exportSVG.setAttribute('width', String(width));
      exportSVG.setAttribute('height', String(height));
      const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      fo.setAttribute('width', String(width));
      fo.setAttribute('height', String(height));
      fo.setAttribute('x', '0');
      fo.setAttribute('y', '0');
      const clone = figure.cloneNode(true) as HTMLElement;
      inlineAllStyles(figure, clone);
      fo.appendChild(clone);
      exportSVG.appendChild(fo);
      await drawSVGOnCanvas(ctx, exportSVG, width, height);
    } else {
      // Path 3: D3 Gantt — composite canvas layers then dependency SVG
      const drawCanvas = (src: HTMLCanvasElement | null) => {
        if (src && src.width > 0 && src.height > 0) {
          try { ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, width, height); } catch (_) {}
        }
      };
      drawCanvas(chartDiv.querySelector<HTMLCanvasElement>('.gantt-webgl'));
      drawCanvas(chartDiv.querySelector<HTMLCanvasElement>('.gantt-canvas'));
      await drawSVGOnCanvas(ctx, svg, width, height);
    }

    // Overlay sketch paths on top of the chart layers
    const transform = getDrawingTransform(containerElement, svg, width, height);
    if (transform && drawings?.length) drawPathsOnCanvas(ctx, drawings, transform);

    return canvasToBlob(canvas);
  } catch (err) {
    console.error('Export failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Style inlining (used for Observable Plot figure clones)
// ---------------------------------------------------------------------------

/** Recursively copy computed styles from `source` into `target`. */
function inlineAllStyles(source: Element, target: Element) {
  if (!source || !target) return;
  try {
    const cs = window.getComputedStyle(source);
    if (source.namespaceURI === 'http://www.w3.org/2000/svg') {
      for (const prop of [
        'fill', 'stroke', 'stroke-width', 'stroke-opacity', 'fill-opacity', 'opacity',
        'font-family', 'font-size', 'font-weight', 'font-style',
        'text-anchor', 'dominant-baseline', 'color', 'display', 'visibility'
      ]) {
        const v = cs.getPropertyValue(prop);
        if (v && v !== 'none') {
          try { (target as HTMLElement).style.setProperty(prop, v); } catch (_) {}
        }
      }
      for (const attr of ['fill', 'stroke', 'stroke-width', 'opacity', 'transform']) {
        if (source.hasAttribute(attr)) target.setAttribute(attr, source.getAttribute(attr)!);
      }
    } else {
      for (let i = 0; i < cs.length; i++) {
        try { (target as HTMLElement).style.setProperty(cs[i], cs.getPropertyValue(cs[i])); } catch (_) {}
      }
    }
  } catch (_) {}
  const sc = Array.from(source.children);
  const tc = Array.from(target.children);
  for (let i = 0; i < Math.min(sc.length, tc.length); i++) inlineAllStyles(sc[i], tc[i]);
}
