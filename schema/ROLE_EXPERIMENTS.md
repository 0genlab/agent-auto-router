# Role experiment task schema v1

`run-role-experiment.mjs` uses a task file to run the same task against several
models. The command is an argument array; it is not passed through a shell.

```json
{
  "id": "implementation-001",
  "title": "Implement refund retry",
  "role": "implementer",
  "type": "implementation",
  "task_family": "implementation",
  "project": "/workspace/project",
  "expected": "All acceptance tests pass",
  "repo_language": "go",
  "tool_profile": "terminal+tests",
  "context_size_bucket": "32k-64k",
  "prompt": "Implement refund retry and run the tests",
  "command": ["codex", "exec", "--full-auto", "-m", "{model}", "{prompt}"],
  "test_command": ["go", "test", "./..."],
  "regression_command": ["python3", "regression_test.py"],
  "diff_check": true,
  "models": ["deepseek-v4.1-flash", "deepseek-v4-pro"]
}
```

The runner creates one `role-runs` record per model and writes one comparison
report under `data/experiments/`. It does not change role configuration or
promote a model.
