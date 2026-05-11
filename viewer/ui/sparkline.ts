/**
 * Tiny inline SVG sparkline renderer.
 *
 * Used by the history panels to visualize entity trajectories (population,
 * cargo, treasury, banditCount). Inline SVG keeps everything DOM-driven so
 * panels can drop a sparkline next to a stat-row without juggling Pixi
 * layers.
 *
 * The sparkline is intentionally minimal:
 *   - Fixed pixel size so it matches the sidebar's tabular layout.
 *   - One filled polyline tinted by an accent color.
 *   - Last value annotated as a small dot.
 *   - Auto-y-scaled to the data series; if all values are equal we draw a
 *     centered flat line so the user can still tell the metric was sampled.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SparklineOpts {
  readonly width?: number;
  readonly height?: number;
  readonly color?: string;
  readonly fill?: string;
  /** Optional y-min / y-max override to share scale across multiple sparks. */
  readonly yMin?: number;
  readonly yMax?: number;
}

const DEFAULTS: Required<Omit<SparklineOpts, 'yMin' | 'yMax'>> = {
  width: 80,
  height: 18,
  color: '#d2a44b',
  fill: 'rgba(210, 164, 75, 0.18)',
};

export const createSparkline = (
  values: readonly number[],
  opts: SparklineOpts = {},
): SVGSVGElement => {
  const w = opts.width ?? DEFAULTS.width;
  const h = opts.height ?? DEFAULTS.height;
  const color = opts.color ?? DEFAULTS.color;
  const fill = opts.fill ?? DEFAULTS.fill;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.style.verticalAlign = 'middle';
  svg.style.overflow = 'visible';

  if (values.length === 0) {
    return svg;
  }

  let yMin = opts.yMin ?? Number.POSITIVE_INFINITY;
  let yMax = opts.yMax ?? Number.NEGATIVE_INFINITY;
  if (opts.yMin === undefined || opts.yMax === undefined) {
    for (const v of values) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!Number.isFinite(yMin)) yMin = 0;
  if (!Number.isFinite(yMax)) yMax = 0;
  let range = yMax - yMin;
  if (range <= 0) range = 1;

  const pad = 2;
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const n = values.length;

  const xFor = (i: number): number =>
    n === 1 ? pad + innerW / 2 : pad + (i / (n - 1)) * innerW;
  const yFor = (v: number): number => pad + innerH - ((v - yMin) / range) * innerH;

  // Fill polygon (under the line).
  const polyPoints: string[] = [];
  polyPoints.push(`${xFor(0)},${pad + innerH}`);
  for (let i = 0; i < n; i++) {
    polyPoints.push(`${xFor(i)},${yFor(values[i] as number)}`);
  }
  polyPoints.push(`${xFor(n - 1)},${pad + innerH}`);
  const fillPoly = document.createElementNS(SVG_NS, 'polygon');
  fillPoly.setAttribute('points', polyPoints.join(' '));
  fillPoly.setAttribute('fill', fill);
  svg.appendChild(fillPoly);

  // Line.
  const linePoints: string[] = [];
  for (let i = 0; i < n; i++) {
    linePoints.push(`${xFor(i)},${yFor(values[i] as number)}`);
  }
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', linePoints.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1');
  svg.appendChild(line);

  // Last-value dot.
  const lastV = values[n - 1] as number;
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', String(xFor(n - 1)));
  dot.setAttribute('cy', String(yFor(lastV)));
  dot.setAttribute('r', '1.5');
  dot.setAttribute('fill', color);
  svg.appendChild(dot);

  return svg;
};

/**
 * Format a number compactly for inline display next to a sparkline.
 * 1234 → 1.2k, 12345 → 12k, 1.234 → 1.2.
 */
export const fmtCompact = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (abs >= 10) return `${Math.round(n)}`;
  if (abs >= 1) return n.toFixed(1);
  return n.toFixed(2);
};
