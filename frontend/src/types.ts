export type DrillStatus = "in_progress" | "completed";

export interface DrillState {
  status: DrillStatus;
  /** The node the server currently waits for; last node name when completed. */
  node: string;
  /** Optimistic-lock version the page has last seen from the server. */
  version: number;
  /** Fixed confirmation order. */
  steps: string[];
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
