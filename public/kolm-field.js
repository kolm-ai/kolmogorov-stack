// kolm-field.js - THE EVIDENCE FIELD. Quantized light: a domain-warped fbm
// phosphor fog rendered entirely through a recursive 8x8 Bayer dither. Every
// dot is either on or off, nothing in between - continuous claims broken into
// discrete verifiable units, the brand thesis as physics. Raw WebGL1, zero
// dependencies, fail-open: with no JS / no WebGL the CSS grid + radial layers
// underneath ARE the hero. Mounts: EVERY <div class="field"><canvas></canvas></div>
// on the page - the hero ceiling volume plus .field--band section volumes -
// capped at the first 3 (the per-page WebGL context budget). Each mount has
// its own context, sizing, intersection pause and pointer tracking; a single
// hero mount behaves exactly as before. data-intensity caps alpha (0.34 hero,
// 0.10-0.14 bands). See UNICORN-DESIGN-2026.md section 8. DPR cap 1.5.
(function () {
  'use strict';

  function initField(host) {
    var canvas = host.querySelector('canvas');
    if (!canvas) return;
    var gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return;
    var FS = [
      'precision mediump float;',
      'uniform vec2 u_res;uniform float u_time;uniform vec2 u_mouse;',
      'uniform vec3 u_room;uniform vec3 u_phos;uniform vec3 u_cool;',
      'uniform float u_seed;uniform float u_px;uniform float u_alpha;',
      'float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+u_seed)*43758.5453123);}',
      'float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
      ' return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}',
      'float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(cos(.5),sin(.5),-sin(.5),cos(.5));',
      ' for(int i=0;i<4;i++){v+=a*vn(p);p=m*p*2.;a*=.5;}return v;}',
      'float B2(vec2 a){a=floor(a);return fract(a.x/2.+a.y*a.y*.75);}',
      'float B4(vec2 a){return B2(.5*a)*.25+B2(a);}',
      'float B8(vec2 a){return B4(.5*a)*.25+B2(a);}',
      'void main(){',
      ' vec2 uv=gl_FragCoord.xy/u_res;uv.y=1.-uv.y;',
      ' vec2 p=uv*vec2(u_res.x/u_res.y,1.)*2.6;',
      ' float q=fbm(p+u_time*.030);',
      ' float f=fbm(p+1.6*q+u_time*.018);',
      ' float b=f*.62;',
      ' b+=.30*exp(-2.4*length(uv-vec2(.30,.18)));',
      ' b+=.14*exp(-3.0*length(uv-vec2(.86,.10)));',
      ' b+=.12*exp(-9.0*length(uv-u_mouse));',
      ' b*=smoothstep(1.05,.25,uv.y);',
      ' float on=step(B8(floor(gl_FragCoord.xy/u_px)),b);',
      ' vec3 col=mix(u_room,mix(u_cool,u_phos,smoothstep(.25,.85,b)),on);',
      ' float a=on*b*u_alpha;',
      ' gl_FragColor=vec4(col*a,a);}'].join('\n');
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw gl.getProgramInfoLog(prog);
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {};
    ['u_res', 'u_time', 'u_mouse', 'u_room', 'u_phos', 'u_cool', 'u_seed', 'u_px', 'u_alpha'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    // palette: read tokens from CSS, resolve any color syntax via 2D canvas
    var probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    function tok(name, fb) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
      probe.fillStyle = fb; probe.fillStyle = v;
      probe.clearRect(0, 0, 1, 1); probe.fillRect(0, 0, 1, 1);
      var d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    }
    var room = tok('--paper', '#090C0D'), phos = tok('--accent', '#3FE5A0'), cool = tok('--cool', '#6FA6E8');
    gl.uniform3f(U.u_room, room[0], room[1], room[2]);
    gl.uniform3f(U.u_phos, phos[0], phos[1], phos[2]);
    gl.uniform3f(U.u_cool, cool[0], cool[1], cool[2]);
    gl.uniform1f(U.u_seed, 0.6315);
    gl.uniform1f(U.u_alpha, Math.min(parseFloat(host.getAttribute('data-intensity')) || 0.34, 0.34));
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5), scale = 1;
    function size() {
      var w = Math.max(1, Math.round(host.clientWidth * dpr * scale));
      var h = Math.max(1, Math.round(host.clientHeight * dpr * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
    }
    var fine = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
    var mx = 0.5, my = 0.3, tx = 0.5, ty = 0.3, ready = false;
    if (fine) document.addEventListener('pointermove', function (e) {
      if (!inView) return; // no rect reads for paused offscreen mounts
      var r = canvas.getBoundingClientRect();
      if (r.width && r.height) { tx = (e.clientX - r.left) / r.width; ty = (e.clientY - r.top) / r.height; }
    }, { passive: true });
    function draw(t) {
      size();
      gl.uniform2f(U.u_res, canvas.width, canvas.height);
      gl.uniform1f(U.u_time, t);
      gl.uniform2f(U.u_mouse, mx, my);
      gl.uniform1f(U.u_px, 3 * dpr * scale);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!ready) { ready = true; host.classList.add('ready'); }
    }
    var raf = 0, slow = 0;
    function loop() {
      raf = 0;
      var t0 = performance.now();
      mx += (tx - mx) * 0.06; my += (ty - my) * 0.06;
      draw(t0 / 1000);
      // degrade once if two consecutive frames blow the budget
      if (scale === 1 && performance.now() - t0 > 8) { if (++slow >= 2) scale = 0.5; } else slow = 0;
      raf = requestAnimationFrame(loop);
    }
    var reduceMq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    var inView = true, visible = !document.hidden, lost = false;
    function settle() {
      var run = !lost && inView && visible && !reduceMq.matches;
      if (run && !raf) raf = requestAnimationFrame(loop);
      if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!run && !lost && reduceMq.matches && inView) draw(7.0); // exactly one static frame
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { inView = es[0].isIntersecting; settle(); }).observe(host);
    }
    document.addEventListener('visibilitychange', function () { visible = !document.hidden; settle(); });
    if (reduceMq.addEventListener) reduceMq.addEventListener('change', settle);
    window.addEventListener('resize', function () { if (reduceMq.matches && inView) draw(7.0); }, { passive: true });
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      lost = true; // stays dormant: settle() may never restart a dead context
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      ready = false; host.classList.remove('ready'); // canvas fades back to 0
    });
    settle();
  }

  try {
    if (!window.WebGLRenderingContext) return;
    var hosts = document.querySelectorAll('.field');
    var n = Math.min(hosts.length, 3); // WebGL budget: first 3 mounts only
    for (var i = 0; i < n; i++) {
      try { initField(hosts[i]); } catch (e) { /* fail open per mount */ }
    }
  } catch (e) { /* fail open: the CSS layers underneath are the fallback */ }
})();
