import { spawn } from "child_process";
import { Chess } from "chess.js";

export type MoveClassification =
  | "brilliant"
  | "great"
  | "good"
  | "book"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "forced";

export interface MoveAnalysis {
  moveIndex: number;          // 1-based
  move: string;               // e.g. "e2e4"
  san: string;                // e.g. "e4"
  color: "white" | "black";
  evalBefore: number;         // centipawns (from white's perspective)
  evalAfter: number;
  evalDelta: number;          // loss from side-to-move perspective (positive = worse)
  bestMove: string;           // UCI best move Stockfish suggested
  classification: MoveClassification;
  comment: string;            // AI-generated commentary
  isMate: boolean;
  mateIn?: number;            // white-relative: positive = white has mate, negative = black has mate
}

export interface GameAnalysis {
  moves: MoveAnalysis[];
  whiteAccuracy: number;      // 0-100
  blackAccuracy: number;
  whiteMistakes: number;
  whiteBlunders: number;
  blackMistakes: number;
  blackBlunders: number;
  whiteInaccuracies: number;
  blackInaccuracies: number;
}

// Convert centipawn eval swing to accuracy using Lichess-style formula
function swingToAccuracy(swing: number): number {
  const raw = 103.1668 * Math.exp(-0.04354 * Math.max(0, swing / 100)) - 3.1668;
  return Math.max(0, Math.min(100, raw));
}

function classifyMove(delta: number, isMate: boolean, wasMate: boolean, bestMove: string, playedMove: string): MoveClassification {
  if (wasMate && !isMate) return "blunder";  // had mate, missed it
  if (isMate) return bestMove === playedMove ? "brilliant" : "good";
  if (bestMove === playedMove && delta === 0) return "great";
  if (delta < 10) return "good";
  if (delta < 50) return "inaccuracy";
  if (delta < 150) return "mistake";
  return "blunder";
}

function generateComment(
  classification: MoveClassification,
  san: string,
  delta: number,
  evalAfter: number,
  bestMove: string,
  playedMove: string,
  color: "white" | "black",
  isMate: boolean,
  mateIn?: number
): string {
  const side = color === "white" ? "White" : "Black";
  const opponent = color === "white" ? "Black" : "White";
  const evalStr = (cp: number) => {
    const abs = Math.abs(cp) / 100;
    if (abs > 10) return "completely winning";
    if (abs > 5) return "clearly winning";
    if (abs > 2) return "better";
    if (abs > 0.5) return "slightly better";
    return "roughly equal";
  };

  if (isMate && mateIn) {
    if (classification === "brilliant" || classification === "great" || classification === "good") {
      return `${san} delivers checkmate in ${Math.abs(mateIn)}! Excellent tactical vision from ${side}.`;
    }
    return `${san} keeps the mating attack alive. The position is winning for ${color === "white" ? "White" : "Black"}.`;
  }

  switch (classification) {
    case "brilliant":
      return `${san} is the best move! ${side} finds the optimal continuation, maintaining a ${evalStr(evalAfter)} position.`;
    case "great":
      return `${san} is an excellent move. ${side} keeps the position well under control.`;
    case "good":
      if (delta < 20) return `${san} is a solid, accurate move. ${side} stays on the right track.`;
      return `${san} is a reasonable choice. The position remains ${evalStr(evalAfter)}.`;
    case "inaccuracy":
      return `${san} is a slight inaccuracy (\u2212${(delta / 100).toFixed(1)}). A better option was ${bestMove}. The position is still ${evalStr(evalAfter)}.`;
    case "mistake":
      return `${san} is a mistake (\u2212${(delta / 100).toFixed(1)} pawns). ${side} should have played ${bestMove} instead. ${opponent} is now ${evalStr(-evalAfter)}.`;
    case "blunder":
      if (delta > 500) return `${san} is a serious blunder! ${side} loses a significant amount of material or positional advantage. The computer suggests ${bestMove} as the correct move.`;
      return `${san} is a blunder (\u2212${(delta / 100).toFixed(1)} pawns). ${bestMove} was the right continuation. ${opponent} takes a decisive advantage.`;
    case "book":
      return `${san} is a standard opening move, following well-known theory.`;
    case "forced":
      return `${san} \u2014 the only reasonable move in this position.`;
    default:
      return "";
  }
}

/**
 * Evaluate a FEN position with Stockfish.
 * Returns score always from White's perspective (positive = White better).
 * mateIn is also white-relative: positive = White has forced mate, negative = Black has forced mate.
 */
