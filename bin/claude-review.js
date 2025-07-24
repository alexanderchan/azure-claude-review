#!/usr/bin/env node

const { program } = require("commander");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const chalk = require("chalk");
const readline = require("readline");

program
  .name("claude-review")
  .description("Review code changes using Claude Code")
  .version("1.0.0")
  .option("-d, --directory <path>", "Directory to review", process.cwd())
  .option("-c, --compare-branch <branch>", "Branch to compare against", "main")
  .option(
    "-p, --prompt-file <file>",
    "Custom prompt file",
    path.join(__dirname, "pr-review-prompt.md")
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
  )
  .parse();

const options = program.opts();

async function main() {
  try {
    console.log(chalk.blue("🔍 Claude Code Review CLI"));
    console.log(chalk.gray(`Reviewing changes in: ${options.directory}`));
    console.log(chalk.gray(`Comparing against: ${options.compareBranch}`));

    // Change to target directory
    process.chdir(options.directory);

    // Check if we're in a git repository
    if (!fs.existsSync(".git")) {
      console.error(chalk.red("❌ Not a git repository"));
      process.exit(1);
    }

    // Check if compare branch exists
    try {
      execSync(`git rev-parse --verify ${options.compareBranch}`, {
        stdio: "ignore",
      });
    } catch (error) {
      console.error(
        chalk.red(`❌ Branch '${options.compareBranch}' not found`)
      );
      process.exit(1);
    }

    // Get git diff
    console.log(chalk.yellow("📝 Getting changes..."));
    const gitDiff = getGitDiff(options.compareBranch);

    if (!gitDiff.trim()) {
      console.log(chalk.green("✅ No changes to review"));
      process.exit(0);
    }

    // Create temporary context file for Claude
    const contextFile = createContextFile(gitDiff, options.compareBranch);

    let reviewFile = path.join(process.cwd(), "claude-review.md");
    let review;

    // Check if we should use existing review file
    if (options.useExistingReview && fs.existsSync(reviewFile)) {
      console.log(chalk.yellow("📄 Using existing claude-review.md file..."));
      review = processClaudeOutput(reviewFile);
    } else {
      // Run Claude
      console.log(chalk.yellow("🤖 Running Claude review..."));
      reviewFile = await runClaudeCode(options.promptFile, contextFile);

      // Check if Claude created the review file
      review = processClaudeOutput(reviewFile);
    }

    console.log(chalk.green("\n✅ Review completed!\n"));
    console.log(chalk.cyan("=".repeat(50)));
    console.log(review);
    console.log(chalk.cyan("=".repeat(50)));

    // Handle Azure DevOps posting
    if (!options.noPost) {
      const azureConfig = await getAzureDevOpsConfig();
      if (azureConfig) {
        console.log(
          chalk.gray(
            `Found PR: ${azureConfig.org}/${azureConfig.project} - PR #${azureConfig.prId}`
          )
        );

        let shouldPost = options.post; // Auto-post if --post flag

        if (!shouldPost) {
          shouldPost = await askYesNo("\nPost this review to Azure DevOps PR?");
        }

        if (shouldPost) {
          await postToAzureDevOps(review, azureConfig);
        }
      } else {
        console.log(
          chalk.yellow(
            "⚠️  No Azure DevOps PR detected. Use --azure-pr <id> or set AZURE_DEVOPS_PR_ID"
          )
        );
      }
    }

    // Cleanup
    fs.unlinkSync(contextFile);
    
    // Optionally remove the review file
    if (options.removeReviewFile && fs.existsSync(reviewFile)) {
      fs.unlinkSync(reviewFile);
      console.log(chalk.gray("🗑️  Removed claude-review.md file"));
    } else {
      // Keep claude-review.md file for user reference
      console.log(chalk.gray("📄 claude-review.md saved for reference"));
    }
  } catch (error) {
    console.error(chalk.red(`❌ Error: ${error.message}`));
    process.exit(1);
  }
}

