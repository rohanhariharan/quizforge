// Renders a question's graph spec as SVG — functions, points, segments,
// shaded regions, axes, ticks and a legend. No canvas, no dependencies.

import { sampleFunction, tryCompile } from './expression.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 720;
const HEIGHT = 430;
const PAD = { left: 52, right: 26, top: 24, bottom: 44 };

const COLORS = {
  blue: '#2563eb',
  red: '#dc2626',
  green: '#059669',
  purple: '#7c3aed',
  orange: '#ea580c',
  teal: '#0d9488',
  pink: '#db2777',
  slate: '#475569',
};
const PALETTE = [COLORS.blue, COLORS.orange, COLORS.green, COLORS.purple];

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function colorOf(value, index) {
  if (typeof value === 'string') {
    const named = COLORS[value.toLowerCase()];
    if (named) return named;
    if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  }
  return PALETTE[index % PALETTE.length];
}

export function normalizeGraphSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let xMin = number(raw.xMin, -10);
  let xMax = number(raw.xMax, 10);
  let yMin = number(raw.yMin, -10);
  let yMax = number(raw.yMax, 10);
  if (xMin === xMax) {
    xMin -= 5;
    xMax += 5;
  }
  if (yMin === yMax) {
    yMin -= 5;
    yMax += 5;
  }
  if (xMin > xMax) [xMin, xMax] = [xMax, xMin];
  if (yMin > yMax) [yMin, yMax] = [yMax, yMin];
  if (xMax - xMin < 0.01 || yMax - yMin < 0.01) return null;
  if (xMax - xMin > 1e6 || yMax - yMin > 1e6) return null;

  const functions = [];
  for (const [index, fn] of (Array.isArray(raw.functions) ? raw.functions : []).entries()) {
    const expr = String(fn?.expr ?? fn?.expression ?? '').trim();
    if (!expr) continue;
    const evaluate = tryCompile(expr);
    if (!evaluate) continue;
    functions.push({
      expr,
      evaluate,
      color: colorOf(fn?.color, index),
      label: String(fn?.label ?? '').trim(),
      dashed: Boolean(fn?.dashed),
    });
  }

  const points = (Array.isArray(raw.points) ? raw.points : [])
    .map((point) => ({
      x: number(point?.x, NaN),
      y: number(point?.y, NaN),
      label: String(point?.label ?? '').trim(),
      open: Boolean(point?.open),
      color: colorOf(point?.color, 0),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .filter((point) => point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax);

  const segments = (Array.isArray(raw.segments) ? raw.segments : [])
    .map((segment, index) => ({
      x1: number(segment?.x1, NaN),
      y1: number(segment?.y1, NaN),
      x2: number(segment?.x2, NaN),
      y2: number(segment?.y2, NaN),
      dashed: Boolean(segment?.dashed),
      color: colorOf(segment?.color, index + 1),
    }))
    .filter((segment) => [segment.x1, segment.y1, segment.x2, segment.y2].every(Number.isFinite));

  const shades = [];
  for (const [index, shade] of (Array.isArray(raw.shade) ? raw.shade : []).entries()) {
    const expr = String(shade?.expr ?? '').trim();
    if (!expr) continue;
    const evaluate = tryCompile(expr);
    if (!evaluate) continue;
    shades.push({
      evaluate,
      side: shade?.side === 'below' ? 'below' : 'above',
      color: colorOf(shade?.color, index + 2),
    });
  }

  if (!functions.length && !points.length && !segments.length) return null;

  return {
    xMin,
    xMax,
    yMin,
    yMax,
    functions,
    points,
    segments,
    shades,
    showGrid: raw.showGrid !== false,
    xLabel: String(raw.xLabel ?? 'x').trim(),
    yLabel: String(raw.yLabel ?? 'y').trim(),
  };
}

function fmt(value) {
  if (Math.abs(value) < 1e-10) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-3) {
    return value.toExponential(1).replace('e+', 'e');
  }
  return String(Number(value.toFixed(4)));
}

function niceStep(range) {
  const rough = range / 8;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / power;
  const factor = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  return factor * power;
}

function tickValues(min, max, step) {
  const values = [];
  const start = Math.ceil(min / step) * step;
  for (let value = start; value <= max + step * 1e-6 && values.length < 60; value += step) {
    values.push(Math.abs(value) < step * 1e-6 ? 0 : Number(value.toFixed(10)));
  }
  return values;
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  return node;
}

export function renderGraph(host, rawSpec) {
  host.replaceChildren();
  const spec = normalizeGraphSpec(rawSpec);
  if (!spec) {
    const fallback = document.createElement('div');
    fallback.className = 'graph-unavailable';
    fallback.textContent = 'The graph for this question could not be drawn.';
    host.appendChild(fallback);
    return false;
  }

  const { xMin, xMax, yMin, yMax } = spec;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const sx = (x) => PAD.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const sy = (y) => PAD.top + ((yMax - y) / (yMax - yMin)) * plotH;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'img',
    'aria-label': 'Graph for the question',
    class: 'graph-svg',
  });
  const title = svgEl('title');
  title.textContent = 'Question graph';
  svg.appendChild(title);

  const clipId = `plot-${Math.random().toString(36).slice(2, 9)}`;
  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: clipId });
  clip.appendChild(svgEl('rect', { x: PAD.left, y: PAD.top, width: plotW, height: plotH }));
  defs.appendChild(clip);
  svg.appendChild(defs);

  const bg = svgEl('rect', {
    x: PAD.left,
    y: PAD.top,
    width: plotW,
    height: plotH,
    fill: '#fbfcfe',
    rx: 6,
  });
  svg.appendChild(bg);

  const xStep = niceStep(xMax - xMin);
  const yStep = niceStep(yMax - yMin);
  const xTicks = tickValues(xMin, xMax, xStep);
  const yTicks = tickValues(yMin, yMax, yStep);
  const xAxisY = yMin <= 0 && yMax >= 0 ? sy(0) : PAD.top + plotH;
  const yAxisX = xMin <= 0 && xMax >= 0 ? sx(0) : PAD.left;

  if (spec.showGrid) {
    const grid = svgEl('g', { class: 'graph-grid' });
    for (const value of xTicks) {
      if (Math.abs(value) < 1e-9) continue;
      grid.appendChild(svgEl('line', {
        x1: sx(value), y1: PAD.top, x2: sx(value), y2: PAD.top + plotH,
        stroke: '#e8edf5', 'stroke-width': 1,
      }));
    }
    for (const value of yTicks) {
      if (Math.abs(value) < 1e-9) continue;
      grid.appendChild(svgEl('line', {
        x1: PAD.left, y1: sy(value), x2: PAD.left + plotW, y2: sy(value),
        stroke: '#e8edf5', 'stroke-width': 1,
      }));
    }
    svg.appendChild(grid);
  }

  // Shaded regions sit under the curves.
  if (spec.shades.length) {
    const shadeGroup = svgEl('g', { 'clip-path': `url(#${clipId})` });
    for (const shade of spec.shades) {
      const samples = sampleFunction(shade.evaluate, xMin, xMax, 360);
      const points = samples.filter((point) => Number.isFinite(point.y));
      if (points.length < 2) continue;
      let d = '';
      for (const [index, point] of points.entries()) {
        d += `${index === 0 ? 'M' : 'L'}${sx(point.x).toFixed(2)} ${sy(point.y).toFixed(2)}`;
      }
      const edgeY = shade.side === 'above' ? PAD.top : PAD.top + plotH;
      d += `L${sx(points[points.length - 1].x).toFixed(2)} ${edgeY}`;
      d += `L${sx(points[0].x).toFixed(2)} ${edgeY}Z`;
      shadeGroup.appendChild(svgEl('path', { d, fill: shade.color, 'fill-opacity': 0.12 }));
    }
    svg.appendChild(shadeGroup);
  }

  const axisGroup = svgEl('g');
  if (xMin <= 0 && xMax >= 0) {
    axisGroup.appendChild(svgEl('line', {
      x1: PAD.left, y1: xAxisY, x2: PAD.left + plotW, y2: xAxisY,
      stroke: '#596273', 'stroke-width': 1.5,
    }));
    axisGroup.appendChild(svgEl('path', {
      d: `M${PAD.left + plotW} ${xAxisY} l-9 -4.5 l0 9 Z`,
      fill: '#596273',
    }));
  }
  if (yMin <= 0 && yMax >= 0) {
    axisGroup.appendChild(svgEl('line', {
      x1: yAxisX, y1: PAD.top, x2: yAxisX, y2: PAD.top + plotH,
      stroke: '#596273', 'stroke-width': 1.5,
    }));
    axisGroup.appendChild(svgEl('path', {
      d: `M${yAxisX} ${PAD.top} l-4.5 9 l9 0 Z`,
      fill: '#596273',
    }));
  }
  svg.appendChild(axisGroup);

  const curveGroup = svgEl('g', { 'clip-path': `url(#${clipId})` });
  for (const fn of spec.functions) {
    const samples = sampleFunction(fn.evaluate, xMin, xMax, 900);
    let d = '';
    let pen = false;
    let prevY = null;
    const limitLo = yMin - (yMax - yMin) * 2;
    const limitHi = yMax + (yMax - yMin) * 2;
    for (const point of samples) {
      if (!Number.isFinite(point.y) || point.y < limitLo || point.y > limitHi) {
        pen = false;
        prevY = null;
        continue;
      }
      const px = sx(point.x);
      const py = sy(point.y);
      if (!pen) {
        d += `M${px.toFixed(2)} ${py.toFixed(2)}`;
        pen = true;
      } else if (prevY !== null && Math.abs(py - prevY) > plotH * 1.5) {
        d += `M${px.toFixed(2)} ${py.toFixed(2)}`;
      } else {
        d += `L${px.toFixed(2)} ${py.toFixed(2)}`;
      }
      prevY = py;
    }
    if (!d) continue;
    curveGroup.appendChild(svgEl('path', {
      d,
      fill: 'none',
      stroke: fn.color,
      'stroke-width': 2.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-dasharray': fn.dashed ? '7 6' : undefined,
    }));
  }

  for (const segment of spec.segments) {
    const line = svgEl('line', {
      x1: sx(segment.x1), y1: sy(segment.y1), x2: sx(segment.x2), y2: sy(segment.y2),
      stroke: segment.color, 'stroke-width': 2.2, 'stroke-linecap': 'round',
      'stroke-dasharray': segment.dashed ? '7 6' : undefined,
    });
    curveGroup.appendChild(line);
  }

  for (const point of spec.points) {
    const cx = sx(point.x);
    const cy = sy(point.y);
    curveGroup.appendChild(svgEl('circle', {
      cx, cy, r: 4.4,
      fill: point.open ? '#ffffff' : point.color,
      stroke: point.color,
      'stroke-width': 2,
    }));
    if (point.label) {
      const label = svgEl('text', {
        x: cx + 9,
        y: cy - 9,
        'font-size': 13,
        'font-weight': 600,
        fill: '#3b4252',
        'font-family': 'ui-sans-serif, system-ui, sans-serif',
      });
      label.textContent = point.label;
      curveGroup.appendChild(label);
    }
  }
  svg.appendChild(curveGroup);

  // Tick labels live above the curves but under the frame.
  const labelGroup = svgEl('g', { class: 'graph-labels' });
  for (const value of xTicks) {
    const x = sx(value);
    if (x < PAD.left - 1 || x > PAD.left + plotW + 1) continue;
    const isZero = Math.abs(value) < 1e-9;
    const y = xAxisY + 17;
    if (y > HEIGHT - 6) continue;
    const label = svgEl('text', {
      x,
      y,
      'text-anchor': 'middle',
      'font-size': 11,
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      fill: isZero ? '#596273' : '#7b8494',
    });
    label.textContent = fmt(value);
    labelGroup.appendChild(label);
  }
  for (const value of yTicks) {
    if (Math.abs(value) < 1e-9) continue;
    const y = sy(value);
    if (y < PAD.top || y > PAD.top + plotH) continue;
    const label = svgEl('text', {
      x: yAxisX - 9,
      y: y + 4,
      'text-anchor': 'end',
      'font-size': 11,
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      fill: '#7b8494',
    });
    label.textContent = fmt(value);
    labelGroup.appendChild(label);
  }
  svg.appendChild(labelGroup);

  const frame = svgEl('rect', {
    x: PAD.left,
    y: PAD.top,
    width: plotW,
    height: plotH,
    fill: 'none',
    stroke: '#dbe2ec',
    rx: 6,
  });
  svg.appendChild(frame);

  if (spec.xLabel) {
    const label = svgEl('text', {
      x: PAD.left + plotW,
      y: HEIGHT - 8,
      'text-anchor': 'end',
      'font-size': 12,
      'font-style': 'italic',
      fill: '#596273',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
    });
    label.textContent = spec.xLabel;
    svg.appendChild(label);
  }
  if (spec.yLabel) {
    const label = svgEl('text', {
      x: PAD.left + 8,
      y: PAD.top + 4,
      'text-anchor': 'start',
      'font-size': 12,
      'font-style': 'italic',
      fill: '#596273',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
    });
    label.textContent = spec.yLabel;
    svg.appendChild(label);
  }

  const figure = document.createElement('figure');
  figure.className = 'graph-figure';
  figure.appendChild(svg);

  const labelled = spec.functions.filter((fn) => fn.label);
  if (labelled.length) {
    const legend = document.createElement('figcaption');
    legend.className = 'graph-legend';
    for (const fn of labelled) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const swatch = document.createElement('i');
      swatch.style.background = fn.color;
      const text = document.createElement('span');
      text.textContent = fn.label;
      item.append(swatch, text);
      legend.appendChild(item);
    }
    figure.appendChild(legend);
  }

  host.appendChild(figure);
  return true;
}
