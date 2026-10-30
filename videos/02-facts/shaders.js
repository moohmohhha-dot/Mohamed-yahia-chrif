// The film's 3-D sets, one fragment shader each. iTime is the scene's local time in seconds;
// P[0..7] are per-scene controls set by film.js (camera, progress, pulses).

// ---------------------------------------------------------------- intro: golden ringed world in a nebula
// P0 camera push 0..1, P1 ring glow
export const intro = /* glsl */ `
vec3 nebula(vec3 rd){
  float n = fbm(rd*2.2 + vec3(0.0, 0.0, iTime*0.03));
  float m = fbm(rd*4.5 - vec3(iTime*0.02));
  vec3 c = mix(vec3(0.02,0.01,0.05), vec3(0.35,0.08,0.45), smoothstep(0.35,0.8,n));
  c = mix(c, vec3(0.95,0.55,0.18), smoothstep(0.55,0.95,m*n*1.6)*0.8);
  return c*0.9 + stars(rd);
}
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  float k = P[0];
  vec3 ro = vec3(sin(iTime*0.12)*1.2, 0.9 - k*0.5, 10.5 - k*3.0);
  vec3 rd = camRay(uv, ro, vec3(0.0, 0.0, 0.0), 1.9);
  rd.xy *= rot(-0.18);
  vec3 col = nebula(rd);
  vec3 L = normalize(vec3(-0.7, 0.4, 0.6));
  // planet (sphere r=1.6)
  float R = 1.6;
  float b = dot(ro, rd), c = dot(ro,ro) - R*R, h = b*b - c;
  float tP = h > 0.0 ? -b - sqrt(h) : 1e9;
  // ring plane y=0 (tilted)
  vec3 ror = ro, rdr = rd;
  ror.xy *= rot(0.35); rdr.xy *= rot(0.35);
  float tR = -ror.y/rdr.y;
  vec3 pr = ror + rdr*tR;
  float rr = length(pr.xz);
  float ringA = (tR > 0.0 && rr > 2.1 && rr < 3.6) ? 1.0 : 0.0;
  float bands = 0.55 + 0.45*sin(rr*38.0)*sin(rr*11.0+1.3);
  vec3 ringC = mix(vec3(0.9,0.6,0.2), vec3(1.0,0.9,0.6), bands) * (0.6 + 1.4*P[1]);
  float ringAlpha = ringA * (0.55 + 0.4*bands) * smoothstep(2.1,2.3,rr) * smoothstep(3.6,3.3,rr);
  // planet shading
  if (tP < 1e8) {
    vec3 p = ro + rd*tP, n = normalize(p);
    vec3 q = n; q.xz *= rot(iTime*0.15);
    float band = fbm(vec3(q.y*7.0, q.x*1.5, q.z*1.5) + fbm(q*3.0)*1.5);
    vec3 alb = mix(vec3(0.45,0.22,0.06), vec3(1.0,0.78,0.38), band);
    float dif = max(dot(n, L), 0.0);
    // ring shadow on planet
    vec3 pl = p; pl.xy *= rot(0.35); vec3 Ll = L; Ll.xy *= rot(0.35);
    float ts = -pl.y/Ll.y; vec3 ps = pl + Ll*ts; float rs = length(ps.xz);
    float sh = (ts > 0.0 && rs > 2.1 && rs < 3.6) ? 0.35 : 1.0;
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 pc = alb*(dif*sh*1.6 + 0.04) + vec3(1.0,0.6,0.25)*fres*0.9;
    if (ringAlpha > 0.0 && tR < tP) pc = mix(pc, ringC, ringAlpha);
    col = pc;
  } else if (ringAlpha > 0.0) {
    // planet shadow on ring
    vec3 pw = ro + rd*tR;
    float bb = dot(pw, L), cc = dot(pw,pw) - R*R;
    float inSh = (bb*bb - cc > 0.0 && bb < 0.0) ? 0.25 : 1.0;
    col = mix(col, ringC*inSh, ringAlpha);
  }
  // atmosphere glow
  float dc = length(cross(ro, rd));
  col += vec3(1.0,0.55,0.2) * exp(-max(dc - R, 0.0)*4.0) * 0.35 * step(tP, 1e8 - 1.0) * 0.0;
  col += vec3(1.0,0.6,0.25) * exp(-max(dc - R, 0.0)*3.0) * 0.45 * (1.0 - step(tP, 1e8));
  // sun flare top-left
  float sd = max(dot(rd, L), 0.0);
  col += vec3(1.0,0.8,0.5)*pow(sd, 400.0)*6.0 + vec3(1.0,0.5,0.2)*pow(sd, 12.0)*0.25;
  col = aces(col*1.1);
  col *= 1.0 - 0.35*dot(uv*0.6, uv*0.6);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;

// ---------------------------------------------------------------- sun -> earth, light travels
// P0 light pulse progress 0..1, P1 camera drift 0..1
export const sun = /* glsl */ `
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  vec3 ro = vec3(-1.0 + P[1]*2.0, 0.6, 9.0);
  vec3 ta = vec3(-0.3 + P[1]*0.8, 0.0, 0.0);
  vec3 rd = camRay(uv, ro, ta, 1.7);
  vec3 col = stars(rd)*0.8;
  vec3 S = vec3(-3.2, 0.0, 0.0); float RS = 2.2;
  vec3 E = vec3(3.6, -0.2, 1.2); float RE = 0.42;
  // sun
  vec3 oc = ro - S; float b = dot(oc, rd), c = dot(oc,oc) - RS*RS, h = b*b - c;
  float tS = h > 0.0 ? -b - sqrt(h) : 1e9;
  float dS = length(cross(oc, rd));
  if (tS < 1e8) {
    vec3 n = normalize(oc + rd*tS);
    vec3 q = n*4.0; q.xz *= rot(iTime*0.05);
    float g = fbm(q + vec3(0.0, iTime*0.25, 0.0) + fbm(q*1.7 - iTime*0.15)*1.2);
    float limb = pow(max(dot(n, -rd), 0.0), 0.5);
    col = mix(vec3(0.9,0.25,0.02), vec3(1.0,0.85,0.4), g) * (1.4 + 2.6*g) * (0.4 + 0.6*limb);
  }
  // corona + prominences
  float ang = atan(dot(cross(oc, rd), vec3(0,0,1)), dot(cross(oc, rd), vec3(0,1,0)));
  float cor = exp(-max(dS - RS, 0.0)*1.6);
  float ray = 0.5 + 0.5*fbm(vec3(ang*3.0, dS*1.5 - iTime*0.4, 1.0));
  col += vec3(1.0,0.45,0.08)*cor*(0.7 + ray*0.8) * (tS < 1e8 ? 0.3 : 1.0);
  col += vec3(1.0,0.7,0.3)*exp(-max(dS - RS, 0.0)*0.45)*0.25;
  // earth
  vec3 oe = ro - E; b = dot(oe, rd); c = dot(oe,oe) - RE*RE; h = b*b - c;
  float tE = h > 0.0 ? -b - sqrt(h) : 1e9;
  vec3 Ld = normalize(S - E);
  if (tE < 1e8 && tE < tS) {
    vec3 n = normalize(oe + rd*tE);
    vec3 q = n; q.xz *= rot(iTime*0.2);
    float land = smoothstep(0.52, 0.56, fbm(q*2.5));
    float cl = smoothstep(0.5, 0.75, fbm(q*4.0 + vec3(iTime*0.05)));
    vec3 alb = mix(vec3(0.02,0.1,0.35), vec3(0.15,0.35,0.1), land);
    alb = mix(alb, vec3(0.95), cl);
    float dif = max(dot(n, Ld), 0.0);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    col = alb*dif*1.8 + vec3(0.3,0.6,1.0)*fres*(0.3 + dif);
  }
  float dE = length(cross(oe, rd));
  col += vec3(0.3,0.6,1.0)*exp(-max(dE - RE, 0.0)*25.0)*0.35*(tE > 1e8 ? 1.0 : 0.0);
  // the light pulse travelling sun -> earth
  float pp = P[0];
  if (pp > 0.0 && pp < 1.02) {
    vec3 a = S + normalize(E - S)*RS, e = E - normalize(E - S)*RE;
    vec3 L = mix(a, e, clamp(pp, 0.0, 1.0));
    // distance from ray to segment a..L (the trail) and to head L
    vec3 ab = L - a;
    // closest points between ray and segment (approx: sample along trail)
    float trail = 0.0;
    for (int i = 0; i < 12; i++) {
      float s = float(i)/11.0;
      vec3 pt = mix(a, L, s);
      vec3 w = pt - ro; float d = length(cross(w, rd));
      trail += exp(-d*40.0) * s * s;
    }
    vec3 w = L - ro; float dh = length(cross(w, rd));
    col += vec3(1.0,0.9,0.6)*(exp(-dh*18.0)*2.5 + exp(-dh*4.0)*0.4);
    col += vec3(1.0,0.75,0.35)*trail*0.18;
  }
  col = aces(col);
  col *= 1.0 - 0.3*dot(uv*0.55, uv*0.55);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;

