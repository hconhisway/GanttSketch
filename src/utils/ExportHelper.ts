/**
 * Export chart with drawings - simplified approach
 */

interface DrawingPath {
  id?: string;
  path: string;
  color?: string;
  width?: number;
}

export async function exportDOMToCanvas(
  containerElement: HTMLElement,
  drawings: DrawingPath[] | null | undefined
): Promise<Blob | null> {
  try {
    console.log('=== Starting Chart Export ===');

    // Get the chart div
    const chartDiv = containerElement.querySelector('.chart');
    if (!chartDiv) {
      console.error('❌ Chart div not found');
      return null;
    }

    console.log('✓ Chart div found');

    // Observable Plot returns a <figure> element containing an SVG
    const figure = chartDiv.querySelector('figure');

    if (!figure) {
      console.error('❌ Figure element not found');
      console.log('Looking for direct SVG instead...');
      // Fallback: maybe it's just an SVG without figure wrapper
    }

    // Get the SVG - need to find the MAIN chart SVG, not legend swatches
    // Observable Plot's figure contains multiple SVGs: the main chart + legend swatches
    let svg: SVGElement | null = null;

    if (figure) {
      // Find all SVGs in the figure
      const svgsInFigure = Array.from(figure.querySelectorAll('svg'));
      console.log('Found', svgsInFigure.length, 'SVG elements in figure');

      // Pick the largest one (main chart is biggest)
      let maxArea = 0;
      for (const svgEl of svgsInFigure) {
        const rect = svgEl.getBoundingClientRect();
        const area = rect.width * rect.height;
        console.log('SVG:', rect.width, 'x', rect.height, '=', area, 'px²');
        if (area > maxArea) {
          maxArea = area;
          svg = svgEl;
        }
      }
    } else {
      // If no figure, look for SVG but exclude the drawing overlay
      const allSvgs = Array.from(chartDiv.querySelectorAll('svg'));
      let maxArea = 0;
      for (const svgEl of allSvgs) {
        // Skip the drawing overlay
        if (svgEl.classList.contains('gantt-drawing-canvas-overlay')) {
          continue;
        }
        const rect = svgEl.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > maxArea) {
          maxArea = area;
          svg = svgEl;
        }
      }
    }

    if (!svg) {
      console.error('❌ SVG not found');
      console.log('Chart div HTML:', chartDiv.innerHTML.substring(0, 500));
      return null;
    }

    console.log('✓ Main chart SVG selected (largest)');
    console.log('SVG class:', svg.getAttribute('class'));
    console.log('SVG has children:', svg.children.length);

    // We need to export the entire figure (which includes legend), not just the SVG
    let exportElement: Element = svg;
    let width = 0;
    let height = 0;

    // If there's a figure, export the entire figure (includes chart + legend)
    if (figure) {
      exportElement = figure;
      const figureRect = figure.getBoundingClientRect();
      width = Math.round(figureRect.width);
      height = Math.round(figureRect.height);
      console.log('✓ Exporting entire figure (includes legend)');
      console.log('Figure dimensions:', width, 'x', height);
    } else {
      // No figure, just export the SVG
      const svgRect = svg.getBoundingClientRect();
      width = Math.round(svgRect.width);
      height = Math.round(svgRect.height);
      console.log('SVG BBox dimensions:', width, 'x', height);
    }

    // Try 3: Get from SVG width/height attributes
    if (width === 0 || height === 0) {
      const attrWidth = svg.getAttribute('width');
      const attrHeight = svg.getAttribute('height');
      if (attrWidth && attrHeight) {
        width = parseFloat(attrWidth);
        height = parseFloat(attrHeight);
        console.log('SVG attribute dimensions:', width, 'x', height);
      }
    }

    // Try 4: Get from viewBox
    if (width === 0 || height === 0) {
      const viewBox = svg.getAttribute('viewBox');
      if (viewBox) {
        const parts = viewBox.split(/\s+/);
        if (parts.length === 4) {
          width = parseFloat(parts[2]);
          height = parseFloat(parts[3]);
          console.log('ViewBox dimensions:', width, 'x', height);
        }
      }
    }

    console.log('Final dimensions:', width, 'x', height);
    console.log('SVG width attr:', svg.getAttribute('width'));
    console.log('SVG height attr:', svg.getAttribute('height'));
    console.log('SVG viewBox:', svg.getAttribute('viewBox'));
    console.log('Number of drawings:', drawings ? drawings.length : 0);

    if (width === 0 || height === 0 || width < 100 || height < 100) {
      console.error('❌ Invalid or suspiciously small dimensions:', width, 'x', height);
      console.error('This might be a legend or small element, not the main chart');
      return null;
    }

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    if (!ctx) {
      console.error('❌ Could not get canvas context');
      return null;
    }

    console.log('✓ Canvas created:', width, 'x', height);

    // White background
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);

    // Create wrapper SVG for export
    let finalSVG: SVGElement;

    if (exportElement === figure) {
      // Export the entire figure (chart + legend) using foreignObject
      console.log('Creating SVG wrapper for figure (includes legend)...');

      finalSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      finalSVG.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      finalSVG.setAttribute('width', width.toString());
      finalSVG.setAttribute('height', height.toString());

      // Clone the figure
      const figureClone = figure.cloneNode(true) as HTMLElement;
      inlineAllStyles(figure, figureClone);

      // Find the main SVG in the cloned figure to add drawings
      const clonedSVGs = Array.from(figureClone.querySelectorAll('svg'));
      let mainSVGClone: SVGElement | null = null;
      let maxArea = 0;
      for (const svgEl of clonedSVGs) {
        const area =
          parseFloat(svgEl.getAttribute('width') || '0') *
          parseFloat(svgEl.getAttribute('height') || '0');
        if (area > maxArea) {
          maxArea = area;
          mainSVGClone = svgEl;
        }
      }

      // Wrap figure in foreignObject
      const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      foreignObject.setAttribute('width', width.toString());
      foreignObject.setAttribute('height', height.toString());
      foreignObject.setAttribute('x', '0');
      foreignObject.setAttribute('y', '0');
      foreignObject.appendChild(figureClone);
      finalSVG.appendChild(foreignObject);

      // Now add drawings to the main SVG clone if found
      if (mainSVGClone && drawings && drawings.length > 0) {
        console.log('Adding drawings to main SVG within figure...');
        addDrawingsToSVG(mainSVGClone, drawings, containerElement, svg);
      }
    } else {
      // Export just the SVG (no figure)
      console.log('Exporting SVG only...');
      finalSVG = svg.cloneNode(true) as SVGElement;

      // Set proper SVG attributes
      finalSVG.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      finalSVG.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      finalSVG.setAttribute('width', width.toString());
      finalSVG.setAttribute('height', height.toString());

      // Inline all styles
      console.log('Inlining styles...');
      inlineAllStyles(svg, finalSVG);

      // Add drawings
      if (drawings && drawings.length > 0) {
        addDrawingsToSVG(finalSVG, drawings, containerElement, svg);
      }
    }

    // Serialize SVG
    const serializer = new XMLSerializer();
    let svgString = serializer.serializeToString(finalSVG);

    console.log('✓ SVG serialized, length:', svgString.length);
    console.log('Preview:', svgString.substring(0, 200));

    // Create data URL
    const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);

    // Load and render
    return new Promise((resolve, reject) => {
      const img = new Image();

      const timeout = setTimeout(() => {
        console.error('⏱️ Timeout after 15s');
        reject(new Error('Timeout'));
      }, 15000);

      img.onload = () => {
        clearTimeout(timeout);
        console.log('✅ Image loaded:', img.naturalWidth, 'x', img.naturalHeight);
        console.log('Drawing to canvas:', width, 'x', height);

        try {
          // Draw to canvas
          ctx.drawImage(img, 0, 0, width, height);

          // Verify content
          const sample = ctx.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1);
          console.log('Center pixel:', Array.from(sample.data).slice(0, 3));

          // Check if we have actual content (not just white)
          const hasContent =
            sample.data[0] !== 255 || sample.data[1] !== 255 || sample.data[2] !== 255;
          console.log('Has non-white content:', hasContent);

          // Convert to PNG
          canvas.toBlob(
            (blob) => {
              if (blob) {
                console.log('✅ Export complete!', (blob.size / 1024).toFixed(1), 'KB');
                resolve(blob);
              } else {
                console.error('❌ Blob creation failed');
                reject(new Error('Blob creation failed'));
              }
            },
            'image/png',
            1.0
          );
        } catch (err) {
          console.error('❌ Canvas error:', err);
          reject(err);
        }
      };

      img.onerror = (err) => {
        clearTimeout(timeout);
        console.error('❌ Image load failed:', err);
        console.log('Data URL length:', svgDataUrl.length);
        console.log('SVG sample:\n', svgString.substring(0, 1000));
        reject(new Error('Image load failed'));
      };

      img.src = svgDataUrl;
      console.log('Loading image from data URL...');
    });
  } catch (error) {
    console.error('❌ Fatal error:', error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    return null;
  }
}

