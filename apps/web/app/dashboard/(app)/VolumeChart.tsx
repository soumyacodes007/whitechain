"use client";

import { useState } from "react";

type Day = { day: string; received: number; refunded: number };

// Validated with the dataviz palette script for contrast and colour-blind separation.
const SERIES = [
  { key: "received", name: "Received", color: "#2a78d6" },
  { key: "refunded", name: "Refunded", color: "#eb6834" },
] as const;

const WIDTH = 720;
const HEIGHT = 200;
const PLOT = { left: 44, right: 8, top: 10, bottom: 24 };
const BAR_GAP = 2;

const usdt = (cents: number) => (cents / 100).toFixed(2);

function niceMax(value: number) {
  if (value <= 0) return 100;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

const compact = (cents: number) => {
  const value = cents / 100;
  return value >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K` : String(Math.round(value));
};

export function VolumeChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number>();
  const max = niceMax(Math.max(...days.map((day) => Math.max(day.received, day.refunded))));
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const band = plotWidth / days.length;
  const barWidth = Math.min((band - BAR_GAP * 2) / 2, 24);
  const y = (value: number) => PLOT.top + plotHeight - (value / max) * plotHeight;
  const active = hover === undefined ? undefined : days[hover];

  return (
    <figure className="chart">
      <div className="legend">
        {SERIES.map((series) => (
          <span key={series.key}>
            <i style={{ background: series.color }} /> {series.name}
          </span>
        ))}
        <span className="muted chart-readout">
          {active
            ? `${active.day}: ${usdt(active.received)} received, ${usdt(active.refunded)} refunded`
            : "Last 30 days, in USDT"}
        </span>
      </div>

      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Daily USDT received and refunded over 30 days">
        {[0, max / 2, max].map((tick) => (
          <g key={tick}>
            <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={y(tick)} y2={y(tick)} stroke="#e7e5e4" />
            <text x={PLOT.left - 6} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="#57534e">
              {compact(tick)}
            </text>
          </g>
        ))}

        {days.map((day, index) => {
          const x = PLOT.left + index * band;
          return (
            <g key={day.day}>
              {hover === index && <rect x={x} y={PLOT.top} width={band} height={plotHeight} fill="#f5f5f4" />}
              {SERIES.map((series, slot) => {
                const value = day[series.key];
                if (value === 0) return null;
                const top = Math.min(y(value), y(0) - 2);
                const left = x + BAR_GAP / 2 + slot * (barWidth + BAR_GAP / 2);
                const radius = Math.min(4, barWidth / 2);
                return (
                  <path
                    key={series.key}
                    fill={series.color}
                    d={`M${left},${y(0)} V${top + radius} Q${left},${top} ${left + radius},${top} H${left + barWidth - radius} Q${left + barWidth},${top} ${left + barWidth},${top + radius} V${y(0)} Z`}
                  />
                );
              })}
              <rect
                x={x}
                y={PLOT.top}
                width={band}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(undefined)}
              />
            </g>
          );
        })}

        <text x={PLOT.left} y={HEIGHT - 6} fontSize="11" fill="#57534e">
          {days[0]?.day}
        </text>
        <text x={WIDTH - PLOT.right} y={HEIGHT - 6} fontSize="11" fill="#57534e" textAnchor="end">
          {days.at(-1)?.day}
        </text>
      </svg>

      <details className="muted">
        <summary>View as table</summary>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Received</th>
                <th>Refunded</th>
              </tr>
            </thead>
            <tbody>
              {days
                .filter((day) => day.received > 0 || day.refunded > 0)
                .map((day) => (
                  <tr key={day.day}>
                    <td>{day.day}</td>
                    <td>{usdt(day.received)}</td>
                    <td>{usdt(day.refunded)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
