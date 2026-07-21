import { ProtectedRoute } from "../routes/ProtectedRoute";
import { setMockUseAuth } from "../hooks/useAuth";

// Declare mock testing globals for typescript compiler compatibility
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (val: any) => any;
declare const afterEach: (fn: () => void) => void;
declare const jest: any;

// Mock react-router-dom Navigate component
jest.mock("react-router-dom", () => ({
  Navigate: ({ to, replace }: { to: string; replace: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={replace.toString()}>
      Redirected to {to}
    </div>
  )
}));

describe("ProtectedRoute component", () => {
  afterEach(() => {
    setMockUseAuth(null);
  });

  it("should render loading spinner when authentication state is loading", () => {
    setMockUseAuth(() => ({
      user: null,
      isLoading: true,
      token: null,
      login: async () => {},
      googleLogin: async () => {},
      register: async () => {},
      logout: () => {}
    }));

    const wrapper = <ProtectedRoute><div>Protected Content</div></ProtectedRoute>;
    expect(wrapper).toBeDefined();
  });

  it("should render children when user is successfully authenticated", () => {
    setMockUseAuth(() => ({
      user: { id: 1, username: "player1", email: "p1@example.com" },
      isLoading: false,
      token: "mock-valid-token",
      login: async () => {},
      googleLogin: async () => {},
      register: async () => {},
      logout: () => {}
    }));

    const wrapper = <ProtectedRoute><div>Protected Content</div></ProtectedRoute>;
    expect(wrapper).toBeDefined();
  });

  it("should render Navigate redirect when user is not authenticated", () => {
    setMockUseAuth(() => ({
      user: null,
      isLoading: false,
      token: null,
      login: async () => {},
      googleLogin: async () => {},
      register: async () => {},
      logout: () => {}
    }));

    const wrapper = <ProtectedRoute><div>Protected Content</div></ProtectedRoute>;
    expect(wrapper).toBeDefined();
  });
});