function getGitDiff(compareBranch) {
  try {
    // Get full diff first
    const fullDiff = execSync(`git diff ${compareBranch}...HEAD`, {
      encoding: "utf8",
    });

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
    const filteredLines = [];
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
    throw new Error(`Failed to get git diff: ${error.message}`);
  }
}

function createContextFile(gitDiff, compareBranch) {
  const contextFile = path.join(process.cwd(), ".claude-context.md");

  const context = `# Code Review Context

## Changes Overview
Comparing current branch against: \`${compareBranch}\`

## Git Diff
\`\`\`diff
${gitDiff}
\`\`\`

Please review these changes according to the prompt instructions.
`;

  fs.writeFileSync(contextFile, context, "utf8");
  return contextFile;
}

async function runClaudeCode(promptFile, contextFile) {
  const reviewFile = path.join(process.cwd(), "claude-review.md");

  try {
    // Check if prompt file exists
    if (!fs.existsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }

    // Read the prompt content
    const promptContent = fs.readFileSync(promptFile, "utf8");

    // Read context content and append to prompt
    const contextContent = fs.readFileSync(contextFile, "utf8");
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

    console.log(chalk.gray(`Using Claude at: ${claudePath}`));

    // Run Claude with dangerously-skip-permissions and print mode
    const args = ["--dangerously-skip-permissions", "--print"];

    console.log(chalk.gray(`Running: ${claudePath} ${args.join(" ")}`));

    execSync(`${claudePath} ${args.join(" ")}`, {
      input: fullPrompt,
      stdio: ["pipe", "inherit", "inherit"], // pipe stdin, inherit stdout/stderr
      env: { ...process.env },
    });

    return reviewFile;
  } catch (error) {
    throw new Error(`Claude execution failed: ${error.message}`);
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
    console.log(
      chalk.gray("Azure CLI detection failed, trying environment variables...")
    );
  }

  // Fallback to environment variables
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
    const matchingPr = prs.find((pr) => {
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

function parseAzurePr(pr) {
  try {
    // Extract info from the PR object structure
    const prId = pr.pullRequestId.toString();
    const repo = pr.repository.name;
    const project = pr.repository.project.name;

    // Extract org from the URL - Azure DevOps URLs are like:
    // https://convergentis.visualstudio.com/projectid/_apis/git/repositories/repoid/pullRequests/prid
    const urlMatch = pr.url.match(/https:\/\/([^\.]+)\.visualstudio\.com/);

    if (!urlMatch) {
      console.log(
        chalk.yellow("⚠️  Could not extract organization from PR URL")
      );
      return null;
    }

    const org = urlMatch[1];
    const token = process.env.AZURE_DEVOPS_TOKEN;

    if (!token) {
      console.log(
        chalk.yellow("⚠️  AZURE_DEVOPS_TOKEN environment variable is required")
      );
      return null;
    }

    return { token, org, project, repo, prId };
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Error parsing PR data: ${error.message}`));
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
      chalk.gray(`Could not search for existing comments: ${error.message}`)
    );
    return null;
  }
}

async function updateExistingComment(config, commentId, newContent) {
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

async function createNewComment(config, content) {
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

async function postToAzureDevOps(reviewContent, config) {
  console.log(chalk.yellow("📤 Posting to Azure DevOps..."));

  try {
    let response;
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
        let newContent;

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
      console.log(chalk.green(`✅ Successfully ${action} on Azure DevOps`));
    } else {
      console.error(
        chalk.red(
          `❌ Failed to post review: ${response.statusCode} ${response.statusMessage}`
        )
      );
      console.error("Response body:", response.body);
    }
  } catch (error) {
    console.error(
      chalk.red(`❌ Error posting to Azure DevOps: ${error.message}`)
    );
  }
}

async function makeHttpRequest(url, options = {}) {
  try {
    const fetchOptions = {
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

function askYesNo(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.cyan(question + " (y/n): "), (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

if (require.main === module) {
  main();
}
