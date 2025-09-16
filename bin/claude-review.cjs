#!/usr/bin/env node
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
const __commander_js_extra_typings = __toESM(require("@commander-js/extra-typings"));
const execa = __toESM(require("execa"));
const prompts = __toESM(require("prompts"));
const ora = __toESM(require("ora"));
const child_process = __toESM(require("child_process"));
const fs = __toESM(require("fs"));
const path = __toESM(require("path"));
const url = __toESM(require("url"));
const pino = __toESM(require("pino"));
const zx = __toESM(require("zx"));
const azure_devops_node_api = __toESM(require("azure-devops-node-api"));
const azure_devops_node_api_interfaces_GitInterfaces = __toESM(require("azure-devops-node-api/interfaces/GitInterfaces"));

//#region src/git.ts
/**
* Get the current git branch name
*/
async function getCurrentBranch() {
	try {
		const result = await zx.$`git rev-parse --abbrev-ref HEAD`;
		return result.stdout.trim();
	} catch (error) {
		throw new Error(`Failed to get current branch: ${error}`);
	}
}
/**
* Get git remote URL
*/
async function getRemoteUrl() {
	try {
		const result = await zx.$`git remote get-url origin`;
		return result.stdout.trim();
	} catch (error) {
		throw new Error(`Failed to get remote URL: ${error}`);
	}
}
/**
* Parse Azure DevOps remote URL to extract organization, project, and repository
* Supports both HTTPS and SSH formats:
* - https://dev.azure.com/convergentis/CIS%20Planning/_git/repo
* - convergentis@vs-ssh.visualstudio.com:v3/convergentis/CIS%20Planning/repo
*/
function parseAzureDevOpsRemote(remoteUrl) {
	const httpsMatch = remoteUrl.match(/https:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_git\/([^\/]+)/);
	if (httpsMatch) return {
		organization: httpsMatch[1],
		project: decodeURIComponent(httpsMatch[2]),
		repository: httpsMatch[3]
	};
	const sshMatch = remoteUrl.match(/[^@]+@vs-ssh\.visualstudio\.com:v3\/([^\/]+)\/([^\/]+)\/([^\/]+)/);
	if (sshMatch) return {
		organization: sshMatch[1],
		project: decodeURIComponent(sshMatch[2]),
		repository: sshMatch[3]
	};
	throw new Error(`Unable to parse Azure DevOps remote URL: ${remoteUrl}. Expected format: https://dev.azure.com/org/project/_git/repo or org@vs-ssh.visualstudio.com:v3/org/project/repo`);
}
/**
* Check if the current directory is a git repository
*/
async function isGitRepository() {
	try {
		await zx.$`git rev-parse --git-dir`;
		return true;
	} catch {
		return false;
	}
}

//#endregion
//#region src/ado.ts
/**
* Create Azure DevOps connection
*/
function createConnection(orgUrl, token) {
	const authHandler = azure_devops_node_api.getPersonalAccessTokenHandler(token);
	return new azure_devops_node_api.WebApi(orgUrl, authHandler);
}
/**
* Get organization URL from organization name
*/
function getOrgUrl(organization) {
	return `https://dev.azure.com/${organization}`;
}
/**
* Find active pull request for the current branch
*/
async function findPullRequest(connection, remoteInfo, branchName) {
	try {
		const gitApi = await connection.getGitApi();
		const sourceRefName = `refs/heads/${branchName}`;
		console.log("findPullRequest - searching for PR with:", {
			repository: remoteInfo.repository,
			project: remoteInfo.project,
			sourceRefName,
			status: azure_devops_node_api_interfaces_GitInterfaces.PullRequestStatus.Active
		});
		let pullRequests = await gitApi.getPullRequests(remoteInfo.repository, {
			sourceRefName,
			status: azure_devops_node_api_interfaces_GitInterfaces.PullRequestStatus.Active
		}, remoteInfo.project);
		if (!pullRequests?.length) {
			console.log("No active PRs found, searching all statuses...");
			pullRequests = await gitApi.getPullRequests(remoteInfo.repository, { sourceRefName }, remoteInfo.project);
			console.log(`Found ${pullRequests?.length || 0} pull requests (all statuses)`);
			if (pullRequests?.length) pullRequests.forEach((pr$1, index) => {
				console.log(`PR ${index + 1}: ID=${pr$1.pullRequestId}, Status=${pr$1.status}, Title="${pr$1.title}"`);
			});
		}
		if (!pullRequests?.length) {
			console.log("No pull requests found for branch:", branchName);
			return null;
		}
		const pr = pullRequests[0];
		return pr;
	} catch (error) {
		console.error("findPullRequest error:", error);
		throw new Error(`Failed to find pull request: ${error}`);
	}
}

