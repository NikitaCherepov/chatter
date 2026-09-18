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

// Page-curl geometry adapted from InvertedPageCurl by Hewlett-Packard / Sergey
// Kosarevsky (BSD-3-Clause):
// https://github.com/gl-transitions/gl-transitions/blob/master/transitions/InvertedPageCurl.glsl
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uPage;
uniform float uProgress;
uniform float uDirection;

in vec2 vUv;
out vec4 outColor;

const float MIN_AMOUNT = -0.16;
const float MAX_AMOUNT = 1.5;
const float PI = 3.141592653589793;
const float SCALE = 512.0;
const float SHARPNESS = 3.0;
const float CYLINDER_RADIUS = 1.0 / PI / 2.0;

float amount;
float cylinderAngle;

vec2 sourceUv(vec2 point) {
  return vec2(uDirection > 0.0 ? point.x : 1.0 - point.x, point.y);
}

vec4 fromColor(vec2 point) {
  return texture(uPage, sourceUv(point));
}

vec3 hitPoint(float hitAngle, float yc, vec3 point, mat3 reverseRotation) {
  point.y = hitAngle / (2.0 * PI);
  return reverseRotation * point;
}

vec4 antiAlias(vec4 color1, vec4 color2, float distanceFromEdge) {
  distanceFromEdge *= SCALE;
  if (distanceFromEdge < 0.0) return color2;
  if (distanceFromEdge > 2.0) return color1;
  float blend = pow(1.0 - distanceFromEdge / 2.0, SHARPNESS);
  return (color2 - color1) * blend + color1;
}

float distanceToEdge(vec3 point) {
  float dx = abs(point.x > 0.5 ? 1.0 - point.x : point.x);
  float dy = abs(point.y > 0.5 ? 1.0 - point.y : point.y);
  if (point.x < 0.0) dx = -point.x;
  if (point.x > 1.0) dx = point.x - 1.0;
  if (point.y < 0.0) dy = -point.y;
  if (point.y > 1.0) dy = point.y - 1.0;
  if ((point.x < 0.0 || point.x > 1.0) && (point.y < 0.0 || point.y > 1.0)) {
    return sqrt(dx * dx + dy * dy);
  }
  return min(dx, dy);
}

vec4 seeThrough(float yc, vec2 point, mat3 rotation, mat3 reverseRotation) {
  float hitAngle = PI - (acos(clamp(yc / CYLINDER_RADIUS, -1.0, 1.0)) - cylinderAngle);
  vec3 curlPoint = hitPoint(hitAngle, yc, rotation * vec3(point, 1.0), reverseRotation);
  if (yc <= 0.0 && (curlPoint.x < 0.0 || curlPoint.y < 0.0 || curlPoint.x > 1.0 || curlPoint.y > 1.0)) {
    return vec4(0.0);
  }
  if (yc > 0.0) return fromColor(point);
  return antiAlias(fromColor(curlPoint.xy), vec4(0.0), distanceToEdge(curlPoint));
}

vec4 seeThroughWithShadow(float yc, vec2 point, vec3 curlPoint, mat3 rotation, mat3 reverseRotation) {
  float shadow = max(0.0, (1.0 - distanceToEdge(curlPoint) * 30.0) / 3.0) * max(amount, 0.0);
  vec4 color = seeThrough(yc, point, rotation, reverseRotation);
  if (color.a <= 0.001) return vec4(0.0, 0.0, 0.0, shadow * 0.58);
  color.rgb = max(vec3(0.0), color.rgb - shadow);
  return color;
}

vec4 backside(float yc, vec3 point) {
  vec4 color = fromColor(point.xy);
  float gray = (color.r + color.g + color.b) / 15.0;
  gray += 0.8 * (pow(max(0.0, 1.0 - abs(yc / CYLINDER_RADIUS)), 0.2) / 2.0 + 0.5);
  color.rgb = mix(vec3(gray), color.rgb * vec3(0.90, 0.86, 0.76), 0.22);
  return color;
}

vec4 behindSurface(vec2 point, float yc, vec3 rotatedPoint, mat3 reverseRotation) {
  float safeAmount = amount >= 0.0 ? max(amount, 0.0001) : min(amount, -0.0001);
  float shadow = (1.0 - ((-CYLINDER_RADIUS - yc) / safeAmount * 7.0)) / 6.0;
  shadow *= 1.0 - abs(rotatedPoint.x - 0.5);
  yc = -2.0 * CYLINDER_RADIUS - yc;
  float hitAngle = (acos(clamp(yc / CYLINDER_RADIUS, -1.0, 1.0)) + cylinderAngle) - PI;
  vec3 curlPoint = hitPoint(hitAngle, yc, rotatedPoint, reverseRotation);
  if (yc < 0.0 && curlPoint.x >= 0.0 && curlPoint.y >= 0.0 && curlPoint.x <= 1.0 && curlPoint.y <= 1.0 && (hitAngle < PI || amount > 0.5)) {
    vec2 delta = curlPoint.xy - vec2(0.5);
    shadow = (1.0 - length(delta) / 0.71) * pow(-yc / CYLINDER_RADIUS, 3.0) * 0.5;
  } else {
    shadow = 0.0;
  }
  return vec4(0.0, 0.0, 0.0, max(0.0, shadow) * 0.52);
}

