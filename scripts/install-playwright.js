#!/usr/bin/env node
/**
 * Postinstall script for Playwright
 * Automatically installs browsers if not present
 */

import { execSync } from "child_process";

console.log("Installing Playwright browsers...");

try {
  // Check if playwright CLI is available
  execSync("npx playwright --version", { stdio: "pipe" });
  console.log("Playwright found, installing browsers...");

  execSync("npx playwright install chromium", { stdio: "inherit" });
  console.log("Playwright browsers installed successfully!");
} catch (error) {
  console.warn("Warning: Could not install Playwright browsers automatically.");
  console.warn("Please run: npx playwright install chromium");
}
