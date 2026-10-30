// glsl.js: raw WebGL2 fragment-shader scenes (raymarched 3-D) drawn into the film's 2-D canvas.
// No three.js: each scene is one fragment shader on a full-screen triangle, rendered at an internal
// resolution and scaled up. Uniforms are set from (t, params) every call, so a frame is a pure
// function of time like the rest of the film.

import * as M from './motion.js';

let gl = null, cv = null, vbo = null;
const progs = {};

// Shared GLSL: hashing, value/fbm noise, rotations, SDF helpers, ACES tone map.
export const COMMON = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 iRes;
uniform float iTime;
uniform float P[8];
out vec4 outColor;
#define PI 3.14159265
float hash(float n){ return fract(sin(n)*43758.5453123); }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec3 x){
  vec3 p=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  float n=p.x+p.y*57.0+113.0*p.z;
  return mix(mix(mix(hash(n),hash(n+1.0),f.x),mix(hash(n+57.0),hash(n+58.0),f.x),f.y),
             mix(mix(hash(n+113.0),hash(n+114.0),f.x),mix(hash(n+170.0),hash(n+171.0),f.x),f.y),f.z);
}
float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }
float fbm3(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<3;i++){ s+=a*noise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float smin(float a, float b, float k){ float h=clamp(0.5+0.5*(b-a)/k,0.0,1.0); return mix(b,a,h)-k*h*(1.0-h); }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
vec3 camRay(vec2 uv, vec3 ro, vec3 ta, float fl){
  vec3 f=normalize(ta-ro), r=normalize(cross(f,vec3(0,1,0))), u=cross(r,f);
  return normalize(uv.x*r+uv.y*u+fl*f);
}
// starfield in a direction
vec3 stars(vec3 rd){
  vec3 c=vec3(0);
  for(int i=0;i<3;i++){
    float sc=120.0+float(i)*90.0;
    vec3 q=rd*sc; vec3 id=floor(q); vec3 f=fract(q)-0.5;
    float h=hash(dot(id,vec3(1.0,57.0,113.0))+float(i)*7.0);
    float d=length(f);
    c+=step(0.965,h)*smoothstep(0.12,0.0,d)*(0.6+0.8*hash(h*91.0))*mix(vec3(0.7,0.8,1.0),vec3(1.0,0.85,0.7),hash(h*13.0));
  }
  return c;
}
`;

export function init(w, h) {
  cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
  vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(log + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    throw new Error(log);
  }
  return s;
}

export function scene(name, body) {
  const vs = `#version 300 es
in vec2 pos; void main(){ gl_Position = vec4(pos, 0.0, 1.0); }`;
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, COMMON + '\n' + body + '\n'));
  gl.bindAttribLocation(p, 0, 'pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  progs[name] = { p, uRes: gl.getUniformLocation(p, 'iRes'), uTime: gl.getUniformLocation(p, 'iTime'), uP: gl.getUniformLocation(p, 'P') };
}

// Render scene `name` at local time t with params P[0..7]; draw onto ctx covering the frame.
export function draw(ctx, name, t, params = [], { x = 0, y = 0, w = M.W, h = M.H, alpha = 1, blend = null } = {}) {
  const s = progs[name];
  gl.viewport(0, 0, cv.width, cv.height);
  gl.useProgram(s.p);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(s.uRes, cv.width, cv.height);
  gl.uniform1f(s.uTime, t);
  const P = new Float32Array(8);
  params.forEach((v, i) => { P[i] = v; });
  gl.uniform1fv(s.uP, P);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (blend) ctx.globalCompositeOperation = blend;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cv, x, y, w, h);
  ctx.restore();
}
