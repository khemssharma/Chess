import { useState, useRef, useEffect, useCallback } from "react";

const API_URL = (import.meta.env.VITE_API_URL as string) || "http://localhost:3000";

// ── Icons ──────────────────────────────────────────────────────────────────
const BotIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <circle cx="12" cy="5" r="2" />
    <line x1="12" y1="7" x2="12" y2="11" />
    <line x1="8" y1="16" x2="8" y2="16" strokeWidth="3" />
    <line x1="12" y1="16" x2="12" y2="16" strokeWidth="3" />
    <line x1="16" y1="16" x2="16" y2="16" strokeWidth="3" />
  </svg>
);

const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const MinimiseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const ChevronIcon = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <polyline points={up ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
  </svg>
);

// ── Types ──────────────────────────────────────────────────────────────────
interface MoveAnalysis {
  moveIndex: number;
  san: string;
  color: "white" | "black";
  classification: string;
  comment: string;
  evalAfter: number;
  bestMove: string;
  evalDelta: number;
  isMate: boolean;
  mateIn?: number;
}

interface GameAnalysis {
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

interface GameInfo {
  whitePlayer: string;
  blackPlayer: string;
  result: string;
  moveCount: number;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  isNarrative?: boolean;
}

interface Props {
  gameId: string;
  token: string;
  analysis: GameAnalysis;
  gameInfo: GameInfo;
  currentMoveAnalysis: MoveAnalysis | null;
}

// ── Typing indicator ───────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div className="flex items-end gap-1 px-4 py-2">
      <div className="flex gap-1 bg-slate-700 rounded-2xl rounded-bl-sm px-4 py-3">
        {[0, 1, 2].map(i => (
          <span key={i} className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

// ── Simple markdown-lite renderer ─────────────────────────────────────────
function SimpleMarkdown({ text }: { text: string }) {
  // Parse bold, headings, bullets — lightweight without a lib
  const lines = text.split("\n");
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        // H2 ##
        if (line.startsWith("## ")) {
          return <p key={i} className="font-bold text-purple-300 text-sm mt-2">{line.slice(3)}</p>;
        }
        // H3 ###
        if (line.startsWith("### ")) {
          return <p key={i} className="font-semibold text-purple-200 text-sm mt-1">{line.slice(4)}</p>;
        }
        // H1 #
        if (line.startsWith("# ")) {
          return <p key={i} className="font-bold text-white text-base mt-2">{line.slice(2)}</p>;
        }
        // Bullet
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <div key={i} className="flex gap-2">
              <span className="text-purple-400 mt-0.5 shrink-0">•</span>
              <span className="text-sm leading-relaxed text-slate-200"
                dangerouslySetInnerHTML={{ __html: renderInline(line.slice(2)) }} />
            </div>
          );
        }
        // Numbered list
        if (/^\d+\.\s/.test(line)) {
          const match = line.match(/^(\d+)\.\s(.*)/);
          if (match) {
            return (
              <div key={i} className="flex gap-2">
                <span className="text-purple-400 font-mono text-xs mt-0.5 shrink-0">{match[1]}.</span>
                <span className="text-sm leading-relaxed text-slate-200"
                  dangerouslySetInnerHTML={{ __html: renderInline(match[2]) }} />
              </div>
            );
          }
        }
        // Empty line
        if (line.trim() === "") return <div key={i} className="h-1" />;
        // Normal paragraph
        return (
          <p key={i} className="text-sm leading-relaxed text-slate-200"
            dangerouslySetInnerHTML={{ __html: renderInline(line) }} />
        );
      })}
    </div>
  );
}

function renderInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong class='text-white'>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em class='text-slate-300'>$1</em>")
    .replace(/`(.+?)`/g, "<code class='bg-slate-800 px-1 rounded text-purple-300 font-mono text-xs'>$1</code>");
}

