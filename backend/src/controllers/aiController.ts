import { Response } from "express";
import { AuthenticatedRequest } from "../utils/types";
import { gameHistoryService } from "../services/gameHistoryService";

// In-memory cache for AI analysis (keyed by gameId)
const aiAnalysisCache = new Map<string, string>();

// In-memory conversation history per user+game session
const chatSessions = new Map<string, { role: string; content: string }[]>();

function getOpenRouterHeaders() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": process.env.CLIENT_URL || "https://chess.example.com",
    "X-Title": "ChessMaster",
  };
}

const FREE_MODELS = [
  "openrouter/free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
];

async function callOpenRouter(
  messages: { role: string; content: string }[],
  maxTokens = 1024
): Promise<string> {
  let lastError: Error | null = null;

  for (const model of FREE_MODELS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: getOpenRouterHeaders(),
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 404 || errText.includes("No endpoints found")) {
          lastError = new Error(errText);
          continue; // try next model
        }
        throw new Error(`OpenRouter ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/404|No endpoints found|no available/i.test(msg)) {
        lastError = err as Error;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("All AI models unavailable");
}

// ─── POST /api/games/:gameId/ai-analyze ──────────────────────────────────────
// Takes the Stockfish analysis and generates rich AI narrative for the whole game
class AIController {
  static generateAnalysis = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });

      const { gameId } = req.params;
      const { analysis, gameInfo } = req.body as {
        analysis: {
          moves: {
            moveIndex: number;
            san: string;
            color: "white" | "black";
            classification: string;
            evalBefore: number;
            evalAfter: number;
            evalDelta: number;
            bestMove: string;
            comment: string;
            isMate: boolean;
            mateIn?: number;
          }[];
          whiteAccuracy: number;
          blackAccuracy: number;
          whiteMistakes: number;
          whiteBlunders: number;
          blackMistakes: number;
          blackBlunders: number;
          whiteInaccuracies: number;
          blackInaccuracies: number;
        };
        gameInfo: {
          whitePlayer: string;
          blackPlayer: string;
          result: string;
          moveCount: number;
        };
      };

      if (!analysis) return res.status(400).json({ message: "No analysis provided" });

      // Return cached narrative if available
      const cacheKey = `narrative:${gameId}`;
      if (aiAnalysisCache.has(cacheKey)) {
        return res.json({ narrative: aiAnalysisCache.get(cacheKey), cached: true });
      }

      // Build a compact summary of critical moves
      const criticalMoves = analysis.moves
        .filter((m) =>
          ["blunder", "mistake", "brilliant", "great"].includes(m.classification)
        )
        .slice(0, 12); // cap at 12 to keep prompt small

      const moveSummary = criticalMoves
        .map(
          (m) =>
            `Move ${m.moveIndex} (${m.color}, ${m.san}): ${m.classification} — eval swing ${(m.evalDelta / 100).toFixed(1)} pawns. Best was ${m.bestMove || "this move"}.`
        )
        .join("\n");

      const systemPrompt = `You are an expert chess coach providing concise, insightful game analysis. 
Your tone is educational, encouraging, and precise. 
Use chess terminology correctly but explain it briefly when needed.
Format your response using markdown with clear sections.`;

      const userPrompt = `Analyse this chess game and provide an AI coach review:

**Players**: ${gameInfo.whitePlayer} (White) vs ${gameInfo.blackPlayer} (Black)
**Result**: ${gameInfo.result}
**Total moves**: ${gameInfo.moveCount}
**White accuracy**: ${analysis.whiteAccuracy}% | Mistakes: ${analysis.whiteMistakes} | Blunders: ${analysis.whiteBlunders}
**Black accuracy**: ${analysis.blackAccuracy}% | Mistakes: ${analysis.blackMistakes} | Blunders: ${analysis.blackBlunders}

**Critical moments** (blunders, mistakes, brilliant moves):
${moveSummary || "No critical moves — a very accurate game!"}

Write a structured coach review with these sections:
1. **Game Overview** — 2-3 sentences on the overall flow and result
2. **White's Performance** — key strengths and the worst mistake/blunder if any, with explanation of WHY it was bad
3. **Black's Performance** — same treatment
4. **Turning Point** — identify the single most important moment that changed the game
5. **Lessons to Learn** — 2-3 actionable takeaways for both players

Keep it under 400 words total. Be specific about the moves, not generic.`;

      const narrative = await callOpenRouter([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      aiAnalysisCache.set(cacheKey, narrative);

      // Seed the chat session with this context so follow-ups are aware
      const sessionKey = `${req.user.userId}:${gameId}`;
      chatSessions.set(sessionKey, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: narrative },
      ]);

      res.json({ narrative });
    } catch (error) {
      console.error("AI analysis error:", error);
      res.status(500).json({ message: "AI analysis failed", error: String(error) });
    }
  };

  // ─── POST /api/games/:gameId/ai-chat ─────────────────────────────────────
  // Follow-up Q&A about the game analysis
  static chat = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });

      const { gameId } = req.params;
      const { message, analysis, gameInfo, moveContext } = req.body as {
        message: string;
        analysis?: object;
        gameInfo?: {
          whitePlayer: string;
          blackPlayer: string;
          result: string;
          moveCount: number;
        };
        moveContext?: {
          moveIndex: number;
          san: string;
          color: string;
          classification: string;
          comment: string;
          evalAfter: number;
          bestMove: string;
        } | null;
      };

      if (!message?.trim()) return res.status(400).json({ message: "No message provided" });

      const sessionKey = `${req.user.userId}:${gameId}`;

      // If no session yet, seed it with basic game context
      if (!chatSessions.has(sessionKey)) {
        const systemPrompt = `You are an expert chess coach analysing a game between ${gameInfo?.whitePlayer ?? "White"} and ${gameInfo?.blackPlayer ?? "Black"} (${gameInfo?.result ?? "game finished"}, ${gameInfo?.moveCount ?? "?"} moves). Answer questions about the game, specific moves, strategy, and chess concepts. Be concise and educational.`;

        chatSessions.set(sessionKey, [
          { role: "system", content: systemPrompt },
        ]);
      }

      const session = chatSessions.get(sessionKey)!;

      // Append move context to user message if provided
      let fullUserMessage = message;
      if (moveContext) {
        fullUserMessage = `[Currently viewing Move ${moveContext.moveIndex}: ${moveContext.san} (${moveContext.color}, classified as ${moveContext.classification}. Eval after: ${(moveContext.evalAfter / 100).toFixed(1)}. Best move was ${moveContext.bestMove || "this"}.]

User question: ${message}`;
      }

      session.push({ role: "user", content: fullUserMessage });

      // Keep session manageable: system + last 10 exchanges max
      const trimmed =
        session.length > 22
          ? [session[0], ...session.slice(-20)]
          : session;

      const reply = await callOpenRouter(trimmed);

      session.push({ role: "assistant", content: reply });

      res.json({ reply });
    } catch (error) {
      console.error("AI chat error:", error);
      res.status(500).json({ message: "AI chat failed", error: String(error) });
    }
  };

  // Clear session when user is done
  static clearSession = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { gameId } = req.params;
    const sessionKey = `${req.user.userId}:${gameId}`;
    chatSessions.delete(sessionKey);
    res.json({ success: true });
  };
}

export default AIController;
