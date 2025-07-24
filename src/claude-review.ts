#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings";
import { $ } from "execa";
import prompts from "prompts";
import ora from "ora";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

    console.log(`Reviewing changes in: ${options.directory}`);
    console.log(`Comparing against: ${options.compareBranch}`);

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
      console.log("✅ No changes to review");
      process.exit(0);
    }

    let reviewFile = path.join(process.cwd(), "claude-review.md");
    let review: string;

    // Check if we should use existing review file
    if (options.useExistingReview && fs.existsSync(reviewFile)) {
      console.log("📄 Using existing claude-review.md file...");
      review = processClaudeOutput(reviewFile);
    } else {
      // Run Claude
      const claudeSpinner = ora("Running Claude review...").start();
      reviewFile = await runClaudeCode(options.promptFile, gitDiff, options.compareBranch);
      claudeSpinner.succeed("Claude review completed");

      // Check if Claude created the review file
      review = processClaudeOutput(reviewFile);
    }

    console.log("\n✅ Review completed!\n");
    console.log("=".repeat(50));
    console.log(review);
    console.log("=".repeat(50));

    // Handle Azure DevOps posting
    if (!options.noPost) {
      const azureConfig = await getAzureDevOpsConfig();
      if (azureConfig) {
        console.log(
          `Found PR: ${azureConfig.org}/${azureConfig.project} - PR #${azureConfig.prId}`
        );

        let shouldPost = options.post; // Auto-post if --post flag

        if (!shouldPost) {
          const response = await prompts({
            type: "confirm",
            name: "post",
            message: "Post this review to Azure DevOps PR?",
            initial: true,
          });
          shouldPost = response.post;
        }

        if (shouldPost) {
          await postToAzureDevOps(review, azureConfig);
        }
      } else {
        console.log(
          "⚠️  No Azure DevOps PR detected. Use --azure-pr <id> or set AZURE_DEVOPS_PR_ID"
        );
      }
    }

    // Optionally remove the review file
    if (options.removeReviewFile && fs.existsSync(reviewFile)) {
      fs.unlinkSync(reviewFile);
      console.log("🗑️  Removed claude-review.md file");
    } else {
      // Keep claude-review.md file for user reference
      console.log("📄 claude-review.md saved for reference");
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

    console.log(`Using Claude at: ${claudePath}`);

    // Run Claude with JSON output to capture cost and usage metrics
    const args = [
      "--allowedTools",
      "Bash(git *) Read Write Grep Glob TodoWrite",
      "--output-format",
      "json",
    ];

    console.log(`Running: ${claudePath} ${args.join(" ")}`);

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
      console.log("⚠️  Could not parse Claude metrics from output");
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
    console.log("\n📊 Claude Usage Metrics:");
    console.log(`   Duration: ${result.duration_ms}ms`);
    console.log(`   Total Cost: $${result.total_cost_usd.toFixed(6)}`);

    const usage = result.usage;
    if (usage.input_tokens) {
      console.log(`   Input Tokens: ${usage.input_tokens.toLocaleString()}`);
    }
    if (usage.cache_read_input_tokens) {
      console.log(
        `   Cache Read Tokens: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
    if (usage.output_tokens) {
      console.log(`   Output Tokens: ${usage.output_tokens.toLocaleString()}`);
    }
    console.log(); // Add blank line for spacing
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
    return getConfigFromEnvVars();
  }

  // Try Azure CLI auto-detection first
  try {
    const azConfig = await getConfigFromAzureCli();
    if (azConfig) {
      return azConfig;
    }
  } catch (error) {
    console.log("Azure CLI detection failed, trying environment variables...");
  }

  // Fallback to environment variables
  return getConfigFromEnvVars();
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
    // Check if az CLI is available
    execSync("az --version", { stdio: "ignore" });

    // Get current branch
    const currentBranch = execSync("git branch --show-current", {
      encoding: "utf8",
    }).trim();

    // Get all active PRs using az CLI auto-detection
    const prListOutput = execSync(
      `az repos pr list --detect --status active --output json`,
      { encoding: "utf8", stdio: "pipe" }
    );

    const prs = JSON.parse(prListOutput);

    if (prs.length === 0) {
      // If no active PRs found, check if user specified PR ID
      if (options.azurePr) {
        const prOutput = execSync(
          `az repos pr show --detect --id ${options.azurePr} --output json`,
          { encoding: "utf8", stdio: "pipe" }
        );
        const pr = JSON.parse(prOutput);
        return parseAzurePr(pr);
      }
      return null;
    }

    // Find PR that matches current branch
    const matchingPr = prs.find((pr: any) => {
      // sourceRefName format is "refs/heads/branch-name"
      const branchName = pr.sourceRefName.replace("refs/heads/", "");
      return branchName === currentBranch;
    });

    if (matchingPr) {
      return parseAzurePr(matchingPr);
    }

    // If no matching PR found but user specified PR ID
    if (options.azurePr) {
      const prOutput = execSync(
        `az repos pr show --detect --id ${options.azurePr} --output json`,
        { encoding: "utf8", stdio: "pipe" }
      );
      const pr = JSON.parse(prOutput);
      return parseAzurePr(pr);
    }

    return null;
  } catch (error) {
    return null;
  }
}

function parseAzurePr(pr: any): AzureConfig | null {
  try {
    // Extract info from the PR object structure
    const prId = pr.pullRequestId.toString();
    const repo = pr.repository.name;
    const project = pr.repository.project.name;

    // Extract org from the URL - Azure DevOps URLs are like:
    // https://convergentis.visualstudio.com/projectid/_apis/git/repositories/repoid/pullRequests/prid
    const urlMatch = pr.url.match(/https:\/\/([^\.]+)\.visualstudio\.com/);

    if (!urlMatch) {
      console.log("⚠️  Could not extract organization from PR URL");
      return null;
    }

    const org = urlMatch[1];
    const token = process.env.AZURE_DEVOPS_TOKEN;

    if (!token) {
      console.log("⚠️  AZURE_DEVOPS_TOKEN environment variable is required");
      return null;
    }

    return { token, org, project, repo, prId };
  } catch (error) {
    console.log(`⚠️  Error parsing PR data: ${(error as Error).message}`);
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
    console.log(
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