/**
 * Helper function to add drawings to an SVG element
 */
function addDrawingsToSVG(
  svgElement: SVGElement,
  drawings: DrawingPath[],
  containerElement: HTMLElement,
  originalSVG: SVGElement
) {
  console.log('Adding', drawings.length, 'annotations...');

  // Get the drawing overlay and chart SVG positions
  const drawingOverlay = containerElement.querySelector('.gantt-drawing-canvas-overlay');

  if (!drawingOverlay) {
    console.warn('Drawing overlay not found, adding paths without transformation');
  }

  // Get actual screen positions
  const overlayRect = drawingOverlay ? drawingOverlay.getBoundingClientRect() : null;
  const svgRect = originalSVG.getBoundingClientRect();

  console.log(
    'Drawing overlay rect:',
    overlayRect
      ? `${overlayRect.width}x${overlayRect.height} at (${overlayRect.left}, ${overlayRect.top})`
      : 'not found'
  );
  console.log(
    'Chart SVG rect:',
    `${svgRect.width}x${svgRect.height} at (${svgRect.left}, ${svgRect.top})`
  );

  // Get SVG dimensions for scaling
  const svgWidth = parseFloat(svgElement.getAttribute('width') || '0') || svgRect.width;
  const svgHeight = parseFloat(svgElement.getAttribute('height') || '0') || svgRect.height;

  // Calculate transformation parameters
  let scaleX = 1;
  let scaleY = 1;
  let offsetX = 0;
  let offsetY = 0;

  if (overlayRect && svgRect) {
    console.log('=== Coordinate Mapping ===');
    // Scale from overlay screen size to SVG screen size, then to export size
    scaleX = svgWidth / overlayRect.width;
    scaleY = svgHeight / overlayRect.height;

    // Position offset
    const posOffsetX = overlayRect.left - svgRect.left;
    const posOffsetY = overlayRect.top - svgRect.top;

    offsetX = posOffsetX * scaleX;
    offsetY = posOffsetY * scaleY;

    console.log('  Scale:', scaleX.toFixed(6), 'x', scaleY.toFixed(6));
    console.log('  Offset:', offsetX.toFixed(3), ',', offsetY.toFixed(3));
  }

  const annotationsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  annotationsGroup.setAttribute('class', 'export-annotations');

  let addedCount = 0;
  drawings.forEach((pathData, index) => {
    if (pathData && pathData.path) {
      const transformedPath = transformPathCoordinates(
        pathData.path,
        scaleX,
        scaleY,
        offsetX,
        offsetY
      );

      if (index === 0) {
        console.log('First path transform example:', pathData.path.substring(0, 80), '...');
      }

      const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathElement.setAttribute('d', transformedPath);
      pathElement.setAttribute('stroke', pathData.color || '#ff0000');
      pathElement.setAttribute(
        'stroke-width',
        ((pathData.width || 3) * Math.max(scaleX, scaleY)).toString()
      );
      pathElement.setAttribute('fill', 'none');
      pathElement.setAttribute('stroke-linecap', 'round');
      pathElement.setAttribute('stroke-linejoin', 'round');
      annotationsGroup.appendChild(pathElement);
      addedCount++;
    }
  });

  if (addedCount > 0) {
    svgElement.appendChild(annotationsGroup);
    console.log('✓ Added', addedCount, 'drawing paths to SVG');
  }
}

