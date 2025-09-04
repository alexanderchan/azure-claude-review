#!/usr/bin/env node

// src/claude-review.ts
import { Command } from "@commander-js/extra-typings";
import { $ } from "execa";
import prompts from "prompts";
import ora from "ora";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var program = new Command().name("claude-review").description("Review code changes using Claude Code").version("1.0.0").option("-d, --directory <path>", "Directory to review", process.cwd()).option("-c, --compare-branch <branch>", "Branch to compare against", "main").option(
  "-p, --prompt-file <file>",
  "Custom prompt file",
  path.join(__dirname, "../pr-review-prompt.md")
).option("--post", "Automatically post to Azure DevOps without asking").option("--no-post", "Skip posting to Azure DevOps (just show review)").option(
  "--azure-pr <id>",
  "Azure DevOps PR ID (will auto-detect if not provided)"
).option(
  "--use-env-vars",
  "Use environment variables instead of Azure CLI auto-detection"
).option(
  "--use-existing-review",
  "Use existing claude-review.md file instead of running Claude again"
).option(
  "--append",
  "Append to existing Claude review comment instead of replacing it"
).option(
  "--new-comment",
  "Always create a new comment instead of updating existing one"
).option(
  "--remove-review-file",
  "Remove the claude-review.md file after processing"
);
program.parse();
var options = program.opts();
async function main() {
  try {
    const spinner = ora("Starting Claude Code Review CLI").start();
    spinner.succeed("Claude Code Review CLI");
    console.log(`Reviewing changes in: ${options.directory}`);
    console.log(`Comparing against: ${options.compareBranch}`);
    process.chdir(options.directory);
    if (!fs.existsSync(".git")) {
      console.error("\u274C Not a git repository");
      process.exit(1);
    }
    try {
      execSync(`git rev-parse --verify ${options.compareBranch}`, {
        stdio: "ignore"
      });
    } catch (error) {
      console.error(`\u274C Branch '${options.compareBranch}' not found`);
      process.exit(1);
    }
    const diffSpinner = ora("Getting changes...").start();
    const gitDiff = await getGitDiff(options.compareBranch);
    diffSpinner.succeed("Changes retrieved");
    if (!gitDiff.trim()) {
      console.log("\u2705 No changes to review");
      process.exit(0);
    }
    let reviewFile = path.join(process.cwd(), "claude-review.md");
    let review;
    if (options.useExistingReview && fs.existsSync(reviewFile)) {
      console.log("\u{1F4C4} Using existing claude-review.md file...");
      review = processClaudeOutput(reviewFile);
    } else {
      const claudeSpinner = ora("Running Claude review...").start();
      reviewFile = await runClaudeCode(
        options.promptFile,
        gitDiff,
        options.compareBranch
      );
      claudeSpinner.succeed("Claude review completed");
      review = processClaudeOutput(reviewFile);
    }
    console.log("\n\u2705 Review completed!\n");
    console.log("=".repeat(50));
    console.log(review);
    console.log("=".repeat(50));
    if (!options.noPost) {
      const azureConfig = await getAzureDevOpsConfig();
      if (azureConfig) {
        console.log(
          `Found PR: ${azureConfig.org}/${azureConfig.project} - PR #${azureConfig.prId}`
        );
        let shouldPost = options.post;
        if (!shouldPost) {
          const response = await prompts({
            type: "confirm",
            name: "post",
            message: "Post this review to Azure DevOps PR?",
            initial: true
          });
          shouldPost = response.post;
        }
        if (shouldPost) {
          await postToAzureDevOps(review, azureConfig);
        }
      } else {
        console.log(
          "\u26A0\uFE0F  No Azure DevOps PR detected. Use --azure-pr <id> or set AZURE_DEVOPS_PR_ID"
        );
      }
    }
    if (options.removeReviewFile && fs.existsSync(reviewFile)) {
      fs.unlinkSync(reviewFile);
      console.log("\u{1F5D1}\uFE0F  Removed claude-review.md file");
    } else {
      console.log("\u{1F4C4} claude-review.md saved for reference");
    }
  } catch (error) {
    console.error(`\u274C Error: ${error.message}`);
    process.exit(1);
  }
}
async function getGitDiff(compareBranch) {
  try {
    let fullDiff;
    try {
      fullDiff = execSync(`git diff ${compareBranch}...HEAD`, {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024
        // 50MB buffer
      });
    } catch (bufferError) {
      const result = await $`git diff ${compareBranch}...HEAD`;
      fullDiff = result.stdout;
    }
    const lockFiles = [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
      "Cargo.lock",
      "Gemfile.lock",
      "composer.lock",
      "Pipfile.lock",
      "poetry.lock"
    ];
    const lines = fullDiff.split("\n");
    const filteredLines = [];
    let skipFile = false;
    for (const line of lines) {
      if (line.startsWith("diff --git")) {
        skipFile = lockFiles.some((lockFile) => line.includes(lockFile));
      }
      if (!skipFile) {
        filteredLines.push(line);
      }
    }
    return filteredLines.join("\n");
  } catch (error) {
    throw new Error(`Failed to get git diff: ${error.message}`);
  }
}
async function runClaudeCode(promptFile, gitDiff, compareBranch) {
  const reviewFile = path.join(process.cwd(), "claude-review.md");
  try {
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }
    const promptContent = fs.readFileSync(promptFile, "utf8");
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
    const fullPrompt = `${promptContent}

${contextContent}

Please write your review directly to a file called "claude-review.md" in the current directory.`;
    let claudePath = "claude";
    try {
      claudePath = execSync("which claude", { encoding: "utf8" }).trim();
    } catch (error) {
      const commonPaths = [
        process.env.HOME + "/.claude/local/claude",
        "/usr/local/bin/claude",
        process.env.HOME + "/.bun/bin/claude",
        process.env.HOME + "/.local/bin/claude"
      ];
      for (const path2 of commonPaths) {
        if (fs.existsSync(path2)) {
          claudePath = path2;
          break;
        }
      }
    }
    console.log(`Using Claude at: ${claudePath}`);
    const args = [
      "--allowedTools",
      "Bash(git *) Read Write Grep Glob TodoWrite",
      "--output-format",
      "json"
    ];
    console.log(`Running: ${claudePath} ${args.join(" ")}`);
    const result = await $({
      input: fullPrompt,
      env: { ...process.env }
    })`${claudePath} ${args}`;
    const output = result.stdout;
    try {
      const result2 = JSON.parse(output);
      displayClaudeMetrics(result2);
    } catch (parseError) {
      console.log("\u26A0\uFE0F  Could not parse Claude metrics from output");
    }
    return reviewFile;
  } catch (error) {
    throw new Error(`Claude execution failed: ${error.message}`);
  }
}
function displayClaudeMetrics(result) {
  if (result && result.duration_ms && result.total_cost_usd !== void 0 && result.usage) {
    console.log("\n\u{1F4CA} Claude Usage Metrics:");
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
    console.log();
  }
}
function processClaudeOutput(reviewFile) {
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
    throw new Error(`Failed to read review file: ${error.message}`);
  }
}
async function getAzureDevOpsConfig() {
  if (options.useEnvVars) {
    return getConfigFromEnvVars();
  }
  try {
    const azConfig = await getConfigFromAzureCli();
    if (azConfig) {
      return azConfig;
    }
  } catch (error) {
    console.log("Azure CLI detection failed, trying environment variables...");
  }
  return getConfigFromEnvVars();
}
function getConfigFromEnvVars() {
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
async function getConfigFromAzureCli() {
  try {
    execSync("az --version", { stdio: "ignore" });
    const currentBranch = execSync("git branch --show-current", {
      encoding: "utf8"
    }).trim();
    const prListOutput = execSync(
      `az repos pr list --detect --status active --output json`,
      { encoding: "utf8", stdio: "pipe" }
    );
    const prs = JSON.parse(prListOutput);
    if (prs.length === 0) {
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
    const matchingPr = prs.find((pr) => {
      const branchName = pr.sourceRefName.replace("refs/heads/", "");
      return branchName === currentBranch;
    });
    if (matchingPr) {
      return parseAzurePr(matchingPr);
    }
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
function parseAzurePr(pr) {
  try {
    const prId = pr.pullRequestId.toString();
    const repo = pr.repository.name;
    const project = pr.repository.project.name;
    const urlMatch = pr.url.match(/https:\/\/([^\.]+)\.visualstudio\.com/);
    if (!urlMatch) {
      console.log("\u26A0\uFE0F  Could not extract organization from PR URL");
      return null;
    }
    const org = urlMatch[1];
    const token = process.env.AZURE_DEVOPS_TOKEN;
    if (!token) {
      console.log("\u26A0\uFE0F  AZURE_DEVOPS_TOKEN environment variable is required");
      return null;
    }
    return { token, org, project, repo, prId };
  } catch (error) {
    console.log(`\u26A0\uFE0F  Error parsing PR data: ${error.message}`);
    return null;
  }
}
async function findExistingClaudeComment(config) {
  const { token, org, project, repo, prId } = config;
  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}/threads?api-version=7.1`;
  try {
    const response = await makeHttpRequest(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
        Accept: "application/json"
      }
    });
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const threads = JSON.parse(response.body);
      for (const thread of threads.value || []) {
        if (thread.comments && thread.comments.length > 0) {
          const firstComment = thread.comments[0];
          if (firstComment.content && firstComment.content.includes("# Claude Code Review")) {
            return {
              threadId: thread.id,
              commentId: firstComment.id,
              existingContent: firstComment.content
            };
          }
        }
      }
    }
    return null;
  } catch (error) {
    console.log(
      `Could not search for existing comments: ${error.message}`
    );
    return null;
  }
}
async function updateExistingComment(config, commentId, newContent) {
  const { token, org, project, repo, prId } = config;
  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}/threads/${commentId}/comments/1?api-version=7.1`;
  const payload = {
    content: newContent
  };
  const response = await makeHttpRequest(apiUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });
  return response;
}
async function createNewComment(config, content) {
  const { token, org, project, repo, prId } = config;
  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}/threads?api-version=7.1`;
  const payload = {
    comments: [
      {
        parentCommentId: 0,
        content,
        commentType: 1
      }
    ],
    status: 1
  };
  const response = await makeHttpRequest(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });
  return response;
}
async function postToAzureDevOps(reviewContent, config) {
  const spinner = ora("Posting to Azure DevOps...").start();
  try {
    let response;
    let action = "posted";
    if (options.newComment) {
      const content = `# Claude Code Review

${reviewContent}`;
      response = await createNewComment(config, content);
      action = "posted as new comment";
    } else {
      const existingComment = await findExistingClaudeComment(config);
      if (existingComment) {
        let newContent;
        if (options.append) {
          newContent = `${existingComment.existingContent}

---

**Updated Review:**

${reviewContent}`;
          action = "appended to existing comment";
        } else {
          newContent = `# Claude Code Review

${reviewContent}`;
          action = "updated existing comment";
        }
        response = await updateExistingComment(
          config,
          existingComment.threadId,
          newContent
        );
      } else {
        const content = `# Claude Code Review

${reviewContent}`;
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
    spinner.fail(`Error posting to Azure DevOps: ${error.message}`);
  }
}
async function makeHttpRequest(url, options2 = {}) {
  try {
    const fetchOptions = {
      method: options2.method || "GET",
      headers: options2.headers || {}
    };
    if (options2.body) {
      fetchOptions.body = options2.body;
    }
    const response = await fetch(url, fetchOptions);
    const body = await response.text();
    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body
    };
  } catch (error) {
    throw error;
  }
}
main();
