#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings";
import { $ } from "execa";
import prompts from "prompts";
import ora from "ora";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import pino from "pino";
import {
  getCurrentBranch,
  getRemoteUrl,
  parseAzureDevOpsRemote,
  isGitRepository,
} from "./git.js";
import { createConnection, getOrgUrl, findPullRequest } from "./ado.js";

const logger = pino({
  customLevels: {
    log: 30,
  },
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AzureConfig {
  token: string;
  org: string;
  project: string;
  repo: string;
  prId: string;
}

interface ExistingComment {
  threadId: string;
  commentId: string;
  existingContent: string;
}

interface ClaudeResult {
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

interface HttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: string;
}

const program = new Command()
  .name("claude-review")
  .description("Review code changes using Claude Code")
  .version("1.0.0")
  .option("-d, --directory <path>", "Directory to review", process.cwd())
  .option("-c, --compare-branch <branch>", "Branch to compare against", "main")
  .option(
    "-p, --prompt-file <file>",
    "Custom prompt file",
    path.join(__dirname, "../pr-review-prompt.md")
  )
  .option("--post", "Automatically post to Azure DevOps without asking")
  .option("--no-post", "Skip posting to Azure DevOps (just show review)")
  .option(
    "--azure-pr <id>",
    "Azure DevOps PR ID (will auto-detect if not provided)"
  )
  .option(
    "--use-env-vars",
    "Use environment variables instead of Azure CLI auto-detection"
  )
  .option(
    "--use-existing-review",
    "Use existing claude-review.md file instead of running Claude again"
  )
  .option(
    "--append",
    "Append to existing Claude review comment instead of replacing it"
  )
  .option(
    "--new-comment",
    "Always create a new comment instead of updating existing one"
  )
  .option(
    "--remove-review-file",
    "Remove the claude-review.md file after processing"
  );

program.parse();
const options = program.opts();

async function main(): Promise<void> {
  try {
    const spinner = ora("Starting Claude Code Review CLI").start();
    spinner.succeed("Claude Code Review CLI");

    logger.log(`Reviewing changes in: ${options.directory}`);
    logger.log(`Comparing against: ${options.compareBranch}`);

    // Change to target directory
    process.chdir(options.directory);

    // Check if we're in a git repository
    if (!fs.existsSync(".git")) {
      console.error("❌ Not a git repository");
      process.exit(1);
    }

    // Check if compare branch exists
    try {
      execSync(`git rev-parse --verify ${options.compareBranch}`, {
        stdio: "ignore",
      });
    } catch (error) {
      console.error(`❌ Branch '${options.compareBranch}' not found`);
      process.exit(1);
    }

    // Get git diff
    const diffSpinner = ora("Getting changes...").start();
    const gitDiff = await getGitDiff(options.compareBranch);
    diffSpinner.succeed("Changes retrieved");

    if (!gitDiff.trim()) {
      logger.log("✅ No changes to review");
      process.exit(0);
    }

    let reviewFile = path.join(process.cwd(), "claude-review.md");
    let review: string;

    // Check if we should use existing review file
    if (options.useExistingReview && fs.existsSync(reviewFile)) {
      logger.log("📄 Using existing claude-review.md file...");
      review = processClaudeOutput(reviewFile);
    } else {
      // Run Claude
      const claudeSpinner = ora("Running Claude review...").start();
      reviewFile = await runClaudeCode(
        options.promptFile,
        gitDiff,
        options.compareBranch
      );
      claudeSpinner.succeed("Claude review completed");

      // Check if Claude created the review file
      review = processClaudeOutput(reviewFile);
    }

    logger.log("\n✅ Review completed!\n");
    logger.log("=".repeat(50));
    logger.log(review);
    logger.log("=".repeat(50));

    logger.log(`Review saved to: ${reviewFile}`);

    // Handle Azure DevOps posting
    logger.log(`options: ${JSON.stringify(options)}`);

    if (options.post !== false) {
      logger.log("Azure DevOps posting...");
      const azureConfig = await getAzureDevOpsConfig();
      if (azureConfig) {
        let shouldPost = options.post; // Auto-post if --post flag

        if (!shouldPost) {
          logger.flush();

          const response = await prompts({
            type: "confirm",
            name: "post",
            message: `Post this review to Azure DevOps PR ${azureConfig.org}/${azureConfig.project} - PR #${azureConfig.prId}?`,
            initial: true,
          });
          shouldPost = response.post;
        }

        if (shouldPost) {
          await postToAzureDevOps(review, azureConfig);
        }
      } else {
        logger.log(
          "⚠️  No Azure DevOps PR detected. Use --azure-pr <id> or set AZURE_DEVOPS_PR_ID"
        );
      }
    }

    // Optionally remove the review file
    if (options.removeReviewFile && fs.existsSync(reviewFile)) {
      fs.unlinkSync(reviewFile);
      logger.log("🗑️  Removed claude-review.md file");
    } else {
      // Keep claude-review.md file for user reference
      logger.log("📄 claude-review.md saved for reference");
    }
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function getGitDiff(compareBranch: string): Promise<string> {
  try {
    let fullDiff: string;

    try {
      // Try with execSync first with larger buffer
      fullDiff = execSync(`git diff ${compareBranch}...HEAD`, {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      });
    } catch (bufferError) {
      // If buffer error, fall back to execa with streaming
      const result = await $`git diff ${compareBranch}...HEAD`;
      fullDiff = result.stdout;
    }

    // Define lock files to filter out
    const lockFiles = [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
      "Cargo.lock",
      "Gemfile.lock",
      "composer.lock",
      "Pipfile.lock",
      "poetry.lock",
    ];

    // Filter out lock file changes from the diff
    const lines = fullDiff.split("\n");
    const filteredLines: string[] = [];
    let skipFile = false;

    for (const line of lines) {
      // Check if this is a new file header
      if (line.startsWith("diff --git")) {
        // Check if this file should be skipped
        skipFile = lockFiles.some((lockFile) => line.includes(lockFile));
      }

      // Include line if we're not skipping this file
      if (!skipFile) {
        filteredLines.push(line);
      }
    }

    return filteredLines.join("\n");
  } catch (error) {
    throw new Error(`Failed to get git diff: ${(error as Error).message}`);
  }
}

async function runClaudeCode(
  promptFile: string,
  gitDiff: string,
  compareBranch: string
): Promise<string> {
  const reviewFile = path.join(process.cwd(), "claude-review.md");

  try {
    // Check if prompt file exists
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }

    // Read the prompt content
    const promptContent = fs.readFileSync(promptFile, "utf8");

    // Build context inline
    const contextContent = `# Code Review Context

## Changes Overview
Comparing current branch against: \`${compareBranch}\`

## Git Diff
\`\`\`diff
${gitDiff}
\`\`\`

Please review these changes according to the prompt instructions.

Some notes:
- don't leave a grade or rating in the review
`;

    const fullPrompt = `${promptContent}\n\n${contextContent}\n\nPlease write your review directly to a file called "claude-review.md" in the current directory.`;

    // Find Claude command location
    let claudePath = "claude";
    try {
      claudePath = execSync("which claude", { encoding: "utf8" }).trim();
    } catch (error) {
      // Try common locations
      const commonPaths = [
        process.env.HOME + "/.claude/local/claude",
        "/usr/local/bin/claude",
        process.env.HOME + "/.bun/bin/claude",
        process.env.HOME + "/.local/bin/claude",
      ];

      for (const path of commonPaths) {
        if (fs.existsSync(path)) {
          claudePath = path;
          break;
        }
      }
    }

    logger.log(`Using Claude at: ${claudePath}`);
    logger.log(`Prompt file: ${promptFile}`);
    logger.log(`Git diff: ${gitDiff}`);
    logger.log(`Compare branch: ${compareBranch}`);
    logger.log(`Prompt was: ${promptContent}`);

    // Run Claude with JSON output to capture cost and usage metrics
    const args = [
      "--allowedTools",
      "Bash(git *) Read Write Grep Glob TodoWrite",
      "--output-format",
      "json",
    ];

    logger.log(`Running: ${claudePath} ${args.join(" ")}`);

    // Use execa to properly handle arguments with special characters
    const result = await $({
      input: fullPrompt,
      env: { ...process.env },
    })`${claudePath} ${args}`;

    const output = result.stdout;

    // Parse the JSON output to extract cost and usage information
    try {
      const result: ClaudeResult = JSON.parse(output);
      displayClaudeMetrics(result);
    } catch (parseError) {
      logger.log("⚠️  Could not parse Claude metrics from output");
    }

    return reviewFile;
  } catch (error) {
    throw new Error(`Claude execution failed: ${(error as Error).message}`);
  }
}

function displayClaudeMetrics(result: ClaudeResult): void {
  if (
    result &&
    result.duration_ms &&
    result.total_cost_usd !== undefined &&
    result.usage
  ) {
    logger.log("\n📊 Claude Usage Metrics:");
    logger.log(`   Duration: ${result.duration_ms}ms`);
    logger.log(`   Total Cost: $${result.total_cost_usd.toFixed(6)}`);

    const usage = result.usage;
    if (usage.input_tokens) {
      logger.log(`   Input Tokens: ${usage.input_tokens.toLocaleString()}`);
    }
    if (usage.cache_read_input_tokens) {
      logger.log(
        `   Cache Read Tokens: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
    if (usage.output_tokens) {
      logger.log(`   Output Tokens: ${usage.output_tokens.toLocaleString()}`);
    }
  }
}

function processClaudeOutput(reviewFile: string): string {
  if (!fs.existsSync(reviewFile)) {
    throw new Error(
      "Claude did not create the review file. Make sure Claude has write permissions."
    );
  }

  try {
    const reviewContent = fs.readFileSync(reviewFile, "utf8");

    if (!reviewContent.trim()) {
      throw new Error("Review file is empty");
    }

    return reviewContent;
  } catch (error) {
    throw new Error(`Failed to read review file: ${(error as Error).message}`);
  }
}

async function getAzureDevOpsConfig(): Promise<AzureConfig | null> {
  // If user wants to use env vars, try that first
  if (options.useEnvVars) {
    logger.debug(
      "Using environment variables as requested by --use-env-vars flag"
    );
    return getConfigFromEnvVars();
  }

  // Try reliable git + API detection first
  try {
    logger.log("Trying git + API detection...");
    const azConfig = await getConfigFromGitAndApi();
    if (azConfig) {
      logger.debug(
        "Successfully obtained Azure config from git + API: org=%s, project=%s, repo=%s, prId=%s",
        azConfig.org,
        azConfig.project,
        azConfig.repo,
        azConfig.prId
      );
      return azConfig;
    }
    logger.debug("getConfigFromGitAndApi() returned null - no config found");
  } catch (error) {
    logger.log("Git + API detection failed, trying Azure CLI...");
    logger.debug(
      "getConfigFromGitAndApi() threw error: %s",
      (error as Error).message
    );
  }

  // Fallback to Azure CLI auto-detection
  try {
    logger.log("Trying Azure CLI auto-detection...");
    logger.debug("Calling getConfigFromAzureCli()");
    const azConfig = await getConfigFromAzureCli();
    if (azConfig) {
      logger.debug(
        "Successfully obtained Azure config from CLI: org=%s, project=%s, repo=%s, prId=%s",
        azConfig.org,
        azConfig.project,
        azConfig.repo,
        azConfig.prId
      );
      return azConfig;
    }
    logger.debug("getConfigFromAzureCli() returned null - no config found");
  } catch (error) {
    logger.log("Azure CLI detection failed, trying environment variables...");
    logger.debug(
      "getConfigFromAzureCli() threw error: %s",
      (error as Error).message
    );
  }

  // Final fallback to environment variables
  logger.debug("Falling back to environment variables");
  return getConfigFromEnvVars();
}

async function getConfigFromGitAndApi(): Promise<AzureConfig | null> {
  try {
    logger.debug("Starting getConfigFromGitAndApi()");

    // Check if we have the required token
    const token = process.env.AZURE_DEVOPS_TOKEN;
    if (!token) {
      logger.debug("AZURE_DEVOPS_TOKEN not found");
      return null;
    }

    // Check if we're in a git repository
    if (!(await isGitRepository())) {
      logger.debug("Not in a git repository");
      return null;
    }

    // Get current branch
    const currentBranch = await getCurrentBranch();
    logger.debug("Current branch: %s", currentBranch);

    // Get remote URL and parse Azure DevOps info
    const remoteUrl = await getRemoteUrl();
    logger.debug("Remote URL: %s", remoteUrl);

    const remoteInfo = parseAzureDevOpsRemote(remoteUrl);
    logger.debug(
      "Parsed remote info: org=%s, project=%s, repo=%s",
      remoteInfo.organization,
      remoteInfo.project,
      remoteInfo.repository
    );

    // If user specified PR ID, use it directly
    if (options.azurePr) {
      logger.debug("Using user-specified PR ID: %s", options.azurePr);
      return {
        token,
        org: remoteInfo.organization,
        project: remoteInfo.project,
        repo: remoteInfo.repository,
        prId: options.azurePr,
      };
    }

    // Create connection and find PR for current branch
    const orgUrl = getOrgUrl(remoteInfo.organization);
    const connection = createConnection(orgUrl, token);

    logger.debug("Searching for PR for branch: %s", currentBranch);
    const pr = await findPullRequest(connection, remoteInfo, currentBranch);

    if (!pr) {
      logger.debug("No PR found for current branch");
      return null;
    }

    return {
      token,
      org: remoteInfo.organization,
      project: remoteInfo.project,
      repo: remoteInfo.repository,
      prId: pr.pullRequestId?.toString() || "",
    };
  } catch (error) {
    logger.debug(
      "getConfigFromGitAndApi() error: %s",
      (error as Error).message
    );
    return null;
  }
}

function getConfigFromEnvVars(): AzureConfig | null {
  const token = process.env.AZURE_DEVOPS_TOKEN;
  const org = process.env.AZURE_DEVOPS_ORG;
  const project = process.env.AZURE_DEVOPS_PROJECT;
  const repo = process.env.AZURE_DEVOPS_REPO;
  const prId = options.azurePr || process.env.AZURE_DEVOPS_PR_ID;

  if (!token || !org || !project || !repo || !prId) {
    return null;
  }

  return { token, org, project, repo, prId };
}

async function getConfigFromAzureCli(): Promise<AzureConfig | null> {
  try {
    logger.debug("Starting getConfigFromAzureCli()");

    // Check if az CLI is available
    logger.debug("Checking if Azure CLI is available");
    execSync("az --version", { stdio: "ignore" });
    logger.debug("Azure CLI is available");

    // Get current branch
    logger.debug("Getting current git branch");
    const currentBranch = execSync("git branch --show-current", {
      encoding: "utf8",
    }).trim();
    logger.debug("Current branch detected: %s", currentBranch);

    // Get all active PRs using az CLI auto-detection
    logger.debug("Fetching active PRs using Azure CLI auto-detection");
    const prListOutput = execSync(
      `az repos pr list --detect --status active --output json`,
      { encoding: "utf8", stdio: "pipe" }
    );
    logger.debug(
      "Raw PR list output received, length: %d",
      prListOutput.length
    );

    const prs = JSON.parse(prListOutput);
    logger.debug("Parsed PR list, count: %d", prs.length);

    if (prs.length === 0) {
      logger.debug("No active PRs found");
      // If no active PRs found, check if user specified PR ID
      if (options.azurePr) {
        logger.debug(
          "User specified PR ID, fetching specific PR: %s",
          options.azurePr
        );
        const prOutput = execSync(
          `az repos pr show --detect --id ${options.azurePr} --output json`,
          { encoding: "utf8", stdio: "pipe" }
        );
        const pr = JSON.parse(prOutput);
        logger.debug("Specific PR fetched successfully");
        return parseAzurePr(pr);
      }
      logger.debug("No PR ID specified, returning null");
      return null;
    }

    // Find PR that matches current branch
    logger.debug("Looking for PR matching current branch: %s", currentBranch);
    const matchingPr = prs.find((pr: any) => {
      // sourceRefName format is "refs/heads/branch-name"
      const branchName = pr.sourceRefName.replace("refs/heads/", "");
      logger.debug(
        "Checking PR branch: %s against current: %s",
        branchName,
        currentBranch
      );
      return branchName === currentBranch;
    });

    if (matchingPr) {
      logger.debug(
        "Found matching PR for current branch: prId=%s, sourceBranch=%s",
        matchingPr.pullRequestId,
        matchingPr.sourceRefName
      );
      return parseAzurePr(matchingPr);
    }

    logger.debug("No matching PR found for current branch");

    // If no matching PR found but user specified PR ID
    if (options.azurePr) {
      logger.debug(
        "No matching PR but user specified PR ID, fetching specific PR: %s",
        options.azurePr
      );
      const prOutput = execSync(
        `az repos pr show --detect --id ${options.azurePr} --output json`,
        { encoding: "utf8", stdio: "pipe" }
      );
      const pr = JSON.parse(prOutput);
      logger.debug("Specific PR fetched successfully");
      return parseAzurePr(pr);
    }

    logger.debug("No matching PR and no user-specified PR ID, returning null");
    return null;
  } catch (error) {
    logger.debug(
      "getConfigFromAzureCli() caught error: %s",
      (error as Error).message
    );
    return null;
  }
}

function parseAzurePr(pr: any): AzureConfig | null {
  try {
    logger.debug("Starting parseAzurePr() for prId: %s", pr.pullRequestId);

    // Extract info from the PR object structure
    const prId = pr.pullRequestId.toString();
    const repo = pr.repository.name;
    const project = pr.repository.project.name;

    logger.debug(
      "Extracted basic PR info: prId=%s, repo=%s, project=%s",
      prId,
      repo,
      project
    );

    // Extract org from the URL - Azure DevOps URLs are like:
    // https://convergentis.visualstudio.com/projectid/_apis/git/repositories/repoid/pullRequests/prid
    logger.debug("Extracting organization from PR URL: %s", pr.url);
    const urlMatch = pr.url.match(/https:\/\/([^\.]+)\.visualstudio\.com/);

    if (!urlMatch) {
      logger.log("⚠️  Could not extract organization from PR URL");
      logger.debug("URL pattern match failed for URL: %s", pr.url);
      return null;
    }

    const org = urlMatch[1];
    logger.debug("Successfully extracted organization: %s", org);

    const token = process.env.AZURE_DEVOPS_TOKEN;

    if (!token) {
      logger.log("⚠️  AZURE_DEVOPS_TOKEN environment variable is required");
      logger.debug("AZURE_DEVOPS_TOKEN environment variable not found");
      return null;
    }

    logger.debug(
      "Successfully created Azure config: org=%s, project=%s, repo=%s, prId=%s",
      org,
      project,
      repo,
      prId
    );
    return { token, org, project, repo, prId };
  } catch (error) {
    logger.log(`⚠️  Error parsing PR data: ${(error as Error).message}`);
    logger.debug("parseAzurePr() caught error: %s", (error as Error).message);
    return null;
  }
}

async function findExistingClaudeComment(
  config: AzureConfig
): Promise<ExistingComment | null> {
  const { token, org, project, repo, prId } = config;

  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}/threads?api-version=7.1`;

  try {
    const response = await makeHttpRequest(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      const threads = JSON.parse(response.body);

      // Look for thread with Claude Code Review comment
      for (const thread of threads.value || []) {
        if (thread.comments && thread.comments.length > 0) {
          const firstComment = thread.comments[0];
          if (
            firstComment.content &&
            firstComment.content.includes("# Claude Code Review")
          ) {
            return {
              threadId: thread.id,
              commentId: firstComment.id,
              existingContent: firstComment.content,
            };
          }
        }
      }
    }

    return null;
  } catch (error) {
    logger.log(
      `Could not search for existing comments: ${(error as Error).message}`
    );
    return null;
  }
}

async function updateExistingComment(
  config: AzureConfig,
  commentId: string,
  newContent: string
): Promise<HttpResponse> {
  const { token, org, project, repo, prId } = config;

  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}/threads/${commentId}/comments/1?api-version=7.1`;

  const payload = {
    content: newContent,
  };

  const response = await makeHttpRequest(apiUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  return response;
}

async function createNewComment(
  config: AzureConfig,
  content: string
): Promise<HttpResponse> {
  const { token, org, project, repo, prId } = config;

  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}/threads?api-version=7.1`;

  const payload = {
    comments: [
      {
        parentCommentId: 0,
        content: content,
        commentType: 1,
      },
    ],
    status: 1,
  };

  const response = await makeHttpRequest(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  return response;
}

async function postToAzureDevOps(
  reviewContent: string,
  config: AzureConfig
): Promise<void> {
  const spinner = ora("Posting to Azure DevOps...").start();

  try {
    let response: HttpResponse;
    let action = "posted";

    // Check if we should create a new comment regardless
    if (options.newComment) {
      const content = `# Claude Code Review\n\n${reviewContent}`;
      response = await createNewComment(config, content);
      action = "posted as new comment";
    } else {
      // Default behavior: look for existing comment to update (sticky)
      const existingComment = await findExistingClaudeComment(config);

      if (existingComment) {
        let newContent: string;

        if (options.append) {
          // Append to existing content
          newContent = `${existingComment.existingContent}\n\n---\n\n**Updated Review:**\n\n${reviewContent}`;
          action = "appended to existing comment";
        } else {
          // Replace existing content (default sticky behavior)
          newContent = `# Claude Code Review\n\n${reviewContent}`;
          action = "updated existing comment";
        }

        response = await updateExistingComment(
          config,
          existingComment.threadId,
          newContent
        );
      } else {
        // No existing comment found, create new one
        const content = `# Claude Code Review\n\n${reviewContent}`;
        response = await createNewComment(config, content);
        action = "posted new comment";
      }
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      spinner.succeed(`Successfully ${action} on Azure DevOps`);
    } else {
      spinner.fail(
        `Failed to post review: ${response.statusCode} ${response.statusMessage}`
      );
      console.error("Response body:", response.body);
    }
  } catch (error) {
    spinner.fail(`Error posting to Azure DevOps: ${(error as Error).message}`);
  }
}

async function makeHttpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<HttpResponse> {
  try {
    const fetchOptions: RequestInit = {
      method: options.method || "GET",
      headers: options.headers || {},
    };

    if (options.body) {
      fetchOptions.body = options.body;
    }

    const response = await fetch(url, fetchOptions);
    const body = await response.text();

    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: body,
    };
  } catch (error) {
    throw error;
  }
}

// Always run main when this file is executed directly
main();
