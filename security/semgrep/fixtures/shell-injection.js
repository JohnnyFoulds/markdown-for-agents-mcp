/**
 * Fixture for shell-injection-interpolation rule.
 * Run semgrep --test security/semgrep/ to verify.
 */
import { execSync } from 'child_process';

// ruleid: shell-injection-interpolation
execSync(`npx playwright install ${userInput}`);

// ruleid: shell-injection-interpolation
execSync(someVariable);

// ruleid: shell-injection-interpolation
execSync('npx ' + command);

// ok: shell-injection-interpolation
execSync('npx playwright install chromium');

// ok: shell-injection-interpolation
execSync("npx playwright --version", { stdio: "pipe" });
