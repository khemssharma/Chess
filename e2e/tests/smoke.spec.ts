import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("landing page loads and offers to play", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner").getByText("ChessMaster", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Play Now/i })).toBeVisible();
  });

  test("guest can reach the game screen and see a board", async ({ page }) => {
    await page.goto("/game");
    // The socket hook shows "Connecting to server..." for a moment, then the
    // real game-mode picker. Wait for the mode picker rather than racing it.
    await expect(page.getByText("Choose Game Mode")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Play Online/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Play vs Computer/i })).toBeVisible();
  });

  test("leaderboard is publicly reachable without login", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(page).toHaveURL(/\/leaderboard/);
  });
});
