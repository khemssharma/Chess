import { test, expect } from "@playwright/test";

// Each run needs a fresh account — the backend enforces unique emails.
function uniqueUser() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  return {
    username: `e2e_${stamp}`,
    email: `e2e_${stamp}@example.com`,
    password: "correct-horse-battery-staple",
  };
}

test.describe("authentication", () => {
  test("a new user can register, land on /game signed in, sign out, and sign back in", async ({ page }) => {
    const user = uniqueUser();

    await page.goto("/register");
    await page.getByPlaceholder("chesschampion").fill(user.username);
    await page.getByPlaceholder("you@example.com").fill(user.email);
    await page.getByPlaceholder("••••••••").fill(user.password);
    await page.getByRole("button", { name: /Create Account/i }).click();

    // Registration logs the user in and redirects to /game.
    await expect(page).toHaveURL(/\/game/, { timeout: 15_000 });
    await expect(page.getByText(user.username)).toBeVisible({ timeout: 15_000 });

    // Sign out returns to a logged-out state. The Game screen's "Sign out"
    // button navigates back to "/" (the landing page), not to a logged-out
    // /game view, so assert against what the landing page actually shows.
    await page.getByRole("button", { name: /Sign out/i }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Sign In$/ })).toBeVisible();

    // Sign back in with the same credentials.
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(user.email);
    await page.getByPlaceholder("••••••••").fill(user.password);
    await page.getByRole("button", { name: /^Sign In$/ }).click();

    await expect(page).toHaveURL(/\/game/, { timeout: 15_000 });
    await expect(page.getByText(user.username)).toBeVisible({ timeout: 15_000 });
  });

  test("login with a wrong password is rejected with an error message", async ({ page }) => {
    const user = uniqueUser();

    // Register once so the account exists, then sign out.
    await page.goto("/register");
    await page.getByPlaceholder("chesschampion").fill(user.username);
    await page.getByPlaceholder("you@example.com").fill(user.email);
    await page.getByPlaceholder("••••••••").fill(user.password);
    await page.getByRole("button", { name: /Create Account/i }).click();
    await expect(page).toHaveURL(/\/game/, { timeout: 15_000 });
    await page.getByRole("button", { name: /Sign out/i }).click();

    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(user.email);
    await page.getByPlaceholder("••••••••").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: /^Sign In$/ }).click();

    await expect(page.getByText(/invalid|failed|incorrect/i)).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
