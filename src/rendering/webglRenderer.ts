type WebGLRendererInit = {
  canvas: HTMLCanvasElement;
};

export type WebGLInstanceData = {
  data: Float32Array;
  count: number;
};

export type WebGLRenderer = {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  setPalette: (palette: string[]) => void;
  draw: (instances: WebGLInstanceData, width: number, height: number) => void;
  clear: (width: number, height: number) => void;
  dispose: () => void;
};

const parseHexColor = (hex: string): [number, number, number, number] => {
  if (!hex || typeof hex !== 'string') return [0, 0, 0, 1];
  const cleaned = hex.trim().replace('#', '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : cleaned;
  if (full.length !== 6) return [0, 0, 0, 1];
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
};

const createShader = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('WebGL shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

const createProgram = (gl: WebGL2RenderingContext, vsSource: string, fsSource: string) => {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('WebGL program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
};

export const createWebGLRenderer = ({ canvas }: WebGLRendererInit): WebGLRenderer | null => {
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) return null;

  const vsSource = `#version 300 es
  precision highp float;
  in vec2 a_pos;
  in vec4 a_bounds;
  in float a_colorId;
  in float a_flags;
  uniform vec2 u_viewSize;
  out float v_colorId;
  out float v_flags;
  void main() {
    float x = mix(a_bounds.x, a_bounds.y, a_pos.x);
    float y = a_bounds.z + a_pos.y * a_bounds.w;
    float clipX = (x / u_viewSize.x) * 2.0 - 1.0;
    float clipY = 1.0 - (y / u_viewSize.y) * 2.0;
    gl_Position = vec4(clipX, clipY, 0.0, 1.0);
    v_colorId = a_colorId;
    v_flags = a_flags;
  }
  `;

  const fsSource = `#version 300 es
  precision highp float;
  uniform sampler2D u_palette;
  uniform float u_paletteSize;
  in float v_colorId;
  in float v_flags;
  out vec4 outColor;
  void main() {
    float idx = mod(v_colorId, u_paletteSize);
    float u = (idx + 0.5) / u_paletteSize;
    vec4 color = texture(u_palette, vec2(u, 0.5));
    outColor = color;
  }
  `;

  const program = createProgram(gl, vsSource, fsSource);
  if (!program) return null;

  const vao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  if (!vao || !quadBuffer || !instanceBuffer) return null;

  gl.bindVertexArray(vao);

  const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  const stride = 6 * 4;
  const boundsLoc = gl.getAttribLocation(program, 'a_bounds');
  gl.enableVertexAttribArray(boundsLoc);
  gl.vertexAttribPointer(boundsLoc, 4, gl.FLOAT, false, stride, 0);
  gl.vertexAttribDivisor(boundsLoc, 1);

  const colorLoc = gl.getAttribLocation(program, 'a_colorId');
  gl.enableVertexAttribArray(colorLoc);
  gl.vertexAttribPointer(colorLoc, 1, gl.FLOAT, false, stride, 16);
  gl.vertexAttribDivisor(colorLoc, 1);

  const flagsLoc = gl.getAttribLocation(program, 'a_flags');
  gl.enableVertexAttribArray(flagsLoc);
  gl.vertexAttribPointer(flagsLoc, 1, gl.FLOAT, false, stride, 20);
  gl.vertexAttribDivisor(flagsLoc, 1);

  gl.bindVertexArray(null);

  const paletteTex = gl.createTexture();
  if (!paletteTex) return null;
  gl.bindTexture(gl.TEXTURE_2D, paletteTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let paletteSize = 1;

  const viewLoc = gl.getUniformLocation(program, 'u_viewSize');
  const paletteLoc = gl.getUniformLocation(program, 'u_palette');
  const paletteSizeLoc = gl.getUniformLocation(program, 'u_paletteSize');

  const setPalette = (palette: string[]) => {
    const colors = Array.isArray(palette) && palette.length > 0 ? palette : ['#6b7280'];
    paletteSize = colors.length;
    const data = new Uint8Array(paletteSize * 4);
    colors.forEach((hex, idx) => {
      const [r, g, b, a] = parseHexColor(hex);
      data[idx * 4 + 0] = Math.round(r * 255);
      data[idx * 4 + 1] = Math.round(g * 255);
      data[idx * 4 + 2] = Math.round(b * 255);
      data[idx * 4 + 3] = Math.round(a * 255);
    });
    gl.bindTexture(gl.TEXTURE_2D, paletteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, paletteSize, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  };

  const clear = (width: number, height: number) => {
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const draw = (instances: WebGLInstanceData, width: number, height: number) => {
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.data, gl.DYNAMIC_DRAW);

    gl.uniform2f(viewLoc, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, paletteTex);
    gl.uniform1i(paletteLoc, 0);
    gl.uniform1f(paletteSizeLoc, Math.max(1, paletteSize));

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  };

  const dispose = () => {
    gl.deleteBuffer(quadBuffer);
    gl.deleteBuffer(instanceBuffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    gl.deleteTexture(paletteTex);
  };

  return { gl, canvas, setPalette, draw, clear, dispose };
};