//#endregion
//#region src/claude-review.ts
const logger = (0, pino.default)({
	customLevels: { log: 30 },
	transport: {
		target: "pino-pretty",
		options: { colorize: true }
	}
});
const __filename$1 = (0, url.fileURLToPath)(require("url").pathToFileURL(__filename).href);
const __dirname$1 = path.default.dirname(__filename$1);
const program = new __commander_js_extra_typings.Command().name("claude-review").description("Review code changes using Claude Code").version("1.0.0").option("-d, --directory <path>", "Directory to review", process.cwd()).option("-c, --compare-branch <branch>", "Branch to compare against", "main").option("-p, --prompt-file <file>", "Custom prompt file", path.default.join(__dirname$1, "../pr-review-prompt.md")).option("--post", "Automatically post to Azure DevOps without asking").option("--no-post", "Skip posting to Azure DevOps (just show review)").option("--azure-pr <id>", "Azure DevOps PR ID (will auto-detect if not provided)").option("--use-env-vars", "Use environment variables instead of Azure CLI auto-detection").option("--use-existing-review", "Use existing claude-review.md file instead of running Claude again").option("--append", "Append to existing Claude review comment instead of replacing it").option("--new-comment", "Always create a new comment instead of updating existing one").option("--remove-review-file", "Remove the claude-review.md file after processing");
program.parse();
const options = program.opts();
async function main() {
	try {
		const spinner = (0, ora.default)("Starting Claude Code Review CLI").start();
		spinner.succeed("Claude Code Review CLI");
		logger.log(`Reviewing changes in: ${options.directory}`);
		logger.log(`Comparing against: ${options.compareBranch}`);
		process.chdir(options.directory);
		if (!fs.default.existsSync(".git")) {
			console.error("❌ Not a git repository");
			process.exit(1);
		}
		try {
			(0, child_process.execSync)(`git rev-parse --verify ${options.compareBranch}`, { stdio: "ignore" });
		} catch (error) {
			console.error(`❌ Branch '${options.compareBranch}' not found`);
			process.exit(1);
		}
		const diffSpinner = (0, ora.default)("Getting changes...").start();
		const gitDiff = await getGitDiff(options.compareBranch);
		diffSpinner.succeed("Changes retrieved");
		if (!gitDiff.trim()) {
			logger.log("✅ No changes to review");
			process.exit(0);
		}
		let reviewFile = path.default.join(process.cwd(), "claude-review.md");
		let review;
		if (options.useExistingReview && fs.default.existsSync(reviewFile)) {
			logger.log("📄 Using existing claude-review.md file...");
			review = processClaudeOutput(reviewFile);
		} else {
			const claudeSpinner = (0, ora.default)("Running Claude review...").start();
			reviewFile = await runClaudeCode(options.promptFile, gitDiff, options.compareBranch);
			claudeSpinner.succeed("Claude review completed");
			review = processClaudeOutput(reviewFile);
		}
		logger.log("\n✅ Review completed!\n");
		logger.log("=".repeat(50));
		logger.log(review);
		logger.log("=".repeat(50));
		logger.log(`Review saved to: ${reviewFile}`);
		logger.log(`options: ${JSON.stringify(options)}`);
		if (options.post !== false) {
			logger.log("Azure DevOps posting...");
			const azureConfig = await getAzureDevOpsConfig();
			if (azureConfig) {
				let shouldPost = options.post;
				if (!shouldPost) {
					logger.flush();
					const response = await (0, prompts.default)({
						type: "confirm",
						name: "post",
						message: `Post this review to Azure DevOps PR ${azureConfig.org}/${azureConfig.project} - PR #${azureConfig.prId}?`,
						initial: true
					});
					shouldPost = response.post;
				}
				if (shouldPost) await postToAzureDevOps(review, azureConfig);
			} else logger.log("⚠️  No Azure DevOps PR detected. Use --azure-pr <id> or set AZURE_DEVOPS_PR_ID");
		}
		if (options.removeReviewFile && fs.default.existsSync(reviewFile)) {
			fs.default.unlinkSync(reviewFile);
			logger.log("🗑️  Removed claude-review.md file");
		} else logger.log("📄 claude-review.md saved for reference");
	} catch (error) {
		console.error(`❌ Error: ${error.message}`);
		process.exit(1);
	}
}
async function getGitDiff(compareBranch) {
	try {
		let fullDiff;
		try {
			fullDiff = (0, child_process.execSync)(`git diff ${compareBranch}...HEAD`, {
				encoding: "utf8",
				maxBuffer: 50 * 1024 * 1024
			});
		} catch (bufferError) {
			const result = await execa.$`git diff ${compareBranch}...HEAD`;
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
			if (line.startsWith("diff --git")) skipFile = lockFiles.some((lockFile) => line.includes(lockFile));
			if (!skipFile) filteredLines.push(line);
		}
		return filteredLines.join("\n");
	} catch (error) {
		throw new Error(`Failed to get git diff: ${error.message}`);
	}
}
async function runClaudeCode(promptFile, gitDiff, compareBranch) {
	const reviewFile = path.default.join(process.cwd(), "claude-review.md");
	try {
		if (!fs.default.existsSync(promptFile)) throw new Error(`Prompt file not found: ${promptFile}`);
		const promptContent = fs.default.readFileSync(promptFile, "utf8");
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
		let claudePath = "claude";
		try {
			claudePath = (0, child_process.execSync)("which claude", { encoding: "utf8" }).trim();
		} catch (error) {
			const commonPaths = [
				process.env.HOME + "/.claude/local/claude",
				"/usr/local/bin/claude",
				process.env.HOME + "/.bun/bin/claude",
				process.env.HOME + "/.local/bin/claude"
			];
			for (const path$2 of commonPaths) if (fs.default.existsSync(path$2)) {
				claudePath = path$2;
				break;
			}
		}
		logger.log(`Using Claude at: ${claudePath}`);
		logger.log(`Prompt file: ${promptFile}`);
		logger.log(`Git diff: ${gitDiff}`);
		logger.log(`Compare branch: ${compareBranch}`);
		logger.log(`Prompt was: ${promptContent}`);
		const args = [
			"--allowedTools",
			"Bash(git *) Read Write Grep Glob TodoWrite",
			"--output-format",
			"json"
		];
		logger.log(`Running: ${claudePath} ${args.join(" ")}`);
		const result = await (0, execa.$)({
			input: fullPrompt,
			env: { ...process.env }
		})`${claudePath} ${args}`;
		const output = result.stdout;
		try {
			const result$1 = JSON.parse(output);
			displayClaudeMetrics(result$1);
		} catch (parseError) {
			logger.log("⚠️  Could not parse Claude metrics from output");
		}
		return reviewFile;
	} catch (error) {
		throw new Error(`Claude execution failed: ${error.message}`);
	}
}
function displayClaudeMetrics(result) {
	if (result && result.duration_ms && result.total_cost_usd !== void 0 && result.usage) {
		logger.log("\n📊 Claude Usage Metrics:");
		logger.log(`   Duration: ${result.duration_ms}ms`);
		logger.log(`   Total Cost: $${result.total_cost_usd.toFixed(6)}`);
		const usage = result.usage;
		if (usage.input_tokens) logger.log(`   Input Tokens: ${usage.input_tokens.toLocaleString()}`);
		if (usage.cache_read_input_tokens) logger.log(`   Cache Read Tokens: ${usage.cache_read_input_tokens.toLocaleString()}`);
		if (usage.output_tokens) logger.log(`   Output Tokens: ${usage.output_tokens.toLocaleString()}`);
	}
}
function processClaudeOutput(reviewFile) {
	if (!fs.default.existsSync(reviewFile)) throw new Error("Claude did not create the review file. Make sure Claude has write permissions.");
	try {
		const reviewContent = fs.default.readFileSync(reviewFile, "utf8");
		if (!reviewContent.trim()) throw new Error("Review file is empty");
		return reviewContent;
	} catch (error) {
		throw new Error(`Failed to read review file: ${error.message}`);
	}
}
async function getAzureDevOpsConfig() {
	if (options.useEnvVars) {
		logger.debug("Using environment variables as requested by --use-env-vars flag");
		return getConfigFromEnvVars();
	}
	try {
		logger.log("Trying git + API detection...");
		const azConfig = await getConfigFromGitAndApi();
		if (azConfig) {
			logger.debug("Successfully obtained Azure config from git + API: org=%s, project=%s, repo=%s, prId=%s", azConfig.org, azConfig.project, azConfig.repo, azConfig.prId);
			return azConfig;
		}
		logger.debug("getConfigFromGitAndApi() returned null - no config found");
	} catch (error) {
		logger.log("Git + API detection failed, trying Azure CLI...");
		logger.debug("getConfigFromGitAndApi() threw error: %s", error.message);
	}
	try {
		logger.log("Trying Azure CLI auto-detection...");
		logger.debug("Calling getConfigFromAzureCli()");
		const azConfig = await getConfigFromAzureCli();
		if (azConfig) {
			logger.debug("Successfully obtained Azure config from CLI: org=%s, project=%s, repo=%s, prId=%s", azConfig.org, azConfig.project, azConfig.repo, azConfig.prId);
			return azConfig;
		}
		logger.debug("getConfigFromAzureCli() returned null - no config found");
	} catch (error) {
		logger.log("Azure CLI detection failed, trying environment variables...");
		logger.debug("getConfigFromAzureCli() threw error: %s", error.message);
	}
	logger.debug("Falling back to environment variables");
	return getConfigFromEnvVars();
}
async function getConfigFromGitAndApi() {
	try {
		logger.debug("Starting getConfigFromGitAndApi()");
		const token = process.env.AZURE_DEVOPS_TOKEN;
		if (!token) {
			logger.debug("AZURE_DEVOPS_TOKEN not found");
			return null;
		}
		if (!await isGitRepository()) {
			logger.debug("Not in a git repository");
			return null;
		}
		const currentBranch = await getCurrentBranch();
		logger.debug("Current branch: %s", currentBranch);
		const remoteUrl = await getRemoteUrl();
		logger.debug("Remote URL: %s", remoteUrl);
		const remoteInfo = parseAzureDevOpsRemote(remoteUrl);
		logger.debug("Parsed remote info: org=%s, project=%s, repo=%s", remoteInfo.organization, remoteInfo.project, remoteInfo.repository);
		if (options.azurePr) {
			logger.debug("Using user-specified PR ID: %s", options.azurePr);
			return {
				token,
				org: remoteInfo.organization,
				project: remoteInfo.project,
				repo: remoteInfo.repository,
				prId: options.azurePr
			};
		}
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
			prId: pr.pullRequestId?.toString() || ""
		};
	} catch (error) {
		logger.debug("getConfigFromGitAndApi() error: %s", error.message);
		return null;
	}
}
function getConfigFromEnvVars() {
	const token = process.env.AZURE_DEVOPS_TOKEN;
	const org = process.env.AZURE_DEVOPS_ORG;
	const project = process.env.AZURE_DEVOPS_PROJECT;
	const repo = process.env.AZURE_DEVOPS_REPO;
	const prId = options.azurePr || process.env.AZURE_DEVOPS_PR_ID;
	if (!token || !org || !project || !repo || !prId) return null;
	return {
		token,
		org,
		project,
		repo,
		prId
	};
}
async function getConfigFromAzureCli() {
	try {
		logger.debug("Starting getConfigFromAzureCli()");
		logger.debug("Checking if Azure CLI is available");
		(0, child_process.execSync)("az --version", { stdio: "ignore" });
		logger.debug("Azure CLI is available");
		logger.debug("Getting current git branch");
		const currentBranch = (0, child_process.execSync)("git branch --show-current", { encoding: "utf8" }).trim();
		logger.debug("Current branch detected: %s", currentBranch);
		logger.debug("Fetching active PRs using Azure CLI auto-detection");
		const prListOutput = (0, child_process.execSync)(`az repos pr list --detect --status active --output json`, {
			encoding: "utf8",
			stdio: "pipe"
		});
		logger.debug("Raw PR list output received, length: %d", prListOutput.length);
		const prs = JSON.parse(prListOutput);
		logger.debug("Parsed PR list, count: %d", prs.length);
		if (prs.length === 0) {
			logger.debug("No active PRs found");
			if (options.azurePr) {
				logger.debug("User specified PR ID, fetching specific PR: %s", options.azurePr);
				const prOutput = (0, child_process.execSync)(`az repos pr show --detect --id ${options.azurePr} --output json`, {
					encoding: "utf8",
					stdio: "pipe"
				});
				const pr = JSON.parse(prOutput);
				logger.debug("Specific PR fetched successfully");
				return parseAzurePr(pr);
			}
			logger.debug("No PR ID specified, returning null");
			return null;
		}
		logger.debug("Looking for PR matching current branch: %s", currentBranch);
		const matchingPr = prs.find((pr) => {
			const branchName = pr.sourceRefName.replace("refs/heads/", "");
			logger.debug("Checking PR branch: %s against current: %s", branchName, currentBranch);
			return branchName === currentBranch;
		});
		if (matchingPr) {
			logger.debug("Found matching PR for current branch: prId=%s, sourceBranch=%s", matchingPr.pullRequestId, matchingPr.sourceRefName);
			return parseAzurePr(matchingPr);
		}
		logger.debug("No matching PR found for current branch");
		if (options.azurePr) {
			logger.debug("No matching PR but user specified PR ID, fetching specific PR: %s", options.azurePr);
			const prOutput = (0, child_process.execSync)(`az repos pr show --detect --id ${options.azurePr} --output json`, {
				encoding: "utf8",
				stdio: "pipe"
			});
			const pr = JSON.parse(prOutput);
			logger.debug("Specific PR fetched successfully");
			return parseAzurePr(pr);
		}
		logger.debug("No matching PR and no user-specified PR ID, returning null");
		return null;
	} catch (error) {
		logger.debug("getConfigFromAzureCli() caught error: %s", error.message);
		return null;
	}
}
function parseAzurePr(pr) {
	try {
		logger.debug("Starting parseAzurePr() for prId: %s", pr.pullRequestId);
		const prId = pr.pullRequestId.toString();
		const repo = pr.repository.name;
		const project = pr.repository.project.name;
		logger.debug("Extracted basic PR info: prId=%s, repo=%s, project=%s", prId, repo, project);
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
		logger.debug("Successfully created Azure config: org=%s, project=%s, repo=%s, prId=%s", org, project, repo, prId);
		return {
			token,
			org,
			project,
			repo,
			prId
		};
	} catch (error) {
		logger.log(`⚠️  Error parsing PR data: ${error.message}`);
		logger.debug("parseAzurePr() caught error: %s", error.message);
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
			for (const thread of threads.value || []) if (thread.comments && thread.comments.length > 0) {
				const firstComment = thread.comments[0];
				if (firstComment.content && firstComment.content.includes("# Claude Code Review")) return {
					threadId: thread.id,
					commentId: firstComment.id,
					existingContent: firstComment.content
				};
			}
		}
		return null;
	} catch (error) {
		logger.log(`Could not search for existing comments: ${error.message}`);
		return null;
	}
}
async function updateExistingComment(config, commentId, newContent) {
	const { token, org, project, repo, prId } = config;
	const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}/threads/${commentId}/comments/1?api-version=7.1`;
	const payload = { content: newContent };
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
		comments: [{
			parentCommentId: 0,
			content,
			commentType: 1
		}],
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
	const spinner = (0, ora.default)("Posting to Azure DevOps...").start();
	try {
		let response;
		let action = "posted";
		if (options.newComment) {
			const content = `# Claude Code Review\n\n${reviewContent}`;
			response = await createNewComment(config, content);
			action = "posted as new comment";
		} else {
			const existingComment = await findExistingClaudeComment(config);
			if (existingComment) {
				let newContent;
				if (options.append) {
					newContent = `${existingComment.existingContent}\n\n---\n\n**Updated Review:**\n\n${reviewContent}`;
					action = "appended to existing comment";
				} else {
					newContent = `# Claude Code Review\n\n${reviewContent}`;
					action = "updated existing comment";
				}
				response = await updateExistingComment(config, existingComment.threadId, newContent);
			} else {
				const content = `# Claude Code Review\n\n${reviewContent}`;
				response = await createNewComment(config, content);
				action = "posted new comment";
			}
		}
		if (response.statusCode >= 200 && response.statusCode < 300) spinner.succeed(`Successfully ${action} on Azure DevOps`);
		else {
			spinner.fail(`Failed to post review: ${response.statusCode} ${response.statusMessage}`);
			console.error("Response body:", response.body);
		}
	} catch (error) {
		spinner.fail(`Error posting to Azure DevOps: ${error.message}`);
	}
}
async function makeHttpRequest(url$1, options$1 = {}) {
	try {
		const fetchOptions = {
			method: options$1.method || "GET",
			headers: options$1.headers || {}
		};
		if (options$1.body) fetchOptions.body = options$1.body;
		const response = await fetch(url$1, fetchOptions);
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

//#endregion