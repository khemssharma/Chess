import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const API_URL = (import.meta.env.VITE_API_URL as string) || "http://localhost:3000";

interface GameRecord {
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

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const resultLabel = (game: GameRecord, userId: number) => {
  if (!game.winner) return { text: "Draw", color: "text-yellow-400" };
  const myColor = game.whiteUser?.id === userId ? "white" : "black";
  return game.winner === myColor
    ? { text: "Win", color: "text-green-400" }
    : { text: "Loss", color: "text-red-400" };
};

const difficultyBadgeColor: Record<string, string> = {
  easy: "bg-green-500/20 text-green-400 border-green-500/30",
  medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  hard: "bg-red-500/20 text-red-400 border-red-500/30",
  expert: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

export const History = () => {
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<GameRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    fetch(`${API_URL}/api/games`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => setGames(data.games ?? []))
      .catch(() => setError("Failed to load game history"))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white">
      {/* Nav */}
      <header className="border-b border-white/10 px-4 py-4">
        <div className="max-w-4xl mx-auto flex justify-between items-center">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-3xl">♔</span>
            <span className="text-xl font-bold">ChessMaster</span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-gray-400 text-sm">
              Signed in as <span className="text-white font-medium">{user?.username}</span>
            </span>
            <button
              onClick={() => navigate("/game")}
              className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
            >
              Play
            </button>
            <button
              onClick={() => { logout(); navigate("/"); }}
              className="text-gray-400 hover:text-white text-sm transition"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-3xl font-bold mb-2">Game History</h1>
        <p className="text-gray-400 mb-8">
          Your last {games.length} recorded game{games.length !== 1 ? "s" : ""} · click any row to replay
        </p>

        {loading && (
          <div className="text-center py-20 text-gray-400 animate-pulse">Loading games...</div>
        )}

        {error && (
          <div className="bg-red-500/20 border border-red-500/40 text-red-300 rounded-lg px-4 py-3">{error}</div>
        )}

        {!loading && !error && games.length === 0 && (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">♟️</div>
            <p className="text-gray-400 text-lg mb-6">No games yet. Play your first game!</p>
            <button
              onClick={() => navigate("/game")}
              className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-bold px-8 py-3 rounded-full transition-all transform hover:scale-105"
            >
              Play Now
            </button>
          </div>
        )}

        {!loading && games.length > 0 && (
          <div className="space-y-3">
            {/* Stats summary */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              {(() => {
                const wins = games.filter(g => {
                  if (!g.winner || !user) return false;
                  const myColor = g.whiteUser?.id === user.id ? "white" : "black";
                  return g.winner === myColor;
                }).length;
                const losses = games.filter(g => {
                  if (!g.winner || !user) return false;
                  const myColor = g.whiteUser?.id === user.id ? "white" : "black";
                  return g.winner !== myColor;
                }).length;
                const draws = games.filter(g => g.winner === null).length;
                return (
                  <>
                    <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
                      <div className="text-3xl font-bold text-green-400">{wins}</div>
                      <div className="text-gray-400 text-sm mt-1">Wins</div>
                    </div>
                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
                      <div className="text-3xl font-bold text-red-400">{losses}</div>
                      <div className="text-gray-400 text-sm mt-1">Losses</div>
                    </div>
                    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 text-center">
                      <div className="text-3xl font-bold text-yellow-400">{draws}</div>
                      <div className="text-gray-400 text-sm mt-1">Draws</div>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Game list */}
            {games.map(game => {
              const result = user ? resultLabel(game, user.id) : { text: "—", color: "text-gray-400" };
              const myColor = game.whiteUser?.id === user?.id ? "white" : "black";
              const opponentName = game.isVsComputer
                ? `🤖 Stockfish`
                : (myColor === "white" ? game.blackUser?.username : game.whiteUser?.username) ?? "Guest";

              return (
                <div
                  key={game.id}
                  onClick={() => navigate(`/history/${game.id}`)}
                  className="bg-white/5 border border-white/10 hover:bg-white/10 hover:border-purple-500/40 rounded-xl px-5 py-4 flex items-center justify-between transition cursor-pointer group"
                >
                  <div className="flex items-center gap-4">
                    <div className="text-2xl">{myColor === "white" ? "⚪" : "⚫"}</div>

                    <div>
                      <div className="font-medium flex items-center gap-2 flex-wrap">
                        vs <span className="text-purple-300">{opponentName}</span>
                        {game.isVsComputer && game.computerDifficulty && (
                          <span className={`text-xs px-2 py-0.5 rounded-full border capitalize ${difficultyBadgeColor[game.computerDifficulty] ?? "bg-slate-600 text-gray-300 border-slate-500"}`}>
                            {game.computerDifficulty}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-400 mt-0.5">
                        {game.timeControl ? `${game.timeControl} min` : "Unlimited"} ·{" "}
                        {game.moveCount} moves ·{" "}
                        {game.reason ?? "—"}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className={`text-lg font-bold ${result.color}`}>{result.text}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {game.finishedAt ? formatDate(game.finishedAt) : formatDate(game.startedAt)}
                      </div>
                    </div>
                    <div className="text-gray-600 group-hover:text-purple-400 transition text-lg">›</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};
