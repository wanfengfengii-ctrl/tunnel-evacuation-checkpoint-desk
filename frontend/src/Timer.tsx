import { useEffect, useRef, useState } from "react";

/** Elapsed/remaining timer for the command page.
 *
 * It is driven entirely by the two UTC instants the server returned at start:
 * ``startedAt`` and ``plannedEndAt``. A purely local one-second interval
 * recomputes the labels from the current wall clock — no API traffic, and
 * reloading the page re-runs the same math against the same persisted end
 * instant. The interval is cleared on unmount (including when the drill
 * disappears).
 */
export function formatDuration(totalSeconds: number): string {
  const abs = Math.abs(Math.floor(totalSeconds));
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

interface TimerProps {
  startedAt: string;
  plannedEndAt: string;
  /** Injection point for tests controlling the clock. */
  now?: () => number;
}

export default function Timer({ startedAt, plannedEndAt, now }: TimerProps) {
  // Keep the (possibly changing) clock source in a ref so the single interval
  // below is created once and only cleared on unmount.
  const nowRef = useRef<(() => number) | undefined>(now);
  nowRef.current = now;
  const readNow = () => (nowRef.current ? nowRef.current() : Date.now());

  const [nowMs, setNowMs] = useState<number>(() => readNow());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(readNow()), 1000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(plannedEndAt).getTime();

  const elapsedSeconds = Math.max(0, Math.round((nowMs - startMs) / 1000));
  const remainingSeconds = Math.round((endMs - nowMs) / 1000);
  const overtime = remainingSeconds < 0;

  // Stored as UTC, rendered in the browser's local time zone.
  const endLocal = new Date(plannedEndAt).toLocaleString("zh-CN", { hour12: false });

  return (
    <section className="timer" data-testid="timer">
      <p className="timer-row">
        预计结束：
        <strong data-testid="timer-end-at">{endLocal}</strong>
        （本地时间）
      </p>
      <p className="timer-row">
        已用时间：
        <strong data-testid="timer-elapsed">{formatDuration(elapsedSeconds)}</strong>
      </p>
      {overtime ? (
        <p className="timer-row timer-over" role="status" data-testid="timer-overtime">
          已超出预计 <strong>{formatDuration(-remainingSeconds)}</strong>
        </p>
      ) : (
        <p className="timer-row" data-testid="timer-remaining">
          剩余时间：<strong>{formatDuration(remainingSeconds)}</strong>
        </p>
      )}
    </section>
  );
}
