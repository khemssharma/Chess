import { apiFetch } from "../api/apiClient";

export interface GameRecord {
  id: string;
  whiteUser: { id: number; username: string } | null;
  blackUser: { id: number; username: string } | null;
  moveCount: number;
  timeControl: number | null;
  status: string;
  winner: string | null;
  reason: string | null;
  isVsComputer: boolean;
  computerDifficulty: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Move {
  from: string;
  to: string;
  promotion?: string;
}

export interface FullGame extends GameRecord {
  moveHistory: Move[];
}

export interface MoveAnalysis {
  moveIndex: number;
  move: string;
  san: string;
  color: "white" | "black";
  evalBefore: number;
  evalAfter: number;
  evalDelta: number;
  bestMove: string;
  classification: "brilliant" | "great" | "good" | "book" | "inaccuracy" | "mistake" | "blunder" | "forced";
  comment: string;
  isMate: boolean;
  mateIn?: number;
}

export interface GameAnalysis {
  moves: MoveAnalysis[];
  whiteAccuracy: number;
  blackAccuracy: number;
  whiteMistakes: number;
  whiteBlunders: number;
  blackMistakes: number;
  blackBlunders: number;
  whiteInaccuracies: number;
  blackInaccuracies: number;
}

export class GameService {
  static async getMyGames(): Promise<GameRecord[]> {
    const res = await apiFetch("/api/games");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Failed to load game history");
    }
    const data = await res.json();
    return data.games ?? [];
  }

  static async getGameById(gameId: string): Promise<FullGame> {
    const res = await apiFetch(`/api/games/${gameId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Game not found");
    }
    const data = await res.json();
    if (!data.game) {
      throw new Error("Game not found");
    }
    return data.game;
  }

  static async analyzeGame(gameId: string): Promise<GameAnalysis> {
    const res = await apiFetch(`/api/games/${gameId}/analyze`, {
      method: "POST"
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Analysis failed");
    }
    const data = await res.json();
    if (!data.analysis) {
      throw new Error("Analysis failed");
    }
    return data.analysis;
  }
}
