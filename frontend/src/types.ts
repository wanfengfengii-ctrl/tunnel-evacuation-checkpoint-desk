export type DrillStatus = "in_progress" | "completed";

export interface DrillState {
  status: DrillStatus;
  /** The node the server currently waits for; last node name when completed. */
  node: string;
  /** Optimistic-lock version the page has last seen from the server. */
  version: number;
  /** Fixed confirmation order. */
  steps: string[];
  /** Operator estimate accepted by the server, in minutes (5..180). */
  planned_minutes: number;
  /** Server-side UTC start instant (ISO-8601). */
  started_at: string;
  /** Server-computed UTC end instant = started_at + planned_minutes. */
  planned_end_at: string;
}

export interface ConfirmPayload {
  node: string;
  version: number;
}

/** Body of an HTTP 409: always carries the server's actual node/version. */
export interface ConflictBody {
  error: string;
  detail: string;
  node?: string;
  version?: number;
  drill_status?: string;
}

export const NODE_LABELS: Record<string, string> = {
  cross_passage_open: "横通道开启",
  upstream_seal: "上游封闭",
  headcount: "人员清点",
};

export function nodeLabel(node: string): string {
  return NODE_LABELS[node] ?? node;
}

export const MIN_PLANNED_MINUTES = 5;
export const MAX_PLANNED_MINUTES = 180;
export const DEFAULT_PLANNED_MINUTES = 30;
