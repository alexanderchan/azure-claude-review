#!/usr/bin/env node

import { Command } from "commander";
import prompts from "prompts";
import ora from "ora";
import { $ } from "zx";
import {
  getCurrentBranch,
  extractWorkItemId,
  getRemoteUrl,
  parseAzureDevOpsRemote,
  isGitRepository,
} from "../git.js";
import {
  updateWorkItem,
  findPullRequest,
  createPullRequest,
  extractWorkItemFromPRTitle,
  createConnection,
  getOrgUrl,
  workItemExists,
} from "../ado.js";
import {
  formatSuccess,
  formatError,
  formatWarning,
  formatInfo,
  formatDryRun,
  formatHeader,
  formatKeyValue,
} from "../formatting.js";

// Suppress zx verbose output
$.verbose = false;

interface CliOptions {
  dryRun: boolean;
}

async function main() {
  const program = new Command();

  program
    .name("az-update-workitem")
    .description("Link Azure DevOps work items to pull requests")
    .version("1.0.0")
    .option(
      "--dry-run",
      "Show what would be done without making changes",
      false
    )
    .action(async (options: CliOptions) => {
      try {
        await runCli(options);
      } catch (error) {
        console.error(formatError(`${error}`));
        process.exit(1);
      }
    });

  await program.parseAsync();
}

async function runCli(options: CliOptions) {
  console.log(formatHeader("Azure DevOps Work Item Linker"));
  console.log();

  // Check if we're in a git repository
  const spinner = ora("Checking git repository...").start();
  if (!(await isGitRepository())) {
    spinner.fail("Not in a git repository");
    throw new Error("This command must be run from within a git repository");
  }
  spinner.succeed("Git repository detected");

  // Check for Azure DevOps token
  const token = process.env.AZURE_DEVOPS_TOKEN;
  if (!token) {
    throw new Error(
      "AZURE_DEVOPS_TOKEN environment variable is required. Please set it with your Azure DevOps Personal Access Token."
    );
  }

  // Get current branch
  spinner.start("Getting current branch...");
  const branchName = await getCurrentBranch();
  spinner.succeed(`Current branch: ${branchName}`);

  // Extract work item ID from branch name
  const workItemId = extractWorkItemId(branchName);
  if (workItemId) {
    console.log(formatInfo(`Work item ID detected: ${workItemId}`));
  } else {
    console.log(formatWarning("No work item ID detected from branch name"));
  }

  // Get remote URL and parse Azure DevOps info
  spinner.start("Parsing Azure DevOps remote...");
  const remoteUrl = await getRemoteUrl();
  const remoteInfo = parseAzureDevOpsRemote(remoteUrl);
  spinner.succeed("Azure DevOps remote parsed");

  console.log();
  console.log(formatKeyValue("Organization", remoteInfo.organization));
  console.log(formatKeyValue("Project", remoteInfo.project));
  console.log(formatKeyValue("Repository", remoteInfo.repository));
  console.log();

  // Create connection
  const orgUrl = getOrgUrl(remoteInfo.organization);
  const connection = createConnection(orgUrl, token);

  // Check if work item exists (if we have one)
  if (workItemId) {
    spinner.start(`Checking if work item ${workItemId} exists...`);
    const workItemExistsResult = await workItemExists(connection, workItemId);
    if (workItemExistsResult) {
      spinner.succeed(`Work item ${workItemId} exists`);
    } else {
      spinner.warn(`Work item ${workItemId} does not exist`);
      console.log(formatWarning(`Work item ${workItemId} was not found`));
    }
  }

  // Find existing PR
  spinner.start("Looking for existing pull request...");
  let pr = await findPullRequest(connection, remoteInfo, branchName);

  if (pr) {
    spinner.succeed(`Found PR #${pr?.pullRequestId}: ${pr.title}`);
    console.log(formatKeyValue("PR ID", pr?.pullRequestId?.toString()));
    console.log(formatKeyValue("PR Title", pr.title));
    console.log(formatKeyValue("PR Status", pr?.status?.toString()));

    // Check if we can extract work item from PR title if we don't have one from branch
    if (!workItemId) {
      const prWorkItemId = extractWorkItemFromPRTitle(pr?.title);
      if (prWorkItemId) {
        console.log(
          formatInfo(`Work item ID detected from PR title: ${prWorkItemId}`)
        );

        // Check if this work item exists
        spinner.start(`Checking if work item ${prWorkItemId} exists...`);
        const workItemExistsResult = await workItemExists(
          connection,
          prWorkItemId
        );
        if (workItemExistsResult) {
          spinner.succeed(`Work item ${prWorkItemId} exists`);

          // Use this work item ID and proceed with linking
          const result = await updateWorkItem(
            remoteInfo,
            branchName,
            prWorkItemId,
            token,
            options.dryRun
          );

          console.log();
          if (result.success) {
            console.log(formatSuccess(result.message));
          } else {
            console.log(formatError(result.message));
          }
          return;
        } else {
          spinner.warn(`Work item ${prWorkItemId} does not exist`);
        }
      }
    }
  } else {
    spinner.fail("No active pull request found");

    // Offer to create PR
    const shouldCreatePR = await prompts({
      type: "confirm",
      name: "createPR",
      message: "Would you like to create a pull request?",
      initial: true,
    });

    if (shouldCreatePR.createPR) {
      if (options.dryRun) {
        console.log(
          formatDryRun(`Would create pull request for branch ${branchName}`)
        );
        return;
      }

      spinner.start("Creating pull request...");
      try {
        pr = await createPullRequest(
          connection,
          remoteInfo,
          branchName,
          workItemId || undefined
        );
        spinner.succeed(`Created PR #${pr?.pullRequestId}: ${pr.title}`);
        console.log(formatKeyValue("PR ID", pr?.pullRequestId?.toString()));
        console.log(formatKeyValue("PR Title", pr.title));
      } catch (error) {
        spinner.fail("Failed to create pull request");
        throw error;
      }
    } else {
      console.log(formatInfo("No pull request will be created"));
      return;
    }
  }

  // If we have both work item and PR, try to link them
  if (workItemId && pr) {
    const result = await updateWorkItem(
      remoteInfo,
      branchName,
      workItemId,
      token,
      options.dryRun
    );

    console.log();
    if (result.success) {
      console.log(formatSuccess(result.message));
    } else {
      console.log(formatError(result.message));
    }
  } else if (!workItemId) {
    console.log();
    console.log(formatWarning("No work item ID available for linking"));
    console.log(
      formatInfo("Pull request created but no work item will be linked")
    );
  }
}

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    formatError("Unhandled Rejection at:"),
    promise,
    "reason:",
    reason
  );
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error(formatError("Uncaught Exception:"), error);
  process.exit(1);
});

main().catch((error) => {
  console.error(formatError(`${error}`));
  process.exit(1);
});
