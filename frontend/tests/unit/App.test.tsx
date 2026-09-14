import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../src/App";
import { nodeLabel } from "../../src/types";

const STEPS = ["cross_passage_open", "upstream_seal", "headcount"];

function stateBody(overrides: Partial<{
  status: "in_progress" | "completed";
  node: string;
  version: number;
}> = {}) {
  return {
    status: "in_progress",
    node: STEPS[0],
    version: 1,
    steps: STEPS,
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
});
