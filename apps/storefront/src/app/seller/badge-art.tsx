"use client";

import { useId } from "react";

/** Colours for each badge: a light and a dark end for the gradient. */
const colours: Record<string, [string, string]> = {
  chipukizi: ["#22c55e", "#15803d"],
  fiti: ["#f472b6", "#be185d"],
  poa: ["#38bdf8", "#0369a1"],
  moto: ["#fb923c", "#c2410c"],
  mkali: ["#c084fc", "#6d28d9"],
  boss: ["#facc15", "#b45309"],
  legend: ["#94a3b8", "#334155"],
};

/** The picture in the middle of each badge, drawn in white on a 100 x 108 board. */
const icons: Record<string, React.ReactNode> = {
  chipukizi: <path d="M50 62V44M50 48c0-9-7-14-16-13 0 9 7 14 16 13zM50 44c0-8 6-12 14-11 0 8-6 12-14 11z" fill="#fff" />,
  fiti: <path d="M50 68C34 57 32 48 36 42c4-5 10-3 14 3 4-6 10-8 14-3 4 6 2 15-14 26z" fill="#fff" />,
  poa: <path d="M54 30 38 54h11l-3 16 16-24H51z" fill="#fff" />,
  moto: <path d="M50 28c2 9 12 14 12 26a12 12 0 0 1-24 0c0-6 3-9 6-12 0 5 2 7 4 8-2-8 0-14 2-22z" fill="#fff" />,
  mkali: <path d="M36 40h28l7 8-21 22-21-22z M36 40l14 30 14-30M29 48h42" fill="#fff" fillOpacity="0.92" stroke="#0008" strokeWidth="1.5" />,
  boss: <><path d="M32 62 30 40l12 10 8-14 8 14 12-10-2 22z" fill="#fff" /><rect x="32" y="64" width="36" height="5" fill="#fff" /></>,
  legend: <path d="M50 30l5.5 11.5 12.5 1.7-9.2 8.7 2.3 12.4L50 58.4l-11.1 5.9 2.3-12.4-9.2-8.7 12.5-1.7z" fill="#fff" />,
};

const SHIELD = "M50 6 90 20v36c0 22-18 36-40 46C28 92 10 78 10 56V20z";
const INNER = "M50 14 82 25v30c0 17-14 29-32 37C32 84 18 72 18 55V25z";

/**
 * One badge: a dark shield with a colour rim, diagonal stripes and a picture.
 * Locked badges are grey with a padlock. `x`, `y` place it inside another SVG (the chart).
 */
export function BadgeShield({ id, locked = false, size = 96, x, y, opacity }: { id: string; locked?: boolean; size?: number; x?: number; y?: number; opacity?: number }) {
  const uid = useId().replace(/:/g, "");
  const [light, dark] = locked ? ["#9ca3af", "#6b7280"] : colours[id] ?? colours.chipukizi;
  return (
    <svg width={size} height={(size * 108) / 100} viewBox="0 0 100 108" x={x} y={y} opacity={opacity} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={light} /><stop offset="1" stopColor={dark} /></linearGradient>
        <pattern id={`p${uid}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="8" fill="#fff" opacity="0.13" /></pattern>
      </defs>
      <path d={SHIELD} fill="#111" />
      <path d={SHIELD} fill={`url(#g${uid})`} opacity="0.35" />
      <path d={INNER} fill={`url(#g${uid})`} />
      <path d={INNER} fill={`url(#p${uid})`} />
      <path d={SHIELD} fill="none" stroke={`url(#g${uid})`} strokeWidth="4" />
      <path d="M18 78 50 90 82 78" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.5" />
      {locked ? (
        <>
          <rect x="40" y="48" width="20" height="16" rx="3" fill="#e5e7eb" />
          <path d="M44 48v-5a6 6 0 0 1 12 0v5" fill="none" stroke="#e5e7eb" strokeWidth="4" />
        </>
      ) : icons[id]}
    </svg>
  );
}
