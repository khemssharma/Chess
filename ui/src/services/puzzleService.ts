import { apiFetch } from "../api/apiClient";

export interface PuzzleData {
  id: number;
  fen: string;
  solution: string[]; // UCI moves alternating solver / opponent reply
  playerColor: "white" | "black";
  rating: number;
  themes: string;
  userPuzzleRating: number;
}

export interface AttemptResult {
  solved: boolean;
  ratingBefore: number;
  ratingAfter: number;
  ratingDelta: number;
}

export interface PuzzleStats {
  puzzleRating: number;
  provisional: boolean;
  totalAttempts: number;
  solved: number;
  accuracy: number;
  streak: number;
}

export class PuzzleService {
  static async getMyStats(): Promise<PuzzleStats> {
    const res = await apiFetch("/api/puzzles/me");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Failed to load puzzle stats");
    }
    return res.json();
  }

  static async getNextPuzzle(): Promise<PuzzleData> {
    const res = await apiFetch("/api/puzzles/next");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Failed to load puzzle");
    }
    return res.json();
  }

  static async submitAttempt(puzzleId: number, solved: boolean, moves: string[]): Promise<AttemptResult> {
    const res = await apiFetch(`/api/puzzles/${puzzleId}/attempt`, {
      method: "POST",
      body: JSON.stringify({ solved, moves }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Attempt submission failed");
    }
    return res.json();
  }
}