// ---------------------------------------------------------------- heart
// P0 pulse amount 0..1 (beat), P1 camera orbit
export const heart = /* glsl */ `
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2){
  vec3 ba = b - a; float l2 = dot(ba,ba); float rr = r1 - r2; float a2 = l2 - rr*rr; float il2 = 1.0/l2;
  vec3 pa = p - a; float y = dot(pa,ba); float z = y - l2;
  vec3 xv = pa*l2 - ba*y; float x2 = dot(xv,xv); float y2 = y*y*l2; float z2 = z*z*l2;
  float k = sign(rr)*rr*rr*x2;
  if (sign(z)*a2*z2 > k) return sqrt(x2 + z2)*il2 - r2;
  if (sign(y)*a2*y2 < k) return sqrt(x2 + y2)*il2 - r1;
  return (sqrt(x2*a2*il2) + y*rr)*il2 - r1;
}
float map(vec3 p){
  float s = 1.0 + 0.09*P[0];
  p /= s;
  p.x = abs(p.x);
  float lobe = length(p - vec3(0.42, 0.28, 0.0)) - 0.58;
  float cone = sdRoundCone(p, vec3(0.42, 0.22, 0.0), vec3(0.0, -0.95, 0.0), 0.55, 0.06);
  float d = smin(lobe, cone, 0.12);
  d = -smin(-d, -(abs(p.z) - 0.5 + 0.1*p.x*p.x), 0.18);   // flatten front/back, softly
  d -= 0.012*noise(p*18.0);
  return d*s*0.85;
}
vec3 nrm(vec3 p){ vec2 e = vec2(0.002, 0.0); return normalize(vec3(map(p+e.xyy)-map(p-e.xyy), map(p+e.yxy)-map(p-e.yxy), map(p+e.yyx)-map(p-e.yyx))); }
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  float a = P[1];
  vec3 ro = vec3(sin(a)*3.6, 0.15, cos(a)*3.6);
  vec3 rd = camRay(uv - vec2(0.55, 0.0), ro, vec3(0.0,-0.1,0.0), 2.0);
  // background: deep red with floating cells
  vec3 col = mix(vec3(0.05,0.0,0.01), vec3(0.28,0.02,0.04), smoothstep(1.2, -0.2, length(uv - vec2(0.55,0.0))));
  for (int i = 0; i < 3; i++) {
    float z = 1.0 + float(i)*0.7;
    vec2 q = uv*z*3.0 + vec2(iTime*0.15*z, sin(iTime*0.3 + float(i))*0.2);
    vec2 id = floor(q); vec2 f = fract(q) - 0.5;
    float hh = hash2(id + float(i)*17.0);
    vec2 o = vec2(hash2(id+3.1), hash2(id+7.7)) - 0.5;
    float d = length(f - o*0.5);
    col += vec3(0.6,0.05,0.07)*smoothstep(0.18/z, 0.05/z, d)*step(0.6, hh)*0.35/z;
  }
  // pulse ring
  float pr = fract(iTime*0.75);
  float t = 0.0, d = 1.0;
  for (int i = 0; i < 80; i++) { d = map(ro + rd*t); if (d < 0.001 || t > 8.0) break; t += d; }
  if (d < 0.01) {
    vec3 p = ro + rd*t, n = nrm(p);
    vec3 L1 = normalize(vec3(0.6, 0.8, 0.7)), L2 = normalize(vec3(-0.8, 0.2, -0.6));
    float dif = max(dot(n, L1), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 hv = normalize(L1 - rd);
    float spec = pow(max(dot(n, hv), 0.0), 60.0);
    float sss = pow(max(dot(rd, -L2), 0.0)*0.5 + 0.5, 2.0);
    float veins = smoothstep(0.62, 0.7, fbm(p*6.0));
    vec3 alb = mix(vec3(0.55,0.02,0.04), vec3(0.95,0.12,0.12), dif);
    alb = mix(alb, vec3(0.25,0.0,0.05), veins*0.7);
    col = alb*(0.15 + dif*1.3) + vec3(1.0,0.25,0.2)*rim*(1.0 + P[0]*1.5) + vec3(1.0,0.85,0.8)*spec*1.6 + vec3(0.5,0.0,0.02)*sss*0.3;
    col += vec3(1.0,0.1,0.1)*P[0]*0.25;
  }
  // glow around the heart
  vec3 w = -ro; float dc = length(cross(w, rd));
  col += vec3(1.0,0.1,0.12)*exp(-dc*1.6)*(0.18 + 0.35*P[0]);
  col = aces(col*1.2);
  col *= 1.0 - 0.3*dot(uv*0.55, uv*0.55);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;

// ---------------------------------------------------------------- octopus in the deep with 3 glowing hearts
// P0 hearts glow 0..1, P1 camera push
export const octopus = /* glsl */ `
float tent(vec3 p, out float s){
  // polar repetition: 8 tentacles around y
  float an = atan(p.z, p.x);
  float sec = 2.0*PI/8.0;
  float id = floor((an + sec*0.5)/sec);
  float a2 = an - id*sec;
  float r = length(p.xz);
  vec3 q = vec3(r*cos(a2), p.y, r*sin(a2));
  float ph = id*1.7;
  float x = clamp(q.x, 0.25, 2.1);
  s = (x - 0.25)/1.85;
  float yc = -0.35 - 0.45*s + 0.35*s*s + 0.22*sin(3.2*x - iTime*2.2 + ph)*s;
  float zc = 0.18*sin(2.5*x - iTime*1.7 + ph*1.3)*s;
  float rad = mix(0.2, 0.025, s);
  return (length(vec3(q.x - x, q.y - yc, q.z - zc)) - rad)*0.7;
}
float mapO(vec3 p, out float m, out float s){
  vec3 hp = p - vec3(0.0, 0.55, 0.0);
  hp.xy *= rot(0.25*sin(iTime*0.8));
  float head = (length(hp*vec3(1.0, 0.78, 1.0)) - 0.62)*0.8;
  float tt = tent(p, s);
  float d = smin(head, tt, 0.25);
  m = head < tt ? 0.0 : 1.0;
  return d;
}
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  float k = P[1];
  vec3 ro = vec3(sin(iTime*0.2)*0.8 + 3.8 - k*0.6, 0.6, 3.4 - k*0.4);
  vec3 rd = camRay(uv - vec2(0.5, 0.05), ro, vec3(0.0, 0.1, 0.0), 1.8);
  float bob = 0.08*sin(iTime*1.1);
  ro.y -= bob;
  // water
  vec3 col = mix(vec3(0.0,0.02,0.06), vec3(0.02,0.25,0.4), smoothstep(-0.6, 0.9, rd.y));
  // god rays
  float gr = fbm3(vec3(rd.x*6.0 + rd.y*2.0, iTime*0.2, 0.0));
  col += vec3(0.1,0.45,0.6)*pow(gr, 3.0)*smoothstep(-0.2, 0.8, rd.y)*0.9;
  float t = 0.0, d = 1.0, m = 0.0, s = 0.0;
  for (int i = 0; i < 90; i++) { d = mapO(ro + rd*t, m, s); if (d < 0.002 || t > 12.0) break; t += d; }
  vec3 H1 = vec3(-0.2, 0.62, 0.15), H2 = vec3(0.2, 0.62, 0.15), H3 = vec3(0.0, 0.45, -0.1);
  if (d < 0.01) {
    vec3 p = ro + rd*t;
    vec2 e = vec2(0.003, 0.0); float mm, ss;
    vec3 n = normalize(vec3(mapO(p+e.xyy,mm,ss)-mapO(p-e.xyy,mm,ss), mapO(p+e.yxy,mm,ss)-mapO(p-e.yxy,mm,ss), mapO(p+e.yyx,mm,ss)-mapO(p-e.yyx,mm,ss)));
    vec3 L = normalize(vec3(0.3, 1.0, 0.4));
    float dif = max(dot(n, L), 0.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    float spots = smoothstep(0.55, 0.65, fbm(p*7.0));
    vec3 alb = mix(vec3(0.75,0.18,0.25), vec3(0.95,0.45,0.35), spots);
    // suckers under tentacles
    float suck = m*step(0.0, -n.y)*smoothstep(0.35, 0.0, abs(fract(s*14.0) - 0.5));
    alb = mix(alb, vec3(1.0,0.8,0.7), suck*0.6);
    // caustics
    float ca = pow(abs(sin(p.x*8.0 + fbm3(p*3.0 + iTime*0.4)*6.0) * sin(p.z*8.0 + iTime)), 6.0);
    col = alb*(0.12 + dif*(0.9 + ca*0.8)) + vec3(0.2,0.6,0.9)*rim*0.6;
    // hearts glowing through the skin
    float hg = 0.0;
    hg += exp(-length(p - H1)*6.0) + exp(-length(p - H2)*6.0) + exp(-length(p - H3)*6.0);
    col += vec3(0.15,0.55,1.0)*hg*P[0]*1.6*(1.0 - m);
    // fog
    col = mix(col, vec3(0.0,0.06,0.12), 1.0 - exp(-t*0.06));
  }
  // heart glow halos in front
  for (int i = 0; i < 3; i++) {
    vec3 hc = i == 0 ? H1 : (i == 1 ? H2 : H3);
    float pulse = 0.7 + 0.3*sin(iTime*5.0 + float(i)*2.1);
    float dh = length(cross(hc - ro, rd));
    col += vec3(0.2,0.6,1.0)*exp(-dh*22.0)*P[0]*pulse*1.2;
  }
  // particles (marine snow)
  for (int i = 0; i < 2; i++) {
    float z = 1.0 + float(i)*1.3;
    vec2 q = uv*z*4.0 + vec2(0.0, -iTime*0.08*z);
    vec2 id = floor(q); vec2 f = fract(q) - 0.5;
    vec2 o = vec2(hash2(id+1.3), hash2(id+5.1)) - 0.5;
    col += vec3(0.6,0.8,0.9)*smoothstep(0.05, 0.0, length(f - o*0.7))*step(0.75, hash2(id))*0.35;
  }
  col = aces(col*1.3);
  col *= 1.0 - 0.35*dot(uv*0.55, uv*0.55);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;

// ---------------------------------------------------------------- honeycomb filled with honey
// P0 camera travel, P1 shine
export const honey = /* glsl */ `
vec4 hexCell(vec2 p){
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0))/s.xyxy) + 0.5;
  vec4 h = vec4(p - hC.xy*s, p - (hC.zw + 0.5)*s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 9.43);
}
float hexDist(vec2 p){ p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x); }
float cellH(vec2 id){ return 0.15 + 0.5*hash2(id); }
// returns d; mat: 0 wax wall, 1 honey cap
float mapH(vec3 p, out float mat, out vec2 cid){
  vec4 hc = hexCell(p.xz);
  cid = hc.zw;
  float hd = hexDist(hc.xy);          // 0.5 at the cell edge
  float top = cellH(hc.zw);
  float wall = 0.5 - hd;               // distance inside the edge
  float rim = top + 0.06;
  float honeyL = top - 0.04 + 0.03*sin(iTime*1.5 + hash2(hc.zw)*6.0)*0.3;
  // wall solid: thin ring near the edge up to rim
  float dWall = max(wall - 0.05, p.y - rim);
  // honey surface: slightly domed meniscus
  float dHoney = p.y - (honeyL + 0.04*(1.0 - smoothstep(0.0, 0.45, hd)) - 0.03*smoothstep(0.3,0.45,hd)*-1.0);
  mat = dWall < dHoney ? 0.0 : 1.0;
  return min(dWall, dHoney)*0.6;
}
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  float k = P[0];
  vec3 ro = vec3(k*3.0, 1.55 - k*0.35, 2.6 - k*1.5);
  vec3 ta = vec3(k*3.0 + 0.4, -0.5, -1.0 - k*1.5);
  vec3 rd = camRay(uv, ro, ta, 1.6);
  vec3 sky = mix(vec3(0.5,0.25,0.05), vec3(0.08,0.03,0.0), clamp(rd.y*2.0, 0.0, 1.0));
  vec3 col = sky;
  float t = 0.0, d = 1.0, mat = 0.0; vec2 cid;
  for (int i = 0; i < 110; i++) { d = mapH(ro + rd*t, mat, cid); if (abs(d) < 0.0015 || t > 14.0) break; t += d; }
  if (t < 14.0) {
    vec3 p = ro + rd*t;
    vec2 e = vec2(0.003, 0.0); float mm; vec2 cc;
    vec3 n = normalize(vec3(mapH(p+e.xyy,mm,cc)-mapH(p-e.xyy,mm,cc), mapH(p+e.yxy,mm,cc)-mapH(p-e.yxy,mm,cc), mapH(p+e.yyx,mm,cc)-mapH(p-e.yyx,mm,cc)));
    vec3 L = normalize(vec3(-0.5, 0.7, -0.6));
    float dif = max(dot(n, L), 0.0);
    vec3 hv = normalize(L - rd);
    if (mat > 0.5) {
      float fres = 0.04 + 0.96*pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
      vec3 deep = vec3(0.55,0.2,0.0), lite = vec3(1.0,0.65,0.1);
      vec3 hcol = mix(deep, lite, 0.35 + 0.65*dif);
      float spec = pow(max(dot(n, hv), 0.0), 120.0);
      col = hcol*(0.35 + dif) + vec3(1.0,0.9,0.6)*spec*(3.0 + 3.0*P[1]) + sky*fres*1.4;
      col += vec3(1.0,0.5,0.05)*0.25; // glow from within
    } else {
      vec3 wax = vec3(0.95,0.75,0.35);
      col = wax*(0.2 + dif*0.9) + vec3(1.0,0.9,0.7)*pow(max(dot(n, hv), 0.0), 20.0)*0.3;
    }
    col = mix(col, sky*0.8, 1.0 - exp(-t*0.32));
  }
  // dust motes in the light
  for (int i = 0; i < 2; i++) {
    float z = 1.0 + float(i)*1.4;
    vec2 q = uv*z*3.5 + vec2(iTime*0.05, iTime*0.03)*z;
    vec2 id = floor(q); vec2 f = fract(q) - 0.5;
    vec2 o = vec2(hash2(id+2.3), hash2(id+4.1)) - 0.5;
    col += vec3(1.0,0.8,0.4)*smoothstep(0.06, 0.0, length(f - o*0.7))*step(0.8, hash2(id))*0.4;
  }
  col = aces(col*1.15);
  col *= 1.0 - 0.35*dot(uv*0.55, uv*0.55);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;

// ---------------------------------------------------------------- everest sinking into the mariana trench
// P0 sink 0..1 (mountain base y from 0 to -5.47), P1 camera
export const everest = /* glsl */ `
const float TRENCH = -5.47, PEAK = 4.42;
float floorH(float x){ return -1.3 - (-TRENCH - 1.3)*exp(-x*x/5.5); }
float mapE(vec3 p, out float mat){
  // terrain block (cut at z in [-3,3], x in [-9,9])
  float hf = floorH(p.x) + 0.25*fbm3(vec3(p.x*0.8, 0.0, p.z*0.8));
  float dT = (p.y - hf)*0.6;
  float box = max(abs(p.x) - 9.0, abs(p.z) - 3.0);
  dT = max(dT, box);
  dT = max(dT, -p.y - 7.0);
  // mountain
  float by = mix(0.0, TRENCH, P[0]);
  vec3 q = p - vec3(0.0, by, 0.0);
  float rr = length(q.xz);
  float hgt = PEAK*(1.0 - rr/3.2);
  hgt += 0.35*(fbm3(vec3(q.xz*1.4, 1.0)) - 0.5)*(1.0 - rr/3.2)*3.0;
  float dM = max((q.y - hgt)*0.45, max(-q.y, rr - 3.2));
  mat = dM < dT ? 1.0 : 0.0;
  return min(dT, dM);
}
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  float ca = P[1];
  vec3 ro = vec3(sin(ca)*14.0, 1.0 + 1.5*cos(ca*0.7), cos(ca)*14.0 + 2.0);
  vec3 ta = vec3(0.0, -1.6, 0.0);
  vec3 rd = camRay(uv, ro, ta, 1.55);
  vec3 sky = mix(vec3(0.75,0.85,0.95), vec3(0.2,0.45,0.8), clamp(rd.y*2.5, 0.0, 1.0));
  vec3 col = mix(vec3(0.01,0.02,0.05), vec3(0.06,0.13,0.28), smoothstep(-0.5, 0.6, rd.y));
  float t = 0.0, d = 1.0, mat = 0.0;
  for (int i = 0; i < 120; i++) { d = mapE(ro + rd*t, mat); if (d < 0.003 || t > 40.0) break; t += d; }
  float tHit = t < 40.0 ? t : 1e9;
  if (tHit < 1e9) {
    vec3 p = ro + rd*t; float mm;
    vec2 e = vec2(0.01, 0.0);
    vec3 n = normalize(vec3(mapE(p+e.xyy,mm)-mapE(p-e.xyy,mm), mapE(p+e.yxy,mm)-mapE(p-e.yxy,mm), mapE(p+e.yyx,mm)-mapE(p-e.yyx,mm)));
    vec3 L = normalize(vec3(0.6, 0.8, 0.4));
    float dif = max(dot(n, L), 0.0);
    vec3 alb;
    if (mat > 0.5) {
      float by = mix(0.0, TRENCH, P[0]);
      float rel = (p.y - by)/PEAK;
      alb = mix(vec3(0.35,0.3,0.27), vec3(0.5,0.45,0.4), fbm3(p*2.0));
      alb = mix(alb, vec3(0.95,0.97,1.0), smoothstep(0.62, 0.72, rel + 0.08*fbm3(p*4.0)) * step(0.0, n.y + 0.3));
    } else {
      // rock strata on the cut faces, sand on top
      float strata = 0.5 + 0.5*sin(p.y*7.0 + fbm3(p*1.5)*3.0);
      alb = mix(vec3(0.25,0.17,0.12), vec3(0.45,0.33,0.22), strata);
      if (n.y > 0.6) alb = vec3(0.5,0.45,0.35);
    }
    col = alb*(0.2 + dif*1.1);
  }
  // water volume: box x[-9,9] z[-3,3] y[floor..0]
  vec3 bmin = vec3(-9.0, -7.0, -3.0), bmax = vec3(9.0, 0.0, 3.0);
  vec3 t0 = (bmin - ro)/rd, t1 = (bmax - ro)/rd;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float tin = max(max(tn.x, tn.y), tn.z), tout = min(min(tf.x, tf.y), tf.z);
  if (tout > max(tin, 0.0)) {
    float a = max(tin, 0.0), b = min(tout, tHit);
    if (b > a) {
      float L = b - a;
      vec3 pin = ro + rd*a;
      float depth = clamp(-pin.y/6.0, 0.0, 1.0);
      vec3 wc = mix(vec3(0.05,0.45,0.65), vec3(0.0,0.05,0.18), depth);
      float absorb = 1.0 - exp(-L*0.35);
      col = mix(col, wc, absorb*0.85);
      // surface sheen at y=0
      if (abs(pin.y) < 0.02) col += vec3(0.6,0.8,1.0)*0.15;
    }
  }
  // the water line glow
  col = aces(col*1.15);
  col *= 1.0 - 0.3*dot(uv*0.55, uv*0.55);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;

// ---------------------------------------------------------------- lightning storm
// P0 strike flash 0..1, P1 strike seed, P2 bolt reveal 0..1
export const storm = /* glsl */ `
float boltX(float y, float seed){
  float x = 0.0, a = 0.35, f = 1.6;
  for (int i = 0; i < 6; i++) {
    x += a*(noise(vec3(y*f, seed*13.1, float(i)*3.7)) - 0.5);
    a *= 0.55; f *= 2.1;
  }
  return x;
}
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  float fl = P[0];
  vec3 ro = vec3(0.0, 0.2, 0.0);
  vec3 rd = normalize(vec3(uv.x, uv.y + 0.15, 1.6));
  // cloud deck: plane y=1.5 seen from below
  vec3 col = vec3(0.01,0.015,0.03);
  if (rd.y > 0.0) {
    float tc = (1.5 - ro.y)/rd.y;
    vec3 pc = ro + rd*tc;
    vec3 q = vec3(pc.x*0.35 + iTime*0.05, pc.z*0.35, iTime*0.03);
    float c = fbm(q*1.2);
    float c2 = fbm(q*2.7 + vec3(c*1.5));
    float dens = smoothstep(0.3, 0.8, c*0.6 + c2*0.5);
    vec3 cc = mix(vec3(0.03,0.04,0.07), vec3(0.18,0.2,0.28), dens);
    // flash lights the clouds from inside
    float lit = exp(-length(pc.xz - vec2(P[1]*0.6, 6.0))*0.12);
    cc += vec3(0.55,0.6,1.0)*fl*lit*(0.35 + dens*1.1);
    col = mix(col, cc, smoothstep(0.0, 0.08, rd.y));
  }
  // sea below the horizon reflecting the flash
  if (rd.y < 0.0) {
    float tw = -ro.y/rd.y;
    vec3 pw = ro + rd*tw;
    float wv = noise(vec3(pw.x*3.0, pw.z*3.0 - iTime*0.8, 0.0));
    col = vec3(0.01,0.02,0.035) + vec3(0.4,0.45,0.8)*fl*0.25*wv*exp(-tw*0.08);
  }
  // the bolt (screen space)
  vec2 bp = uv - vec2((fract(P[1]*0.37) - 0.5)*1.1, 0.0);
  float top = 0.95, bot = -0.12;
  float reveal = mix(top, bot, P[2]);
  if (bp.y < top && bp.y > max(bot, reveal)) {
    float x = boltX(bp.y, P[1]);
    float d = abs(bp.x - x);
    float br = 0.0;
    // branches
    for (int i = 0; i < 3; i++) {
      float y0 = 0.7 - float(i)*0.25;
      if (bp.y < y0 && bp.y > y0 - 0.3) {
        float s = (y0 - bp.y)/0.3;
        float xb = boltX(y0, P[1]) + (hash(float(i) + P[1]*7.0) - 0.5)*0.9*s + 0.06*(noise(vec3(bp.y*20.0, float(i), P[1])) - 0.5);
        br += exp(-abs(bp.x - xb)*300.0)*(1.0 - s)*0.7 + exp(-abs(bp.x - xb)*40.0)*(1.0 - s)*0.1;
      }
    }
    float core = exp(-d*500.0)*1.6 + exp(-d*60.0)*0.5 + exp(-d*12.0)*0.15;
    float on = clamp(fl*1.5 + 0.15, 0.0, 1.0);
    col += vec3(0.85,0.9,1.0)*(core + br)*on*2.0;
  }
  // rain streaks
  vec2 rq = vec2(uv.x*40.0 + uv.y*6.0, uv.y*3.0 + iTime*7.0);
  vec2 rid = floor(rq); vec2 rf = fract(rq);
  float rain = step(0.85, hash2(rid))*smoothstep(0.08, 0.0, abs(rf.x - 0.5))*smoothstep(0.0, 0.5, rf.y)*smoothstep(1.0, 0.5, rf.y);
  col += vec3(0.5,0.55,0.7)*rain*(0.05 + fl*0.25);
  col += vec3(0.6,0.65,1.0)*fl*0.12;
  col = aces(col*1.4);
  col *= 1.0 - 0.3*dot(uv*0.55, uv*0.55);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;

// ---------------------------------------------------------------- outro: earth from orbit
// P0 camera pull 0..1, P1 sunrise
export const earth = /* glsl */ `
void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - iRes)/iRes.y;
  float k = P[0];
  vec3 ro = vec3(0.0, 0.0, 3.2 + k*1.8);
  vec3 rd = camRay(uv - vec2(0.0, 0.0), ro, vec3(0.0, -0.95 + k*0.5, 0.0), 1.6);
  vec3 col = stars(rd);
  float R = 1.0;
  vec3 Ls = normalize(vec3(-0.9, 0.45 + P[1]*0.3, -0.35));
  float b = dot(ro, rd), c = dot(ro,ro) - R*R, h = b*b - c;
  float tE = h > 0.0 ? -b - sqrt(h) : 1e9;
  if (tE < 1e8) {
    vec3 n = normalize(ro + rd*tE);
    vec3 q = n; q.xz *= rot(iTime*0.06);
    float landN = fbm(q*2.2 + vec3(3.0));
    float land = smoothstep(0.5, 0.53, landN);
    float cl = smoothstep(0.48, 0.78, fbm(q*4.5 + vec3(iTime*0.02, 0.0, 0.0)));
    vec3 alb = mix(vec3(0.01,0.05,0.18), mix(vec3(0.12,0.25,0.07), vec3(0.45,0.38,0.22), smoothstep(0.55, 0.7, landN)), land);
    float dif = max(dot(n, Ls), 0.0);
    float term = smoothstep(-0.15, 0.15, dot(n, Ls));
    vec3 day = mix(alb, vec3(1.0), cl*0.9)*dif*1.6;
    // ocean glint
    vec3 hv = normalize(Ls - rd);
    day += vec3(1.0,0.85,0.6)*pow(max(dot(n, hv), 0.0), 60.0)*(1.0 - land)*(1.0 - cl)*1.5;
    // city lights on the night side
    float city = land*smoothstep(0.62, 0.8, fbm(q*22.0))*(1.0 - cl);
    vec3 night = vec3(1.0,0.7,0.3)*city*1.4;
    col = mix(night, day, term);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    col += vec3(0.25,0.55,1.0)*fres*(0.15 + 1.2*max(dot(n, Ls) + 0.2, 0.0));
  }
  // atmosphere rim
  float dc = length(cross(ro, rd));
  float rim = exp(-max(dc - R, 0.0)*18.0)*(tE > 1e8 ? 1.0 : 0.0);
  float sunSide = max(dot(normalize(cross(cross(ro, rd), rd)*-1.0), Ls), 0.0);
  col += vec3(0.3,0.6,1.0)*rim*(0.25 + 1.4*pow(max(dot(rd, Ls), 0.0)*0.5 + 0.5, 4.0));
  // the sun cresting the limb
  float sd = max(dot(rd, Ls), 0.0);
  col += vec3(1.0,0.85,0.6)*pow(sd, 800.0)*8.0*(tE > 1e8 ? 1.0 : 0.0) + vec3(1.0,0.6,0.3)*pow(sd, 30.0)*0.4*P[1];
  col = aces(col*1.1);
  col *= 1.0 - 0.3*dot(uv*0.55, uv*0.55);
  outColor = vec4(pow(col, vec3(0.9)), 1.0);
}`;
