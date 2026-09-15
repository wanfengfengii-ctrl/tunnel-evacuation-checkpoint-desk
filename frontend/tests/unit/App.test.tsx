import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../src/App";
import { nodeLabel } from "../../src/types";

const STEPS = ["cross_passage_open", "upstream_seal", "headcount"];

// Fixed UTC timing basis for state bodies. Tests that exercise the countdown
// build their own instants aligned with the faked clock.
const STARTED_AT = new Date("2026-09-15T10:00:00.000Z").toISOString();
const PLANNED_END_AT = new Date("2026-09-15T10:30:00.000Z").toISOString();

function stateBody(overrides: Partial<{
  status: "in_progress" | "completed";
  node: string;
  version: number;
  planned_minutes: number;
  started_at: string;
  planned_end_at: string;
}> = {}) {
  return {
    status: "in_progress",
    node: STEPS[0],
    version: 1,
    steps: STEPS,
    planned_minutes: 30,
    started_at: STARTED_AT,
    planned_end_at: PLANNED_END_AT,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders start button when no drill exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );
    render(<App />);
    expect(await screen.findByTestId("start-button")).toBeInTheDocument();
  });

  it("after a 409 it shows the server message and refreshes to server state", async () => {
    // Page has seen upstream_seal@2, but a retry already advanced the server
    // to headcount@3. The late confirm must be rejected and the page must end
    // up showing actual server truth.
    const serverState = {
      current: stateBody({ node: "headcount", version: 3 }),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/drills") && method === "GET") {
        return jsonResponse(200, serverState.current);
      }
      if (url.endsWith("/api/drills/confirm") && method === "POST") {
        return jsonResponse(409, {
          error: "old_version",
          detail: "提交的是旧版本 2，服务器当前版本为 3。",
          node: "headcount",
          version: 3,
          drill_status: "in_progress",
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Seed initial page load at the state the page believes in (v2), then let
    // the "server" be ahead for every subsequent GET.
    let loads = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/drills") && method === "GET") {
        loads += 1;
        return jsonResponse(
          200,
          loads === 1
            ? stateBody({ node: "upstream_seal", version: 2 })
            : serverState.current,
        );
      }
      if (url.endsWith("/api/drills/confirm") && method === "POST") {
        return jsonResponse(409, {
          error: "old_version",
          detail: "提交的是旧版本 2，服务器当前版本为 3。",
          node: "headcount",
          version: 3,
          drill_status: "in_progress",
        });
      }
      return new Response("not found", { status: 404 });
    });

    render(<App />);
    const confirmButton = await screen.findByTestId("confirm-button");
    expect(confirmButton).toHaveTextContent(nodeLabel("upstream_seal"));

    fireEvent.click(confirmButton);

    // Error visible ...
    expect(await screen.findByTestId("error-banner")).toBeInTheDocument();
    expect(screen.getByTestId("error-text")).toHaveTextContent("旧版本 2");
    // ... and the page refreshes to the actual server node.
    await waitFor(() =>
      expect(screen.getByTestId("current-node")).toHaveTextContent(
        nodeLabel("headcount"),
      ),
    );
    expect(screen.getByTestId("current-version")).toHaveTextContent("3");
  });

  it("completed drill shows exactly one completion result and no confirm button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, stateBody({ status: "completed", node: "headcount", version: 4 })),
      ),
    );
    render(<App />);
    expect(await screen.findByTestId("completed-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("start-button")).not.toBeInTheDocument();
  });

  it("validates the duration before start and blocks the request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/drills") && (init?.method ?? "GET") === "GET") {
        return new Response("", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const input = await screen.findByTestId("planned-minutes");
    const startButton = screen.getByTestId("start-button");
    expect(startButton).toBeEnabled();

    fireEvent.change(input, { target: { value: "200" } });
    expect(await screen.findByTestId("duration-hint")).toHaveTextContent("5 至 180");
    expect(startButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "4" } });
    expect(startButton).toBeDisabled();
    expect(screen.getByTestId("duration-hint")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(startButton).toBeDisabled();

    // No start request was attempted for any invalid value.
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/api/drills/start") && init?.method === "POST",
      ),
    ).toHaveLength(0);

    // A valid value clears the hint and enables start again.
    fireEvent.change(input, { target: { value: "45" } });
    expect(screen.queryByTestId("duration-hint")).not.toBeInTheDocument();
    expect(startButton).toBeEnabled();
  });

  it("sends the chosen duration when starting", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/drills/start") && method === "POST") {
        return jsonResponse(201, stateBody({ planned_minutes: 90 }));
      }
      if (url.endsWith("/api/drills") && method === "GET") {
        return new Response("", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.change(await screen.findByTestId("planned-minutes"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByTestId("start-button"));

    await screen.findByTestId("confirm-button");
    const startCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/api/drills/start") && init?.method === "POST",
    );
    expect(startCall).toBeDefined();
    expect(JSON.parse(startCall![1]!.body as string)).toEqual({ planned_minutes: 90 });
  });

  it("drives the timer from the server end instant, flips to overtime, and makes no extra API calls", async () => {
    // The page receives a fixed server basis: 10:00:00Z -> 10:00:30Z.
    const basis = stateBody({
      started_at: "2026-09-15T10:00:00.000Z",
      planned_end_at: "2026-09-15T10:00:30.000Z",
    });
    let clockMs = Date.parse("2026-09-15T10:00:25.000Z");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/drills") && method === "GET") {
        return jsonResponse(200, basis);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App now={() => clockMs} />);

    // Five seconds remain, no overtime banner yet.
    await waitFor(() =>
      expect(screen.getByTestId("timer-remaining")).toHaveTextContent("00:05"),
    );
    expect(screen.queryByTestId("timer-overtime")).not.toBeInTheDocument();

    // Advance the controllable clock past the server-provided end instant;
    // the local interval (real timers, fast-forwarded here) re-renders alone.
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      clockMs = Date.parse("2026-09-15T10:00:35.000Z");
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });

    expect(screen.getByTestId("timer-overtime")).toHaveTextContent("已超出预计");
    expect(screen.getByTestId("timer-overtime")).toHaveTextContent("00:05");
    expect(screen.queryByTestId("timer-remaining")).not.toBeInTheDocument();

    // Ticking never triggers an API request: same call count as before the wait.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("completes the full three-step confirmation flow while the timer keeps running", async () => {
    const basis = stateBody({
      started_at: "2026-09-15T10:00:00.000Z",
      planned_end_at: "2026-09-30T10:00:00.000Z",
    });
    let server: {
      node: string;
      version: number;
      status: "in_progress" | "completed";
    } = { node: STEPS[0], version: 1, status: "in_progress" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/drills/confirm") && method === "POST") {
        const payload = JSON.parse((init?.body as string) ?? "{}");
        expect(payload.node).toBe(server.node);
        expect(payload.version).toBe(server.version);
        const index = STEPS.indexOf(server.node);
        if (index === STEPS.length - 1) {
          server = { node: STEPS[index], version: server.version + 1, status: "completed" };
        } else {
          server = { node: STEPS[index + 1], version: server.version + 1, status: "in_progress" };
        }
        return jsonResponse(200, {
          ...basis,
          status: server.status,
          node: server.node,
          version: server.version,
        });
      }
      if (url.endsWith("/api/drills") && method === "GET") {
        return jsonResponse(200, {
          ...basis,
          status: server.status,
          node: server.node,
          version: server.version,
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App now={() => Date.parse("2026-09-15T10:05:00.000Z")} />);
    expect(await screen.findByTestId("timer")).toBeInTheDocument();

    for (const step of STEPS) {
      const button = await screen.findByTestId("confirm-button");
      expect(button).toHaveTextContent(nodeLabel(step));
      fireEvent.click(button);
      await waitFor(() => {
        if (step === STEPS[STEPS.length - 1]) {
          expect(screen.getByTestId("completed-banner")).toBeInTheDocument();
        } else {
          expect(screen.getByTestId("current-node")).not.toHaveTextContent(nodeLabel(step));
        }
      });
    }

    // Completed exactly once; timer still shows the fixed end instant.
    expect(screen.queryByTestId("confirm-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("timer")).toBeInTheDocument();
    const confirmCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/api/drills/confirm") && init?.method === "POST",
    );
    expect(confirmCalls).toHaveLength(3);
  });
});
