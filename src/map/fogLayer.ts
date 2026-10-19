// Névoa de guerra como camada WebGL própria do MapLibre.
// 1) prerender: máscara (meia resolução) com uma "bolha" suave por célula explorada, projetada no chão.
// 2) render: nuvens animadas (fbm) sobre o chão, com borda pontilhada (Bayer), faíscas e brilho na fronteira.
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import { cellCenterMerc, CELLS_PER_AXIS, metersPerMercUnit, fromMerc } from '../game/geo.ts';

const BLOB_VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform float u_time;
in vec2 a_corner;
in vec4 a_inst; // x, y (mercator relativo à origem), raio (mercator), nascimento (s)
out vec2 v_uv;
out float v_grow;
void main() {
  float g = clamp((u_time - a_inst.w) / 1.1, 0.0, 1.0);
  g = 1.0 - pow(1.0 - g, 3.0);
  v_grow = g;
  v_uv = a_corner;
  vec2 p = a_inst.xy + a_corner * a_inst.z * mix(0.25, 1.0, g);
  gl_Position = u_matrix * vec4(p, 0.0, 1.0);
}`;

const BLOB_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_grow;
out vec4 o;
void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  float a = (1.0 - smoothstep(0.38, 1.0, d)) * v_grow;
  o = vec4(a, a, a, a);
}`;