async function getStockfishEval(
  fen: string,
  depth: number = 18
): Promise<{ score: number; bestMove: string; isMate: boolean; mateIn?: number }> {
  return new Promise((resolve) => {
    const candidates = [
      `${__dirname}/../../stockfish-bin`,
      "stockfish",
      "/usr/games/stockfish",
      "/usr/bin/stockfish",
      "/usr/local/bin/stockfish",
    ];

    // Determine side to move from FEN (needed to flip score to white-relative)
    const sideToMove = fen.split(" ")[1] === "b" ? "black" : "white";

    let sf: ReturnType<typeof spawn> | null = null;
    for (const bin of candidates) {
      try {
        sf = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        break;
      } catch {
        sf = null;
      }
    }

    if (!sf) {
      resolve({ score: 0, bestMove: "", isMate: false });
      return;
    }

    let score = 0;
    let bestMove = "";
    let isMate = false;
    let mateIn: number | undefined;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { sf!.kill(); } catch {}
        resolve({ score, bestMove, isMate, mateIn });
      }
    }, 5000);

    sf.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ score: 0, bestMove: "", isMate: false });
      }
    });

    (sf.stdout as NodeJS.ReadableStream).setEncoding("utf8");
    (sf.stdout as NodeJS.ReadableStream).on("data", (data: string) => {
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.startsWith("info") && line.includes("score")) {
          const mateMatch = line.match(/score mate (-?\d+)/);
          if (mateMatch) {
            isMate = true;
            // mateIn from Stockfish is relative to side-to-move:
            // positive = current side has mate, negative = current side is getting mated
            const mateRelative = parseInt(mateMatch[1]);
            // Convert to white-relative:
            // If white to move: mateRelative > 0 means white has mate -> positive
            // If black to move: mateRelative > 0 means black has mate -> negative for white
            mateIn = sideToMove === "white" ? mateRelative : -mateRelative;
            score = mateIn > 0 ? 30000 : -30000;
          } else {
            const cpMatch = line.match(/score cp (-?\d+)/);
            if (cpMatch) {
              // cp is also side-to-move relative — convert to white-relative
              const cpRelative = parseInt(cpMatch[1]);
              score = sideToMove === "white" ? cpRelative : -cpRelative;
              isMate = false;
            }
          }
        }
        if (line.startsWith("bestmove")) {
          const parts = line.trim().split(" ");
          bestMove = parts[1] || "";
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            try { sf!.kill(); } catch {}
            resolve({ score, bestMove, isMate, mateIn });
          }
        }
      }
    });

    if (sf.stdin) {
      sf.stdin.write("uci\n");
      sf.stdin.write("setoption name Threads value 1\n");
      sf.stdin.write("setoption name Hash value 16\n");
      sf.stdin.write("isready\n");
      sf.stdin.write(`position fen ${fen}\n`);
      sf.stdin.write(`go depth ${depth}\n`);
    }
  });
}

export async function analyzeGame(
  moveHistory: { from: string; to: string; promotion?: string }[]
): Promise<GameAnalysis> {
  const chess = new Chess();
  const results: MoveAnalysis[] = [];

  let prevEval = 0;
  let prevIsMate = false;

  // Get starting eval
  const startEval = await getStockfishEval(chess.fen(), 16);
  prevEval = startEval.score;
  prevIsMate = startEval.isMate;

  for (let i = 0; i < moveHistory.length; i++) {
    const move = moveHistory[i];
    const color: "white" | "black" = chess.turn() === "w" ? "white" : "black";

    const evalBefore = prevEval;

    // Get best move suggestion BEFORE making the move
    const fenBefore = chess.fen();
    const beforePositionEval = await getStockfishEval(fenBefore, 16);
    const bestMoveForPosition = beforePositionEval.bestMove;

    // Make the move
    let san = "";
    try {
      const result = chess.move(move);
      san = result.san;
    } catch {
      break;
    }

    // Get eval after the move
    const afterEval = await getStockfishEval(chess.fen(), 16);
    const evalAfter = afterEval.score;

    // Compute delta from perspective of the side who moved
    // evalBefore and evalAfter are both from white's perspective
    // If white moved: positive delta means white's advantage shrank (loss for white)
    // If black moved: negative delta means black's advantage shrank (loss for black, i.e. eval rose for white)
    let delta: number;
    if (color === "white") {
      delta = evalBefore - evalAfter;  // white lost eval if positive
    } else {
      delta = evalAfter - evalBefore;  // black lost eval if positive (eval rose for white)
    }
    delta = Math.max(0, delta);

    const playedUCI = `${move.from}${move.to}${move.promotion ?? ""}`;
    const classification = classifyMove(delta, afterEval.isMate, prevIsMate, bestMoveForPosition, playedUCI);
    const comment = generateComment(
      classification, san, delta, evalAfter,
      bestMoveForPosition, playedUCI, color,
      afterEval.isMate, afterEval.mateIn
    );

    results.push({
      moveIndex: i + 1,
      move: playedUCI,
      san,
      color,
      evalBefore,
      evalAfter,
      evalDelta: delta,
      bestMove: bestMoveForPosition,
      classification,
      comment,
      isMate: afterEval.isMate,
      mateIn: afterEval.mateIn,
    });

    prevEval = evalAfter;
    prevIsMate = afterEval.isMate;
  }

  const whiteMoves = results.filter(m => m.color === "white");
  const blackMoves = results.filter(m => m.color === "black");

  const avgAccuracy = (moves: MoveAnalysis[]) => {
    if (moves.length === 0) return 100;
    const sum = moves.reduce((acc, m) => acc + swingToAccuracy(m.evalDelta), 0);
    return Math.round(sum / moves.length);
  };

  return {
    moves: results,
    whiteAccuracy: avgAccuracy(whiteMoves),
    blackAccuracy: avgAccuracy(blackMoves),
    whiteMistakes: whiteMoves.filter(m => m.classification === "mistake").length,
    whiteBlunders: whiteMoves.filter(m => m.classification === "blunder").length,
    blackMistakes: blackMoves.filter(m => m.classification === "mistake").length,
    blackBlunders: blackMoves.filter(m => m.classification === "blunder").length,
    whiteInaccuracies: whiteMoves.filter(m => m.classification === "inaccuracy").length,
    blackInaccuracies: blackMoves.filter(m => m.classification === "inaccuracy").length,
  };
}
