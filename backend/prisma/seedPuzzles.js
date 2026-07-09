/**
 * Seed the Puzzle table.
 *
 * Usage:
 *   npm run db:seed:puzzles                      → seeds the 30 built-in verified puzzles
 *   node prisma/seedPuzzles.js lichess.csv 500   → imports up to 500 puzzles from the
 *                                                  lichess open puzzle database (CC0):
 *                                                  https://database.lichess.org/#puzzles
 *
 * Every puzzle is re-validated with chess.js before insert:
 * the solution must be a legal move sequence ending in checkmate
 * (built-in set) or simply legal (lichess set — not all are mates).
 */
const { PrismaClient } = require("@prisma/client");
const { Chess } = require("chess.js");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

function replayIsLegal(fen, moves, requireMate) {
  try {
    const chess = new Chess(fen);
    for (const mv of moves) {
      const m = chess.move({
        from: mv.slice(0, 2),
        to: mv.slice(2, 4),
        promotion: mv.length > 4 ? mv.slice(4) : undefined,
      });
      if (!m) return false;
    }
    return requireMate ? chess.isCheckmate() : true;
  } catch {
    return false;
  }
}

async function seedBuiltIn() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "puzzles.json"), "utf8"));
  let inserted = 0, skipped = 0;

  for (const p of data) {
    if (!replayIsLegal(p.fen, p.solution, true)) {
      console.warn(`SKIP invalid puzzle: ${p.fen}`);
      skipped++;
      continue;
    }
    const exists = await prisma.puzzle.findFirst({ where: { fen: p.fen } });
    if (exists) { skipped++; continue; }

    await prisma.puzzle.create({
      data: { fen: p.fen, solution: p.solution, themes: p.themes, rating: p.rating },
    });
    inserted++;
  }
  console.log(`Built-in seed done — inserted: ${inserted}, skipped: ${skipped}`);
}

/**
 * Lichess CSV columns:
 * PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
 * NOTE: lichess FEN is the position BEFORE the opponent's setup move — Moves[0]
 * is the opponent's move. We play it forward so our stored FEN has the solver to move.
 */
async function seedFromLichessCsv(csvPath, limit) {
  const lines = fs.readFileSync(csvPath, "utf8").split("\n").slice(1);
  let inserted = 0, skipped = 0;

  for (const line of lines) {
    if (inserted >= limit) break;
    const cols = line.split(",");
    if (cols.length < 8) continue;
    const [, fen, movesStr, rating, rd, , , themes] = cols;
    const moves = movesStr.trim().split(" ");

    try {
      const chess = new Chess(fen);
      const setup = moves[0];
      chess.move({ from: setup.slice(0, 2), to: setup.slice(2, 4), promotion: setup.slice(4) || undefined });
      const solverFen = chess.fen();
      const solution = moves.slice(1);

      if (!replayIsLegal(solverFen, solution, false)) { skipped++; continue; }

      await prisma.puzzle.create({
        data: {
          fen: solverFen,
          solution,
          themes: themes.trim().split(" ").join(","),
          rating: parseFloat(rating) || 1500,
          ratingDeviation: parseFloat(rd) || 150,
        },
      });
      inserted++;
    } catch {
      skipped++;
    }
  }
  console.log(`Lichess import done — inserted: ${inserted}, skipped: ${skipped}`);
}

async function main() {
  const [, , csvPath, limitArg] = process.argv;
  if (csvPath) {
    await seedFromLichessCsv(csvPath, parseInt(limitArg) || 100);
  } else {
    await seedBuiltIn();
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
