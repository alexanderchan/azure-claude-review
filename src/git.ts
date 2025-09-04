import { $ } from "zx";

export interface GitRemoteInfo {
  organization: string;
  project: string;
  repository: string;
}

/**
 * Get the current git branch name
 */
export async function getCurrentBranch(): Promise<string> {
  try {
    const result = await $`git rev-parse --abbrev-ref HEAD`;
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get current branch: ${error}`);
  }
}

/**
 * Extract work item ID from branch name
 * Looks for the first sequence of digits (minimum 4 digits)
 */
export function extractWorkItemId(branchName: string): string | null {
  const match = branchName.match(/^(\d{4,})/);
  return match ? match[1] : null;
}

/**
 * Get git remote URL
 */
export async function getRemoteUrl(): Promise<string> {
  try {
    const result = await $`git remote get-url origin`;
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
export function parseAzureDevOpsRemote(remoteUrl: string): GitRemoteInfo {
  // HTTPS format
  const httpsMatch = remoteUrl.match(
    /https:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_git\/([^\/]+)/
  );
  if (httpsMatch) {
    return {
      organization: httpsMatch[1],
      project: decodeURIComponent(httpsMatch[2]),
      repository: httpsMatch[3],
    };
  }

  // SSH format
  const sshMatch = remoteUrl.match(
    /[^@]+@vs-ssh\.visualstudio\.com:v3\/([^\/]+)\/([^\/]+)\/([^\/]+)/
  );
  if (sshMatch) {
    return {
      organization: sshMatch[1],
      project: decodeURIComponent(sshMatch[2]),
      repository: sshMatch[3],
    };
  }

  throw new Error(
    `Unable to parse Azure DevOps remote URL: ${remoteUrl}. Expected format: https://dev.azure.com/org/project/_git/repo or org@vs-ssh.visualstudio.com:v3/org/project/repo`
  );
}

/**
 * Check if the current directory is a git repository
 */
export async function isGitRepository(): Promise<boolean> {
  try {
    await $`git rev-parse --git-dir`;
    return true;
  } catch {
    return false;
  }
}
