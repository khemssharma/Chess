import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../api/apiClient";

interface Entry {
  rank: number;
  id: number;
  username: string;
  avatar: string | null;
  rating: number;
  ratingDeviation: number;
  provisional: boolean;
  played: number;
}

const medal = (rank: number) =>
  rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

export const Leaderboard = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState<"game" | "puzzle">("game");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/leaderboard?type=${tab}`)
      .then((r) => r.json())
      .then((d) => setEntries(d.leaderboard || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [tab]);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <h1 className="text-xl font-bold">Leaderboard</h1>
        <div className="flex gap-4 text-sm text-slate-300">
          <Link to="/game" className="hover:text-white">Play</Link>
          <Link to="/puzzles" className="hover:text-white">Puzzles</Link>
          <Link to="/history" className="hover:text-white">History</Link>
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-4 md:p-8">
        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          {(["game", "puzzle"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg font-semibold text-sm transition
                ${tab === t ? "bg-blue-600 text-white" : "bg-slate-900 text-slate-400 hover:text-white"}`}
            >
              {t === "game" ? "♟ Game Rating" : "🧩 Puzzle Rating"}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center text-slate-400 py-12">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-center text-slate-400 py-12">
            No rated {tab === "game" ? "games" : "puzzle attempts"} yet. Be the first!
          </div>
        ) : (
          <div className="bg-slate-900 rounded-lg border border-slate-800 divide-y divide-slate-800">
            {entries.map((e) => (
              <div
                key={e.id}
                className={`flex items-center gap-4 px-4 py-3 ${user?.id === e.id ? "bg-blue-900/30" : ""}`}
              >
                <div className="w-10 text-center font-bold text-slate-300">{medal(e.rank)}</div>
                {e.avatar ? (
                  <img src={e.avatar} alt="" className="w-8 h-8 rounded-full" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-sm font-bold">
                    {e.username[0]?.toUpperCase()}
                  </div>
                )}
                <div className="flex-1">
                  <div className="font-semibold">
                    {e.username}
                    {user?.id === e.id && <span className="text-blue-400 text-xs ml-2">(you)</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {e.played} {tab === "game" ? "games" : "puzzles"} · RD {e.ratingDeviation}
                  </div>
                </div>
                <div className="text-xl font-bold">
                  {e.rating}
                  {e.provisional && <span className="text-slate-500 text-sm">?</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-slate-600 mt-4 text-center">
          Ratings use the Glicko-2 system — the same algorithm as lichess.org.
          A "?" means the rating is still provisional (high deviation).
        </p>
      </div>
    </div>
  );
};
