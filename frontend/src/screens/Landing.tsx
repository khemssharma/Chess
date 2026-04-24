import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export const Landing = () => {
    const navigate = useNavigate();
    const { user, logout } = useAuth();

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 text-white overflow-hidden">
            {/* Animated background circles */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-20 left-10 w-72 h-72 bg-purple-500 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-pulse"></div>
                <div className="absolute top-40 right-10 w-96 h-96 bg-blue-500 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-pulse animation-delay-2000"></div>
                <div className="absolute -bottom-32 left-20 w-96 h-96 bg-pink-500 rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-pulse animation-delay-4000"></div>
            </div>

            {/* Header */}
            <header className="relative z-10 container mx-auto px-4 py-6">
                <nav className="flex justify-between items-center">
                    <div className="flex items-center space-x-2">
                        <div className="text-4xl">♔</div>
                        <span className="text-2xl font-bold">ChessMaster</span>
                    </div>

                    {user ? (
                        <div className="flex items-center gap-4">
                            <button
                                onClick={() => navigate("/history")}
                                className="text-gray-300 hover:text-white text-sm transition"
                            >
                                My Games
                            </button>
                            <span className="text-gray-400 text-sm">
                                Hi, <span className="text-white font-semibold">{user.username}</span>
                            </span>
                            <button
                                onClick={() => logout()}
                                className="bg-white/10 border border-white/20 text-white px-4 py-2 rounded-full text-sm font-medium hover:bg-white/20 transition"
                            >
                                Sign Out
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => navigate("/login")}
                                className="text-gray-300 hover:text-white text-sm font-medium transition"
                            >
                                Sign In
                            </button>
                            <button
                                onClick={() => navigate("/register")}
                                className="bg-white text-purple-900 px-6 py-2 rounded-full font-semibold hover:bg-purple-100 transition-all transform hover:scale-105"
                            >
                                Get Started
                            </button>
                        </div>
                    )}
                </nav>
            </header>

            {/* Hero Section */}
            <main className="relative z-10 container mx-auto px-4 pt-20 pb-32">
                <div className="max-w-4xl mx-auto text-center">
                    {/* Badge */}
                    <div className="inline-flex items-center space-x-2 bg-purple-500/20 backdrop-blur-sm border border-purple-500/30 rounded-full px-4 py-2 mb-8">
                        <span className="text-yellow-400">⭐</span>
                        <span className="text-sm font-medium">#2 Chess Platform Worldwide</span>
                    </div>

                    {/* Main Heading */}
                    <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
                        Play Chess Online
                        <br />
                        <span className="bg-gradient-to-r from-purple-400 to-pink-400 text-transparent bg-clip-text">
                            Master Every Move
                        </span>
                    </h1>

                    {/* Description */}
                    <p className="text-xl md:text-2xl text-gray-300 mb-12 max-w-2xl mx-auto">
                        Challenge players worldwide in real-time matches. Improve your skills, climb the ranks, and become a chess legend.
                    </p>

                    {/* CTA Buttons */}
                    <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
                        <button
                            onClick={() => navigate("/game")}
                            className="group relative bg-gradient-to-r from-purple-600 to-pink-600 text-white px-8 py-4 rounded-full font-bold text-lg hover:from-purple-700 hover:to-pink-700 transition-all transform hover:scale-105 shadow-2xl w-full sm:w-auto"
                        >
                            <span className="relative z-10">
                                {user ? "Play Now" : "Play Now - Free"}
                            </span>
                            <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-20 rounded-full transition-opacity"></div>
                        </button>

                        {user ? (
                            <button
                                onClick={() => navigate("/history")}
                                className="bg-white/10 backdrop-blur-sm border border-white/20 text-white px-8 py-4 rounded-full font-bold text-lg hover:bg-white/20 transition-all w-full sm:w-auto"
                            >
                                View My Games
                            </button>
                        ) : (
                            <button
                                onClick={() => navigate("/register")}
                                className="bg-white/10 backdrop-blur-sm border border-white/20 text-white px-8 py-4 rounded-full font-bold text-lg hover:bg-white/20 transition-all w-full sm:w-auto"
                            >
                                Create Account
                            </button>
                        )}
                    </div>

                    {!user && (
                        <p className="text-gray-500 text-sm mt-4">
                            No account?{" "}
                            <button onClick={() => navigate("/game")} className="underline hover:text-gray-300 transition">
                                Play as guest
                            </button>{" "}
                            — games won't be saved to a profile.
                        </p>
                    )}

                    {/* Stats */}
                    <div className="grid grid-cols-3 gap-8 mt-20 max-w-3xl mx-auto">
                        <div className="text-center">
                            <div className="text-4xl md:text-5xl font-bold text-purple-400 mb-2">10M+</div>
                            <div className="text-gray-400 text-sm md:text-base">Active Players</div>
                        </div>
                        <div className="text-center">
                            <div className="text-4xl md:text-5xl font-bold text-pink-400 mb-2">50M+</div>
                            <div className="text-gray-400 text-sm md:text-base">Games Played</div>
                        </div>
                        <div className="text-center">
                            <div className="text-4xl md:text-5xl font-bold text-blue-400 mb-2">24/7</div>
                            <div className="text-gray-400 text-sm md:text-base">Live Matches</div>
                        </div>
                    </div>
                </div>
            </main>

            {/* Features Section */}
            <section className="relative z-10 container mx-auto px-4 py-20">
                <div className="max-w-6xl mx-auto">
                    <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">
                        Why Choose ChessMaster?
                    </h2>

                    <div className="grid md:grid-cols-3 gap-8">
                        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 hover:bg-white/10 transition-all">
                            <div className="text-5xl mb-4">⚡</div>
                            <h3 className="text-xl font-bold mb-3">Lightning Fast</h3>
                            <p className="text-gray-400">Real-time gameplay with zero lag. Experience smooth moves and instant responses.</p>
                        </div>
                        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 hover:bg-white/10 transition-all">
                            <div className="text-5xl mb-4">🤖</div>
                            <h3 className="text-xl font-bold mb-3">Play vs Computer</h3>
                            <p className="text-gray-400">Challenge Stockfish at four difficulty levels — from beginner-friendly to grandmaster strength.</p>
                        </div>
                        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 hover:bg-white/10 transition-all">
                            <div className="text-5xl mb-4">📊</div>
                            <h3 className="text-xl font-bold mb-3">Game History</h3>
                            <p className="text-gray-400">Every game saved to your profile. Review your wins, losses, and full move history.</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Footer */}
            <footer className="relative z-10 container mx-auto px-4 py-12 mt-20 border-t border-white/10">
                <div className="text-center text-gray-400">
                    <p>&copy; 2025 ChessMaster. All rights reserved.</p>
                </div>
            </footer>
        </div>
    );
};