const FOG_VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform float u_mpu;
in vec2 a_pos;
out vec2 v_world;
void main() {
  v_world = a_pos * u_mpu;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FOG_FS = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform vec2 u_viewport;
uniform float u_time;
uniform float u_opacity;
uniform float u_pixel;
uniform vec2 u_seed;
in vec2 v_world;
out vec4 o;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int idx = q.x + q.y * 4;
  float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return (m[idx] + 0.5) / 16.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_viewport;
  float reveal = texture(u_mask, uv).r;
  float fogAmt = clamp((0.92 - reveal) / 0.75, 0.0, 1.0);
  vec2 block = floor(gl_FragCoord.xy / u_pixel);
  float th = bayer4(block);
  float vis = step(th, fogAmt);

  vec2 w = v_world + u_seed;
  float n = fbm(w / 150.0 + vec2(u_time * 0.018, u_time * 0.007));
  float n2 = fbm(w / 60.0 - vec2(u_time * 0.03, -u_time * 0.01));
  vec3 deep = vec3(0.16, 0.13, 0.31);
  vec3 mid = vec3(0.33, 0.28, 0.58);
  vec3 light = vec3(0.67, 0.62, 0.93);
  float cloud = smoothstep(0.42, 0.78, n * 0.75 + n2 * 0.35);
  vec3 col = mix(deep, mid, smoothstep(0.25, 0.7, n));
  col = mix(col, light, cloud * 0.6);
  // tons em degraus com dithering (visual 16-bit)
  col = floor(col * 7.0 + th * 0.95) / 7.0;

  // faíscas que piscam (só quando há zoom suficiente para enxergar)
  float mpp = length(fwidth(v_world));
  vec2 cell = floor(w / 26.0);
  float h = hash(cell);
  vec2 f = (fract(w / 26.0) - 0.5) * 26.0;
  float twinkle = step(0.955, h) * max(0.0, sin(u_time * 2.6 + h * 60.0));
  float star = twinkle * step(abs(f.x) + abs(f.y), 1.8 * mpp) * step(mpp, 2.5);
  col = mix(col, vec3(1.0, 0.97, 0.86), star);

  float alpha = vis * u_opacity * mix(0.9, 1.0, cloud);
  // brilho dourado logo do lado de dentro da área revelada
  float glow = (1.0 - vis) * smoothstep(0.02, 0.5, fogAmt) * 0.45;
  vec3 glowCol = vec3(1.0, 0.85, 0.5);
  vec3 rgb = col * alpha + glowCol * glow * (1.0 - alpha);
  float a = alpha + glow * (1.0 - alpha);
  o = vec4(rgb, a);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`[fog] shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[fog] link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

/** M' = M * T(ox, oy), calculado em float64 para manter precisão no zoom de rua. */
function translated(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = m[i];
  for (let r = 0; r < 4; r++) out[12 + r] = m[r] * ox + m[4 + r] * oy + m[12 + r];
  return out;
}

const BLOB_RADIUS = 1.75 / CELLS_PER_AXIS;
const STRIDE = 4;

export class FogLayer implements CustomLayerInterface {
  readonly id = 'fog';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  /** Opacidade da névoa (mapa geral deixa as ruas um pouco mais visíveis). */
  opacity = 0.9;
  enabled = true;

  private map!: MLMap;
  private blobProg!: WebGLProgram;
  private fogProg!: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private blobVao!: WebGLVertexArrayObject;
  private fogVao!: WebGLVertexArrayObject;
  private instBuf!: WebGLBuffer;
  private fogBuf!: WebGLBuffer;
  private fbo!: WebGLFramebuffer;
  private tex!: WebGLTexture;
  private fbW = 0;
  private fbH = 0;

  private data = new Float32Array(STRIDE * 4096);
  private count = 0;
  private uploaded = 0;
  private capacityOnGpu = 0;
  private origin: { x: number; y: number } | null = null;
  private readonly t0 = performance.now();
  private readonly seed: [number, number] = [Math.random() * 5000, Math.random() * 5000];

  private now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  /** Substitui todas as células (carregamento). */
  setCells(keys: Iterable<number>): void {
    this.count = 0;
    this.uploaded = 0;
    this.addCells(keys, false);
  }

  /** Adiciona células; `animate` faz a clareira "abrir" suavemente. */
  addCells(keys: Iterable<number>, animate = true): void {
    const born = animate ? this.now() : -100;
    for (const key of keys) {
      const c = cellCenterMerc(key);
      if (!this.origin) this.origin = { x: c.x, y: c.y };
      if ((this.count + 1) * STRIDE > this.data.length) {
        const next = new Float32Array(this.data.length * 2);
        next.set(this.data);
        this.data = next;
      }
      const i = this.count * STRIDE;
      this.data[i] = c.x - this.origin.x;
      this.data[i + 1] = c.y - this.origin.y;
      this.data[i + 2] = BLOB_RADIUS;
      this.data[i + 3] = born;
      this.count++;
    }
    this.map?.triggerRepaint();
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    if (!this.origin) {
      const c = map.getCenter();
      const s = Math.sin((c.lat * Math.PI) / 180);
      this.origin = { x: (c.lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
    }
    this.blobProg = compile(gl, BLOB_VS, BLOB_FS);
    this.fogProg = compile(gl, FOG_VS, FOG_FS);
    for (const n of ['u_matrix', 'u_time']) this.u[`blob.${n}`] = gl.getUniformLocation(this.blobProg, n);
    for (const n of ['u_matrix', 'u_mpu', 'u_viewport', 'u_time', 'u_opacity', 'u_pixel', 'u_seed', 'u_mask']) {
      this.u[`fog.${n}`] = gl.getUniformLocation(this.fogProg, n);
    }

    // quad unitário instanciado para as bolhas
    this.blobVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.blobVao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aCorner = gl.getAttribLocation(this.blobProg, 'a_corner');
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const aInst = gl.getAttribLocation(this.blobProg, 'a_inst');
    gl.enableVertexAttribArray(aInst);
    gl.vertexAttribPointer(aInst, 4, gl.FLOAT, false, STRIDE * 4, 0);
    gl.vertexAttribDivisor(aInst, 1);

    this.fogVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fogVao);
    this.fogBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fogBuf);
    const aPos = gl.getAttribLocation(this.fogProg, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
    // contexto novo (mapa recriado): força realocar textura e buffer
    this.fbW = 0;
    this.fbH = 0;
    this.capacityOnGpu = 0;
    this.uploaded = 0;
  }

  onRemove(_map: MLMap, gl: WebGL2RenderingContext): void {
    gl.deleteProgram(this.blobProg);
    gl.deleteProgram(this.fogProg);
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.fogBuf);
    gl.deleteTexture(this.tex);
    gl.deleteFramebuffer(this.fbo);
  }

  private ensureTarget(gl: WebGL2RenderingContext): void {
    const w = Math.max(1, Math.floor(gl.drawingBufferWidth / 2));
    const h = Math.max(1, Math.floor(gl.drawingBufferHeight / 2));
    if (w === this.fbW && h === this.fbH) return;
    this.fbW = w;
    this.fbH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
  }

  private upload(gl: WebGL2RenderingContext): void {
    if (this.uploaded === this.count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    if (this.capacityOnGpu < this.data.length || this.uploaded === 0) {
      gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW);
      this.capacityOnGpu = this.data.length;
    } else {
      const from = this.uploaded * STRIDE;
      gl.bufferSubData(gl.ARRAY_BUFFER, from * 4, this.data, from, (this.count - this.uploaded) * STRIDE);
    }
    this.uploaded = this.count;
  }

  prerender(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.enabled || !this.origin) return;
    this.ensureTarget(gl);
    this.upload(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.fbW, this.fbH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.count > 0) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.useProgram(this.blobProg);
      const m = translated(args.defaultProjectionData.mainMatrix, this.origin.x, this.origin.y);
      gl.uniformMatrix4fv(this.u['blob.u_matrix'], false, m);
      gl.uniform1f(this.u['blob.u_time'], this.now());
      gl.bindVertexArray(this.blobVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
      gl.bindVertexArray(null);
      gl.blendEquation(gl.FUNC_ADD);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.enabled || !this.origin) return;
    const o = this.origin;
    // quadrilátero no chão cobrindo a área visível (com folga)
    const b = this.map.getBounds();
    const toM = (lng: number, lat: number) => {
      const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
      return [(lng + 180) / 360 - o.x, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) - o.y];
    };
    const [x0, y0] = toM(b.getWest(), b.getNorth());
    const [x1, y1] = toM(b.getEast(), b.getSouth());
    const padX = (x1 - x0) * 0.6;
    const padY = (y1 - y0) * 0.6;
    const ax = x0 - padX, bx = x1 + padX, ay = y0 - padY, by = y1 + padY;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fogBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ax, ay, bx, ay, ax, by, ax, by, bx, ay, bx, by]), gl.DYNAMIC_DRAW);

    const center = fromMerc(o.x, o.y);
    gl.useProgram(this.fogProg);
    const m = translated(args.defaultProjectionData.mainMatrix, o.x, o.y);
    // "pixel" do pontilhado = 3 px CSS, na resolução real do canvas
    const ratio = gl.drawingBufferWidth / Math.max(1, this.map.getCanvas().clientWidth);
    gl.uniformMatrix4fv(this.u['fog.u_matrix'], false, m);
    gl.uniform1f(this.u['fog.u_mpu'], metersPerMercUnit(center.lat));
    gl.uniform2f(this.u['fog.u_viewport'], gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.u['fog.u_time'], this.now());
    gl.uniform1f(this.u['fog.u_opacity'], this.opacity);
    gl.uniform1f(this.u['fog.u_pixel'], Math.max(2, Math.round(3 * ratio)));
    gl.uniform2f(this.u['fog.u_seed'], this.seed[0], this.seed[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u['fog.u_mask'], 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.fogVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}
