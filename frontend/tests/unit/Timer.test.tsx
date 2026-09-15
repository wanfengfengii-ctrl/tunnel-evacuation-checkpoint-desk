import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import Timer, { formatDuration } from "../../src/Timer";

const START = "2026-09-15T10:00:00.000Z";
const END = "2026-09-15T10:30:00.000Z";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatDuration", () => {
  it("formats seconds as MM:SS and adds hours past 60 minutes", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(9)).toBe("00:09");
    expect(formatDuration(75)).toBe("01:15");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});

describe("Timer", () => {
  it("ticks every second against a controllable clock and switches to overtime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:29:58.000Z"));
    render(<Timer startedAt={START} plannedEndAt={END} />);

    expect(screen.getByTestId("timer-elapsed")).toHaveTextContent("29:58");
    expect(screen.getByTestId("timer-remaining")).toHaveTextContent("00:02");
    expect(screen.queryByTestId("timer-overtime")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    // Exactly at the planned end: remaining 00:00.
    expect(screen.getByTestId("timer-remaining")).toHaveTextContent("00:00");

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.queryByTestId("timer-remaining")).not.toBeInTheDocument();
    expect(screen.getByTestId("timer-overtime")).toHaveTextContent("已超出预计");
    expect(screen.getByTestId("timer-overtime")).toHaveTextContent("00:04");
    expect(screen.getByTestId("timer-elapsed")).toHaveTextContent("30:04");
  });

  it("keeps counting from the same instants when mounted again (page reload)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:35:00.000Z"));

    const { unmount } = render(<Timer startedAt={START} plannedEndAt={END} />);
    expect(screen.getByTestId("timer-overtime")).toHaveTextContent("05:00");
    unmount();

    // A fresh mount (equivalent to reloading the page) re-derives the same
    // overtime purely from the server instants and the current clock.
    vi.setSystemTime(new Date("2026-09-15T10:36:30.000Z"));
    render(<Timer startedAt={START} plannedEndAt={END} />);
    expect(screen.getByTestId("timer-overtime")).toHaveTextContent("06:30");
  });

  it("clears its interval on unmount and never polls the clock again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:00:00.000Z"));
    const clearSpy = vi.spyOn(window, "clearInterval");
    let reads = 0;
    const now = () => {
      reads += 1;
      return Date.now();
    };

    const { unmount } = render(<Timer startedAt={START} plannedEndAt={END} now={now} />);
    const initialReads = reads;
    expect(initialReads).toBeGreaterThanOrEqual(1);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(reads).toBe(initialReads + 3);

    unmount();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(reads).toBe(initialReads + 3);
  });
});