// ── Message bubble ─────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const [collapsed, setCollapsed] = useState(false);
  const isLong = msg.text.length > 400;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-purple-500 text-white flex items-center justify-center mr-2 mt-1 shrink-0 text-sm">
          ♔
        </div>
      )}
      <div className={`max-w-[88%] rounded-2xl px-4 py-3 ${
        isUser
          ? "bg-purple-600 text-white rounded-br-sm"
          : "bg-slate-700/80 text-slate-100 rounded-bl-sm border border-white/5"
      }`}>
        {isUser ? (
          <p className="text-sm leading-relaxed">{msg.text}</p>
        ) : (
          <>
            <div className={collapsed ? "max-h-20 overflow-hidden relative" : ""}>
              <SimpleMarkdown text={msg.text} />
              {collapsed && (
                <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-slate-700 to-transparent" />
              )}
            </div>
            {isLong && (
              <button
                onClick={() => setCollapsed(v => !v)}
                className="mt-2 flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
              >
                <ChevronIcon up={!collapsed} />
                {collapsed ? "Show more" : "Collapse"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function ChessAIAssistant({
  gameId, token, analysis, gameInfo, currentMoveAnalysis
}: Props) {
  const [open, setOpen] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [narrativeLoading, setNarrativeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrativeGenerated, setNarrativeGenerated] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, narrativeLoading]);

  useEffect(() => {
    if (open && !minimised) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, minimised]);

  // Generate narrative when chat first opens
  useEffect(() => {
    if (!open || narrativeGenerated || narrativeLoading) return;
    generateNarrative();
  }, [open]);

  const generateNarrative = async () => {
    setNarrativeLoading(true);
    setNarrativeGenerated(true);
    setMessages([{
      role: "assistant",
      text: "♟️ Hello! I'm your AI Chess Coach. Let me analyse this game for you...",
    }]);

    try {
      const res = await fetch(`${API_URL}/api/games/${gameId}/ai-analyze`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ analysis, gameInfo }),
      });

      const data = await res.json() as { narrative?: string; message?: string };

      if (data.narrative) {
        setMessages([
          { role: "assistant", text: "♟️ Hello! I'm your AI Chess Coach. Here's my review of this game:", },
          { role: "assistant", text: data.narrative, isNarrative: true },
          { role: "assistant", text: "Feel free to ask me anything about the game — a specific move, strategy, or why something was a blunder!" },
        ]);
      } else {
        setMessages([{
          role: "assistant",
          text: "I'm your AI Chess Coach! I'm ready to answer questions about this game. Ask me about any move, strategy, or what went wrong.",
        }]);
        setError(data.message ?? "Narrative generation failed");
      }
    } catch {
      setMessages([{
        role: "assistant",
        text: "I'm your AI Chess Coach! Ask me anything about this game.",
      }]);
      setError("Failed to generate narrative");
    } finally {
      setNarrativeLoading(false);
    }
  };

  const sendMessage = useCallback(async (text?: string) => {
    const userText = (text ?? input).trim();
    if (!userText || loading) return;
    setInput("");
    setError(null);

    const userMsg: Message = { role: "user", text: userText };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/games/${gameId}/ai-chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: userText,
          gameInfo,
          moveContext: currentMoveAnalysis,
        }),
      });

      const data = await res.json() as { reply?: string; message?: string };

      if (data.reply) {
        setMessages(prev => [...prev, { role: "assistant", text: data.reply! }]);
      } else {
        throw new Error(data.message ?? "No response");
      }
    } catch (err) {
      const msg = (err as Error).message ?? "Failed to get response";
      setMessages(prev => [...prev, { role: "assistant", text: `⚠️ ${msg}` }]);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [input, loading, token, gameId, gameInfo, currentMoveAnalysis]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Suggested questions, context-aware
  const suggestions = currentMoveAnalysis
    ? [
        `Why was ${currentMoveAnalysis.san} a ${currentMoveAnalysis.classification}?`,
        `What should have been played instead of ${currentMoveAnalysis.san}?`,
        `Explain the position after move ${currentMoveAnalysis.moveIndex}`,
      ]
    : [
        "What was the biggest mistake in this game?",
        "Who played better overall and why?",
        "What should both players work on?",
      ];

  const showSuggestions = messages.length <= 3 && !loading && !narrativeLoading;

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-3">
      {/* Chat panel */}
      {open && (
        <div className={`w-[360px] sm:w-[400px] rounded-2xl overflow-hidden shadow-2xl
          border border-white/10 flex flex-col bg-slate-900 transition-all duration-300
          ${minimised ? "h-14" : "h-[540px]"}`}>

          {/* Header */}
          <div className="flex items-center gap-3 bg-slate-800 px-4 py-3 border-b border-white/10 shrink-0">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-sm font-bold">
              ♔
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">AI Chess Coach</p>
              <p className="text-xs text-slate-400 truncate">
                {currentMoveAnalysis
                  ? `📍 Move ${currentMoveAnalysis.moveIndex}: ${currentMoveAnalysis.san}`
                  : `${gameInfo.whitePlayer} vs ${gameInfo.blackPlayer}`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setMinimised(v => !v)}
                className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                title={minimised ? "Expand" : "Minimise"}>
                <MinimiseIcon />
              </button>
              <button onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                title="Close">
                <CloseIcon />
              </button>
            </div>
          </div>

          {/* Body */}
          {!minimised && (
            <>
              <div className="flex-1 overflow-y-auto py-3 space-y-1">
                {messages.map((m, i) => <MessageBubble key={i} msg={m} />)}
                {(loading || narrativeLoading) && <TypingIndicator />}
                <div ref={bottomRef} />
              </div>

              {/* Suggested questions */}
              {showSuggestions && (
                <div className="px-3 pb-2 flex flex-wrap gap-2">
                  {suggestions.map((q, i) => (
                    <button key={i} onClick={() => sendMessage(q)}
                      className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300
                        border border-slate-600 rounded-full px-3 py-1.5 transition-colors text-left">
                      {q}
                    </button>
                  ))}
                </div>
              )}

              {/* Input */}
              <div className="shrink-0 border-t border-white/10 bg-slate-800 px-3 py-3">
                {error && (
                  <p className="text-xs text-red-400 mb-2 px-1">⚠️ {error}</p>
                )}
                <div className="flex items-end gap-2 rounded-xl px-3 py-2 bg-slate-700">
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={input}
                    onChange={e => {
                      setInput(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = Math.min(e.target.scrollHeight, 96) + "px";
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      currentMoveAnalysis
                        ? `Ask about ${currentMoveAnalysis.san}…`
                        : "Ask about any move or strategy…"
                    }
                    className="flex-1 bg-transparent text-sm text-white placeholder-slate-400
                      resize-none outline-none min-h-[24px] max-h-[96px]"
                    disabled={loading || narrativeLoading}
                  />
                  <button
                    onClick={() => sendMessage()}
                    disabled={loading || narrativeLoading || !input.trim()}
                    className="p-2 rounded-lg bg-purple-600 text-white
                      hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed
                      transition-colors shrink-0">
                    <SendIcon />
                  </button>
                </div>
                <p className="mt-1.5 text-center text-[10px] text-slate-500">
                  Powered by OpenRouter · AI Chess Coach
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* FAB button */}
      <button
        onClick={() => { setOpen(v => !v); setMinimised(false); }}
        className={`w-14 h-14 rounded-full shadow-xl flex items-center justify-center
          transition-all duration-300 hover:scale-110 relative
          ${open
            ? "bg-slate-700 text-white"
            : "bg-gradient-to-br from-purple-600 to-pink-600 text-white"
          }`}
        title={open ? "Close AI Coach" : "Open AI Chess Coach"}
      >
        {open ? <CloseIcon /> : <span className="text-2xl select-none">♔</span>}
        {/* Pulse ring when analysis is ready */}
        {!open && (
          <span className="absolute inset-0 rounded-full animate-ping bg-purple-500 opacity-30 pointer-events-none" />
        )}
      </button>
    </div>
  );
}
