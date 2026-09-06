interface Props {
  startsInMs: number;
}

/** Big numerals while a scheduled start counts down. */
export function Countdown({ startsInMs }: Props) {
  const n = Math.max(1, Math.ceil(startsInMs / 1000));
  return (
    <div className="sb-countdown" aria-live="assertive">
      <div className="sb-countdown__num" key={n}>{n}</div>
      <div className="sb-countdown__sub">Starting together</div>
    </div>
  );
}
