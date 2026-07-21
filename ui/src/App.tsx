import './App.css'
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from './context/AuthContext';
import { Landing } from './screens/Landing';
import { Game } from './screens/Game';
import { Login } from './screens/Login';
import { Register } from './screens/Register';
import { History } from './screens/History';
import { GameReplay } from './screens/GameReplay';
import { Puzzles } from './screens/Puzzles';
import { Leaderboard } from './screens/Leaderboard';

import { ProtectedRoute } from './routes/ProtectedRoute';

// Redirect authenticated users away from login/register
const GuestOnly = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  return user ? <Navigate to="/game" replace /> : <>{children}</>;
};

function AppRoutes() {
  return (
    <div className='h-screen bg-slate-950'>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/game" element={<Game />} />
          <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
          <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
          <Route path="/history/:gameId" element={<ProtectedRoute><GameReplay /></ProtectedRoute>} />
          <Route path="/puzzles" element={<ProtectedRoute><Puzzles /></ProtectedRoute>} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="*" element={<Navigate to="/game" replace />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;
