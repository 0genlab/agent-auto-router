import { assertAdapter } from "../../src/core/contracts.mjs";
import { calculateQualityScore } from "../../src/core/quality-score.mjs";

function parseCount(output, patterns) {
  for (const pattern of patterns) {
    const match = String(output || "").match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function resultFor(result) {
  return {
    exit_code: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    signal: result?.signal || null
  };
}

export function createObjectiveEvaluator({ runCommand }) {
  if (typeof runCommand !== "function") throw new Error("runCommand is required");
  return assertAdapter("evaluator", {
    name: "objective-command",
    async evaluate({ cwd, test, regression = null, diff = true, run = {} } = {}) {
      if (!test?.command) throw new Error("test command is required");
      const testResult = await runCommand({ ...test, cwd });
      const regressionResult = regression?.command
        ? await runCommand({ ...regression, cwd })
        : null;
      const diffCheck = diff
        ? await runCommand({ command: "git", args: ["diff", "--check"], cwd })
        : null;
      const diffStat = diff
        ? await runCommand({ command: "git", args: ["diff", "--stat"], cwd })
        : null;
      const testPassed = testResult.exitCode === 0;
      const regressionPassed = !regressionResult || regressionResult.exitCode === 0;
      const diffClean = !diffCheck || diffCheck.exitCode === 0;
      const failureMode = !testPassed
        ? "test_failed"
        : !regressionPassed
          ? "regression_failed"
          : !diffClean ? "diff_check_failed" : null;
      const quality = calculateQualityScore({
        run,
        evaluation: {
          tests_run: parseCount(testResult.stdout, [/\b(\d+)\s+tests?\b/i, /(\d+)\s+test cases?\b/i, /^#\s+tests\s+(\d+)$/im]),
          tests_passed: parseCount(testResult.stdout, [/\b(\d+)\s+(?:tests? )?(?:passed|passing|pass)\b/i, /^#\s+pass\s+(\d+)$/im]),
          test: resultFor(testResult),
          regression_failed: regressionResult ? regressionResult.exitCode !== 0 : null,
          diff_clean: diffCheck ? diffClean : null
        }
      });
      return {
        event: "evaluation_finished",
        evaluator: "objective-command",
        evaluation_status: testPassed && regressionPassed && diffClean ? "success" : "failed",
        tests_run: quality.quality_components.tests === null ? null : parseCount(testResult.stdout, [/\b(\d+)\s+tests?\b/i, /(\d+)\s+test cases?\b/i, /^#\s+tests\s+(\d+)$/im]),
        tests_passed: quality.quality_components.tests === null ? null : parseCount(testResult.stdout, [/\b(\d+)\s+(?:tests? )?(?:passed|passing|pass)\b/i, /^#\s+pass\s+(\d+)$/im]),
        test: resultFor(testResult),
        regression: regressionResult ? resultFor(regressionResult) : null,
        regression_failed: regressionResult ? regressionResult.exitCode !== 0 : null,
        diff_clean: diffCheck ? diffClean : null,
        diff_stat: String(diffStat?.stdout || "").trim() || null,
        quality_score: quality.quality_score,
        quality_confidence: quality.quality_confidence,
        quality_components: quality.quality_components,
        failure_mode: failureMode,
        evidence: [
          "objective:test",
          regressionResult ? "objective:regression" : null,
          diff ? "objective:git-diff-check" : null
        ].filter(Boolean)
      };
    }
  });
}
