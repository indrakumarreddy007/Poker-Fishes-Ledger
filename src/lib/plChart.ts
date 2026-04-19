export interface SessionPLPoint {
  sessionId: string;
  sessionName: string;
  date: number;
  pl: number;
}

export interface CumulativePoint extends SessionPLPoint {
  cum: number;
}

export interface ChartScale {
  minV: number;
  maxV: number;
  span: number;
}

export function computeCumulative(points: SessionPLPoint[]): CumulativePoint[] {
  let running = 0;
  return points.map(p => ({ ...p, cum: (running += p.pl) }));
}

export function computeScale(cumulative: CumulativePoint[]): ChartScale {
  const values = cumulative.map(p => p.cum);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const span = maxV - minV || 1;
  return { minV, maxV, span };
}

export function xFor(i: number, count: number, W: number, padX: number): number {
  if (count <= 1) return W / 2;
  return padX + (i * (W - 2 * padX)) / (count - 1);
}

export function yFor(v: number, scale: ChartScale, H: number, padY: number): number {
  return padY + (1 - (v - scale.minV) / scale.span) * (H - 2 * padY);
}
