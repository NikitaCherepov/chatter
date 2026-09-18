import { useLayoutEffect, useRef } from 'react';
import s from './Newspaper.module.scss';

const VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uPage;
uniform float uProgress;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.52;
  mat2 rotation = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = rotation * p * 2.03 + 11.7;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 page = texture(uPage, uv);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 paper = vec2(uv.x * aspect, uv.y);

  float broadNoise = fbm(paper * 3.15 + vec2(2.8, 7.1));
  float detailNoise = fbm(paper * 12.0 + vec2(19.3, 4.7));
  float diagonalFront = uv.x * 0.46 + (1.0 - uv.y) * 0.54;
  float burnField = diagonalFront + (broadNoise - 0.5) * 0.48 + (detailNoise - 0.5) * 0.1;

  float threshold = mix(-0.3, 1.3, uProgress);
  float signedEdge = burnField - threshold;
  float remaining = smoothstep(-0.018, 0.018, signedEdge);

  float charBand = 1.0 - smoothstep(0.0, 0.085, signedEdge);
  float emberBand = 1.0 - smoothstep(0.0, 0.042, signedEdge);
  float hotBand = 1.0 - smoothstep(0.0, 0.014, signedEdge);
  vec3 color = page.rgb;
  color = mix(color, vec3(0.075, 0.025, 0.008), charBand * 0.94);
  color = mix(color, vec3(1.0, 0.19, 0.015), emberBand * 0.92);
  color = mix(color, vec3(1.0, 0.78, 0.24), hotBand);

  float flicker = 0.82 + 0.18 * noise(vec2(paper.x * 24.0, uProgress * 58.0));
  color += vec3(1.0, 0.23, 0.025) * emberBand * flicker * 0.28;
  float alpha = page.a * remaining;
  outColor = vec4(color * alpha, alpha);
}
`;

type Props = {
  snapshot: HTMLCanvasElement;
  left: number;
  top: number;
  width: number;
  height: number;
  running: boolean;
  onComplete: () => void;
};

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create burn shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export function WizardBurnTransition({ snapshot, left, top, width, height, running, onComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const completionRef = useRef(onComplete);
  completionRef.current = onComplete;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) {
      completionRef.current();
      return;
    }

    let frame = 0;
    let program: WebGLProgram | null = null;
    let texture: WebGLTexture | null = null;
    try {
      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error('Unable to create burn shader program');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Unable to link burn shader');
      }

      texture = gl.createTexture();
      if (!texture) throw new Error('Unable to create newspaper texture');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshot);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'uPage'), 0);
      gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), canvas.width, canvas.height);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const progressLocation = gl.getUniformLocation(program, 'uProgress');
      const draw = (progress: number) => {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(progressLocation, progress);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      draw(0);
      if (running) {
        const startedAt = performance.now();
        const duration = 900;
        const render = (now: number) => {
          const linear = Math.min(1, (now - startedAt) / duration);
          const eased = linear * linear * (3 - 2 * linear);
          draw(eased);
          if (linear < 1) frame = requestAnimationFrame(render);
          else completionRef.current();
        };
        frame = requestAnimationFrame(render);
      }
    } catch (error) {
      console.error('Failed to render wizarding newspaper burn transition:', error);
      completionRef.current();
    }

    return () => {
      cancelAnimationFrame(frame);
      if (texture) gl.deleteTexture(texture);
      if (program) gl.deleteProgram(program);
    };
  }, [running, snapshot]);

  return <canvas
    ref={canvasRef}
    className={s.wizardBurnCanvas}
    width={snapshot.width}
    height={snapshot.height}
    style={{ left, top, width, height }}
    aria-hidden="true"
  />;
}
