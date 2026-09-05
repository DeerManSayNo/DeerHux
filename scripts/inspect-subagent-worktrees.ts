import { inspectManagedWorktrees, parseInspectionArguments } from "../lib/parallel-agent/worktree-inspection.ts";

const help = `Usage: node --experimental-strip-types scripts/inspect-subagent-worktrees.ts [--runs-root PATH] [--json] [--git]
Read-only inventory; default root is the managed temporary deerhux-runs directory.
Without --git, counts are validated manifest declarations, not current disk facts.
--git performs slower bounded metadata checks: at most 32 runs / 128 workers;
each Git command has a 10-second timeout. No patches, filters, recovery, or deletion.
All plans retain resources. Unverified content never means clean.
Orphan counts manifests with no observed Worktree, registration, or branch;
uncapturedDirty counts only observed untracked files without a capture, not all edits.
Missing/unknown/truncated observations are not a real-time or complete disk inventory.`;
try {
  const options = parseInspectionArguments(process.argv.slice(2));
  if (options.help) console.log(help);
  else {
    const report = await inspectManagedWorktrees(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("只读 Worktree 盘点（声明统计不等于实时磁盘；所有计划均保留）");
      console.log(`声明 run=${report.inventory.gauges.managedRuns} worktree=${report.inventory.gauges.managedWorktrees} pendingApply=${report.inventory.gauges.pendingApplyTransactions}`);
      console.log(`Git 核对=${report.gitChecked} 截断=${report.truncated} 原因=${report.reason}`);
      console.log(`orphan=${report.counts.orphan ?? "未核对"} missingWorktree=${report.counts.missingWorktree ?? "未核对"} uncapturedDirty=${report.counts.uncapturedDirty ?? "未核对"} staleTx=${report.counts.staleTx ?? "未核对"} contentUnverified=${report.counts.contentUnverified}`);
      for (const plan of report.plans) console.log(`${plan.runId} / ${plan.workerId} repo=${plan.repoHash} retain ${plan.reason}`);
    }
    if (report.inventory.unavailable || report.reason === "inspection_unavailable") process.exitCode = 1;
  }
} catch {
  console.error("INSPECTION_FAILED: use --help for read-only inspection options.");
  process.exitCode = 1;
}
