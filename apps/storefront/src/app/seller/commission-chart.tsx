"use client";

import { ScrollChart } from "./affiliate-charts";
import { BadgeShield } from "./badge-art";

export type CommissionPoint = { label: string; total: number; added: number };
export type BadgeMark = { index: number; id: string; name: string };
export type NextBadge = { id: string; name: string; thresholdKsh: number; remainingKsh: number };

const WIDTH = 940;
const LEFT = 62;
const RIGHT = 830;
const PLOT = 130;
const BADGE = 44;
const ROW = 66;
const MAX_LABELS = 12;

/**
 * The commission line: one line that only goes up, a dot and "+amount" on every day (or week) that
 * added something, and each badge sitting where it was unlocked. Plain SVG, no chart library.
 */
export function CommissionChart({
  points,
  marks,
  next,
  ariaLabel,
  nextLabel,
  formatMoney,
  swipeHint,
}: {
  points: CommissionPoint[];
  marks: BadgeMark[];
  next: NextBadge | null;
  ariaLabel: string;
  nextLabel: string;
  formatMoney: (value: number) => string;
  swipeHint?: string;
}) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const max = Math.max(1, last.total, next?.thresholdKsh ?? 0);
  const x = (index: number) => LEFT + (index / (points.length - 1)) * (RIGHT - LEFT);

  // Badges that are close together go on a second row so they do not cover each other.
  const sorted = [...marks].sort((a, b) => a.index - b.index);
  const rowEnds: number[] = [];
  const placed = sorted.map((mark) => {
    const left = x(mark.index) - BADGE / 2 - 4;
    let row = rowEnds.findIndex((end) => end <= left);
    if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
    rowEnds[row] = x(mark.index) + BADGE / 2 + 4;
    return { ...mark, row };
  });
  const rows = Math.max(1, rowEnds.length);
  const top = rows * ROW + 34;
  const bottom = top + PLOT;
  const y = (value: number) => bottom - (value / max) * PLOT;

  const growth = points.map((point, index) => ({ point, index })).filter(({ point }) => point.added > 0);
  const labelled = new Set(
    [...growth].sort((a, b) => b.point.added - a.point.added || b.index - a.index).slice(0, MAX_LABELS).map(({ index }) => index),
  );
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.total).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  const ticks = [0, Math.round(max / 2), max];
  const stride = Math.max(1, Math.ceil(points.length / 12));

  return (
    <ScrollChart minWidth={720} resetKey={`${points.length}-${last.label}-${rows}`} hint={swipeHint}>
    <figure className="m-0">
      <svg viewBox={`0 0 ${WIDTH} ${bottom + 34}`} role="img" aria-label={ariaLabel} className="h-auto w-full text-green-600">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={RIGHT} y1={y(tick)} y2={y(tick)} stroke="currentColor" strokeOpacity={tick === 0 ? 0.25 : 0.1} />
            <text x={LEFT - 8} y={y(tick) + 4} fontSize="11" textAnchor="end" fill="#888">{tick.toLocaleString("en-KE")}</text>
          </g>
        ))}
        {next ? <line x1={LEFT} x2={RIGHT} y1={y(next.thresholdKsh)} y2={y(next.thresholdKsh)} stroke="#7c3aed" strokeDasharray="5 5" /> : null}
        <path d={area} fill="currentColor" fillOpacity="0.12" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />

        {growth.map(({ point, index }) => (
          <g key={`dot-${index}`}>
            <circle cx={x(index)} cy={y(point.total)} r="3.5" fill="currentColor" />
            {labelled.has(index) ? (
              <text x={x(index)} y={y(point.total) - 9} fontSize="11" fontWeight="700" textAnchor="middle" fill="#15803d" style={{ paintOrder: "stroke", stroke: "#fff", strokeWidth: 3 }}>
                +{point.added.toLocaleString("en-KE")}
              </text>
            ) : null}
          </g>
        ))}

        {placed.map((mark) => {
          const top0 = mark.row * ROW + 2;
          const at = points[mark.index];
          return (
            <g key={mark.id}>
              <line x1={x(mark.index)} x2={x(mark.index)} y1={top0 + BADGE + 16} y2={y(at.total)} stroke="currentColor" strokeDasharray="3 4" strokeOpacity="0.6" />
              <circle cx={x(mark.index)} cy={y(at.total)} r="5" fill="#fff" stroke="currentColor" strokeWidth="3" />
              <BadgeShield id={mark.id} size={BADGE} x={x(mark.index) - BADGE / 2} y={top0} />
              <text x={x(mark.index)} y={top0 + BADGE + 14} fontSize="11" fontWeight="700" textAnchor="middle" fill="#15803d">{mark.name}</text>
            </g>
          );
        })}

        {next ? (
          <g>
            <BadgeShield id={next.id} size={40} x={WIDTH - 62} y={2} opacity={0.55} />
            <text x={LEFT + 8} y={y(next.thresholdKsh) - 8} fontSize="12" fontWeight="700" fill="#6d28d9" style={{ paintOrder: "stroke", stroke: "#fff", strokeWidth: 4 }}>{nextLabel}</text>
          </g>
        ) : null}

        <circle cx={x(points.length - 1)} cy={y(last.total)} r="6" fill="currentColor" />
        <text x={x(points.length - 1) + 12} y={y(last.total) + 5} fontSize="13" fontWeight="800" fill="currentColor" style={{ fill: "#111" }}>{formatMoney(last.total)}</text>

        {points.map((point, index) => (index % stride === 0 || index === points.length - 1 ? (
          <text key={`${point.label}-${index}`} x={x(index)} y={bottom + 22} fontSize="11" textAnchor="middle" fill="#888">{point.label}</text>
        ) : null))}
      </svg>
      {/* The same information as plain text, for people using a screen reader. */}
      <figcaption className="sr-only">{points.map((point) => `${point.label}: ${formatMoney(point.total)}`).join(", ")}</figcaption>
    </figure>
    </ScrollChart>
  );
}
