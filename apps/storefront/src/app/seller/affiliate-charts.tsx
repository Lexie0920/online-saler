"use client";

/**
 * A small line chart for the Affiliate Center (plain SVG, no chart library).
 * It draws one line, marks the best day, and has a text summary for screen readers.
 */
export type ChartPoint = { label: string; value: number };

const WIDTH = 640;
const HEIGHT = 200;
const PAD = { top: 24, right: 24, bottom: 28, left: 24 };

export function LineChart({
  points,
  ariaLabel,
  formatValue,
  markBest = true,
  muted = false,
  dashed = false,
}: {
  points: ChartPoint[];
  ariaLabel: string;
  formatValue: (value: number) => string;
  markBest?: boolean;
  /** Greyed out, for the labelled example shown to new promoters. */
  muted?: boolean;
  dashed?: boolean;
}) {
  if (points.length < 2) return null;
  const max = Math.max(1, ...points.map((point) => point.value));
  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (index / (points.length - 1)) * innerWidth;
  const y = (value: number) => PAD.top + innerHeight - (value / max) * innerHeight;
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(PAD.top + innerHeight).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + innerHeight).toFixed(1)} Z`;
  const best = markBest ? bestPoint(points) : -1;
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={ariaLabel}
        className={`h-auto w-full ${muted ? "text-muted-foreground" : "text-primary"}`}
      >
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={PAD.top + innerHeight} y2={PAD.top + innerHeight} stroke="currentColor" strokeOpacity="0.2" />
        <path d={area} fill="currentColor" fillOpacity="0.08" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dashed ? "6 6" : undefined} />
        {points.length <= 14 && !dashed ? points.map((point, index) => (
          <circle key={point.label + index} cx={x(index)} cy={y(point.value)} r="4" fill="#fff" stroke="currentColor" strokeWidth="2" />
        )) : null}
        {best >= 0 ? (
          <g>
            <circle cx={x(best)} cy={y(points[best].value)} r="6" fill="#16a34a" />
            <text
              x={Math.min(Math.max(x(best), 60), WIDTH - 60)}
              y={Math.max(y(points[best].value) - 10, 12)}
              textAnchor="middle"
              fontSize="13"
              fontWeight="600"
              fill="#15803d"
            >
              {formatValue(points[best].value)}
            </text>
          </g>
        ) : null}
        {points.length <= 7 ? points.map((point, index) => (
          <text key={point.label + index} x={x(index)} y={HEIGHT - 8} fontSize="11" textAnchor="middle" fill="currentColor" fillOpacity="0.7">{point.label}</text>
        )) : (
          <>
            <text x={PAD.left} y={HEIGHT - 8} fontSize="11" fill="currentColor" fillOpacity="0.7">{first.label}</text>
            <text x={WIDTH - PAD.right} y={HEIGHT - 8} fontSize="11" textAnchor="end" fill="currentColor" fillOpacity="0.7">{last.label}</text>
          </>
        )}
      </svg>
    </figure>
  );
}

/** Index of the highest point (the latest one on a tie), or -1 when every point is zero. */
export function bestPoint(points: ChartPoint[]): number {
  let best = -1;
  let bestValue = 0;
  points.forEach((point, index) => {
    if (point.value > 0 && point.value >= bestValue) { best = index; bestValue = point.value; }
  });
  return best;
}

/** Running total of daily values, so an "earned so far" line only goes up. */
export function runningTotal(values: number[]): number[] {
  let total = 0;
  return values.map((value) => { total += value; return total; });
}

/** A made-up curve for new promoters. It is always drawn muted and labelled Example. */
export const EXAMPLE_ORDERS_PER_DAY = [0, 0, 1, 0, 1, 2, 1, 3, 2, 4, 3, 5, 4, 6];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Chart label for a Nairobi date (YYYY-MM-DD): the weekday for a week view, month-day for longer views. */
export function dayLabel(date: string, days: number): string {
  if (days > 7) return date.slice(5);
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}
