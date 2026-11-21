// @ts-check
"use strict";

const { readFileSync } = require("node:fs");

// The one open issue this job owns. Matched EXACTLY, over open issues, the way
// ci-failure-notify.js dedups — same shape so the two behave alike, but keyed on
// title alone: this issue deliberately carries no `ci-failure` label, because
// that label means "a run failed" and drift is a finding of a run that passed.
// Changing this string orphans the open issue and opens a second one.
const TITLE = "Fixture drift: an adapter CLI is newer than its fixtures";

const PREAMBLE =
  "The weekly **Fixture freshness** run compares each adapter's " +
  "`captured_version` in `config/live-conformance.json` to the version npm " +
  "publishes as `latest`. The adapters below have drifted: a newer CLI shipped, " +
  "so their golden fixtures in `src/fixtures/` may no longer match the payload " +
  "the agent really sends.\n\n" +
  "This issue is opened, updated and CLOSED by the job itself — it is the " +
  "standing drift record, not a CI-failure report. A drifted run still exits 0; " +
  "a red **Fixture freshness** run means the check could not run at all, and " +
  "that reaches you through the separate `ci-failure` notifier.\n\n" +
  "To clear it: follow the refresh procedure in `docs/live-conformance.md`, then " +
  "bump `captured_version` for each adapter you re-captured. The next scheduled " +
  "run closes this issue once no adapter is drifted.";

/**
 * Open, update or close the single fixture-drift tracking issue.
 *
 * Drifted: create the issue, or rewrite an open one's body so it always states
 * the CURRENT drift rather than a pile of appended comments. Not drifted: close
 * the open one. No drift and no open issue: nothing to do.
 *
 * Called by fixture-freshness.yaml via actions/github-script.
 *
 * @param {object} params
 * @param {object} params.github  - Authenticated Octokit client
 * @param {object} params.context - GitHub Actions webhook event context
 * @param {boolean} params.drifted - Whether any adapter drifted this run
 * @param {string} params.tablePath - File holding the Markdown drift table
 * @param {string} params.runUrl - Permalink to the run that produced the table
 */
module.exports = async ({ github, context, drifted, tablePath, runUrl }) => {
  const openIssues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo,
    state: "open",
    per_page: 100,
  });
  // listForRepo returns pull requests too; only real issues are dedup targets.
  const existing = openIssues.find(
    (issue) => !issue.pull_request && issue.title === TITLE,
  );

  if (!drifted) {
    if (!existing) {
      console.log("No drift and no open drift issue — nothing to do.");
      return;
    }
    await github.rest.issues.update({
      ...context.repo,
      issue_number: existing.number,
      body: `Every adapter's fixtures are known-good against the version npm publishes as \`latest\`.\n\n**Run:** ${runUrl}`,
      state: "closed",
      state_reason: "completed",
    });
    console.log(`Closed #${existing.number} — no adapter is drifted.`);
    return;
  }

  const body = `${PREAMBLE}\n\n${readFileSync(tablePath, "utf8")}\n**Run:** ${runUrl}`;

  if (existing) {
    await github.rest.issues.update({
      ...context.repo,
      issue_number: existing.number,
      body,
    });
    console.log(`Refreshed #${existing.number} with the current drift table.`);
    return;
  }

  const created = await github.rest.issues.create({
    ...context.repo,
    title: TITLE,
    body,
  });
  console.log(`Opened #${created.data.number} for the current drift.`);
};

module.exports.TITLE = TITLE;
