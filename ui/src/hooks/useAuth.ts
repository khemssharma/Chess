import { useContext } from "react";
import { AuthContext } from "../context/AuthContext";

let mockUseAuth: (() => any) | null = null;
export function setMockUseAuth(mock: (() => any) | null) {
  mockUseAuth = mock;
}

export const useAuth = () => {
  if (mockUseAuth) return mockUseAuth();
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
};
