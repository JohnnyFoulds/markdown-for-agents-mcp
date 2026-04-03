#!/usr/bin/env node
/**
 * Postinstall script for Playwright
 * Automatically installs browsers if not present
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

console.log("Installing Playwright browsers...");

try {
  // Check if playwright is installed
  execSync("npx playwright --version", { stdio: "pipe" });
  console.log("Playwright found, checking browsers...");

  // Check if browsers are installed
  try {
    execSync("npx playwright install --help", { stdio: "pipe" });

    // Install browsers (chromium for now, can add firefox/webkit later)
    console.log("Installing Playwright browsers...");
    execSync("npx playwright install chromium", {
      stdio: "inherit",
    });

    console.log("Playwright browsers installed successfully!");
  } catch (error) {
    console.warn("Warning: Could not install Playwright browsers automatically.");
    console.warn("Please run: npx playwright install chromium");
  }
} catch (error) {
  console.warn("Warning: Playwright not found. Installing...");
  try {
    execSync("npm install", { stdio: "inherit" });
    console.log("Playwright installed. Running postinstall...");
    execSync("node scripts/install-playwright.js", {
      stdio: "inherit",
    });
  } catch (installError) {
    console.error("Failed to install Playwright. Please install manually:");
    console.error("  npm install");
    console.error("  npx playwright install chromium");
  }
}