/**
 * Transform SVG path coordinates by scale and offset
 * Formula: newCoord = originalCoord * scale + offset
 */
function transformPathCoordinates(
  pathString: string,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number
) {
  // Parse and transform M (moveto) and L (lineto) commands
  return pathString.replace(/([ML])\s*([\d.]+)\s+([\d.]+)/g, (match, command, x, y) => {
    const newX = (parseFloat(x) * scaleX + offsetX).toFixed(2);
    const newY = (parseFloat(y) * scaleY + offsetY).toFixed(2);
    return `${command} ${newX} ${newY}`;
  });
}

/**
 * Recursively inline all computed styles from source to target
 */
function inlineAllStyles(sourceElement: Element, targetElement: Element) {
  if (!sourceElement || !targetElement) return;

  try {
    const computed = window.getComputedStyle(sourceElement);
    const tagName = sourceElement.tagName.toLowerCase();

    // For SVG elements, copy important properties
    if (tagName === 'svg' || sourceElement.namespaceURI === 'http://www.w3.org/2000/svg') {
      const svgProps = [
        'fill',
        'stroke',
        'stroke-width',
        'stroke-opacity',
        'fill-opacity',
        'opacity',
        'font-family',
        'font-size',
        'font-weight',
        'font-style',
        'text-anchor',
        'dominant-baseline',
        'color',
        'display',
        'visibility'
      ];

      for (const prop of svgProps) {
        const value = computed.getPropertyValue(prop);
        if (value && value !== 'none' && value !== '') {
          try {
            (targetElement as HTMLElement).style.setProperty(prop, value);
          } catch (e) {
            // Skip
          }
        }
      }

      // Copy presentation attributes
      const attrs = ['fill', 'stroke', 'stroke-width', 'opacity', 'transform'];
      for (const attr of attrs) {
        if (sourceElement.hasAttribute(attr)) {
          targetElement.setAttribute(attr, sourceElement.getAttribute(attr) || '');
        }
      }
    } else {
      // For HTML elements, copy all styles
      for (let i = 0; i < computed.length; i++) {
        const prop = computed[i];
        try {
          (targetElement as HTMLElement).style.setProperty(prop, computed.getPropertyValue(prop));
        } catch (e) {
          // Skip
        }
      }
    }
  } catch (e) {
    // Silently skip errors
  }

  // Recursively process children
  const sourceChildren = Array.from(sourceElement.children || []);
  const targetChildren = Array.from(targetElement.children || []);

  for (let i = 0; i < Math.min(sourceChildren.length, targetChildren.length); i++) {
    inlineAllStyles(sourceChildren[i], targetChildren[i]);
  }
}
