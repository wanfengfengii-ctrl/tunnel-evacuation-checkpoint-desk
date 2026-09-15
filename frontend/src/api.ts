import type { ConflictBody, ConfirmPayload, DrillState } from "./types";

/** Error carrying the HTTP status and the parsed body so the UI can show the
 * server's actual node/version after a 409. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ConflictBody | { detail?: string };

  constructor(
    status: number,
    body: ConflictBody | { detail?: string },
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (networkError) {
    throw new ApiError(
      0,
      { detail: networkError instanceof Error ? networkError.message : String(networkError) },
      "无法连接指挥 API",
    );
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      body as ConflictBody,
      `请求失败：HTTP ${response.status}`,
    );
  }
  return body as T;
}

export const api = {
  /** Returns null when no drill exists yet (404). */
  async getDrill(): Promise<DrillState | null> {
    try {
      return await request<DrillState>("/api/drills");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  /** Starts the drill.
   *
   * Without an argument no body is sent at all, exactly like an old client
   * (the server then applies its 30-minute default). With an argument the
   * duration is posted as JSON and the server validates the 5..180 range. */
  startDrill(plannedMinutes?: number): Promise<DrillState> {
    if (plannedMinutes === undefined) {
      return request<DrillState>("/api/drills/start", { method: "POST" });
    }
    return request<DrillState>("/api/drills/start", {
      method: "POST",
      body: JSON.stringify({ planned_minutes: plannedMinutes }),
    });
  },

  confirm(payload: ConfirmPayload): Promise<DrillState> {
    return request<DrillState>("/api/drills/confirm", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