vec4 pageCurl(vec2 point) {
  amount = uProgress * (MAX_AMOUNT - MIN_AMOUNT) + MIN_AMOUNT;
  cylinderAngle = 2.0 * PI * amount;

  const float angle = 100.0 * PI / 180.0;
  float cosine = cos(-angle);
  float sine = sin(-angle);
  mat3 rotation = mat3(
    cosine, sine, 0.0,
    -sine, cosine, 0.0,
    -0.801, 0.890, 1.0
  );
  cosine = cos(angle);
  sine = sin(angle);
  mat3 reverseRotation = mat3(
    cosine, sine, 0.0,
    -sine, cosine, 0.0,
    0.985, 0.985, 1.0
  );

  vec3 rotatedPoint = rotation * vec3(point, 1.0);
  float yc = rotatedPoint.y - amount;
  if (yc < -CYLINDER_RADIUS) return behindSurface(point, yc, rotatedPoint, reverseRotation);
  if (yc > CYLINDER_RADIUS) return fromColor(point);

  float hitAngle = (acos(clamp(yc / CYLINDER_RADIUS, -1.0, 1.0)) + cylinderAngle) - PI;
  float hitAngleMod = mod(hitAngle, 2.0 * PI);
  if ((hitAngleMod > PI && amount < 0.5) || (hitAngleMod > PI / 2.0 && amount < 0.0)) {
    return seeThrough(yc, point, rotation, reverseRotation);
  }

  vec3 curlPoint = hitPoint(hitAngle, yc, rotatedPoint, reverseRotation);
  if (curlPoint.x < 0.0 || curlPoint.y < 0.0 || curlPoint.x > 1.0 || curlPoint.y > 1.0) {
    return seeThroughWithShadow(yc, point, curlPoint, rotation, reverseRotation);
  }

  vec4 color = backside(yc, curlPoint);
  vec4 otherColor;
  if (yc < 0.0) {
    vec2 delta = curlPoint.xy - vec2(0.5);
    float shadow = (1.0 - length(delta) / 0.71) * pow(-yc / CYLINDER_RADIUS, 3.0) * 0.5;
    otherColor = vec4(0.0, 0.0, 0.0, max(0.0, shadow));
  } else {
    otherColor = fromColor(point);
  }
  color = antiAlias(color, otherColor, CYLINDER_RADIUS - abs(yc));
  return antiAlias(color, seeThroughWithShadow(yc, point, curlPoint, rotation, reverseRotation), distanceToEdge(curlPoint));
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 geometryUv = uDirection > 0.0 ? uv : vec2(1.0 - uv.x, uv.y);
  outColor = pageCurl(geometryUv);
}
`;

type Props = {
  snapshot: HTMLCanvasElement;
  direction: 'previous' | 'next';
  left: number;
  top: number;
  width: number;
  height: number;
  running: boolean;
  onComplete: () => void;
};

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create page curl shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export function BroadsheetCurlTransition({
  snapshot,
  direction,
  left,
  top,
  width,
  height,
  running,
  onComplete,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const completionRef = useRef(onComplete);
  completionRef.current = onComplete;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
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
      if (!program) throw new Error('Unable to create page curl program');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Unable to link page curl shader');
      }

      texture = gl.createTexture();
      if (!texture) throw new Error('Unable to create broadsheet texture');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshot);

      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'uPage'), 0);
      gl.uniform1f(gl.getUniformLocation(program, 'uDirection'), direction === 'next' ? 1 : -1);
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
        const duration = 760;
        const render = (now: number) => {
          const linear = Math.min(1, (now - startedAt) / duration);
          const eased = linear * linear * (3.0 - 2.0 * linear);
          draw(eased);
          if (linear < 1) frame = requestAnimationFrame(render);
          else completionRef.current();
        };
        frame = requestAnimationFrame(render);
      }
    } catch (error) {
      console.error('Failed to render broadsheet page curl:', error);
      completionRef.current();
    }

    return () => {
      cancelAnimationFrame(frame);
      if (texture) gl.deleteTexture(texture);
      if (program) gl.deleteProgram(program);
    };
  }, [direction, running, snapshot]);

  return (
    <canvas
      ref={canvasRef}
      className={s.broadsheetCurlCanvas}
      width={snapshot.width}
      height={snapshot.height}
      style={{ left, top, width, height }}
      aria-hidden="true"
    />
  );
}
