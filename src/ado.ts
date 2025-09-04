import * as azdev from "azure-devops-node-api";
import { GitApi } from "azure-devops-node-api/GitApi";
import { WorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi";
import {
  GitPullRequest,
  PullRequestStatus,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import { WorkItem } from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces";
import { GitRemoteInfo } from "./git.js";

export interface PullRequestInfo {
  id: number;
  title: string;
  status: PullRequestStatus;
  artifactId: string;
  workItemRefs: Array<{ id: string; url: string }>;
  repository: {
    id: string;
    project: {
      id: string;
    };
  };
}

/**
 * Create Azure DevOps connection
 */
export function createConnection(orgUrl: string, token: string): azdev.WebApi {
  const authHandler = azdev.getPersonalAccessTokenHandler(token);
  return new azdev.WebApi(orgUrl, authHandler);
}

/**
 * Get organization URL from organization name
 */
export function getOrgUrl(organization: string): string {
  return `https://dev.azure.com/${organization}`;
}

/**
 * Find active pull request for the current branch
 */
export async function findPullRequest(
  connection: azdev.WebApi,
  remoteInfo: GitRemoteInfo,
  branchName: string
) {
  try {
    const gitApi = await connection.getGitApi();
    const sourceRefName = `refs/heads/${branchName}`;

    console.log("findPullRequest - searching for PR with:", {
      repository: remoteInfo.repository,
      project: remoteInfo.project,
      sourceRefName,
      status: PullRequestStatus.Active,
    });

    // First try with Active status filter (like your working curl command)
    let pullRequests = await gitApi.getPullRequests(
      remoteInfo.repository,
      {
        sourceRefName,
        status: PullRequestStatus.Active, // Re-enabled status filter
      },
      remoteInfo.project
    );

    console.log(`Found ${pullRequests?.length || 0} active pull requests`);
    console.dir(pullRequests);
    // If no active PRs found, try without status filter to see all PRs
    if (!pullRequests?.length) {
      console.log("No active PRs found, searching all statuses...");
      pullRequests = await gitApi.getPullRequests(
        remoteInfo.repository,
        {
          sourceRefName,
        },
        remoteInfo.project
      );
      console.log(
        `Found ${pullRequests?.length || 0} pull requests (all statuses)`
      );

      if (pullRequests?.length) {
        pullRequests.forEach((pr, index) => {
          console.log(
            `PR ${index + 1}: ID=${pr.pullRequestId}, Status=${
              pr.status
            }, Title="${pr.title}"`
          );
        });
      }
    }

    if (!pullRequests?.length) {
      console.log("No pull requests found for branch:", branchName);
      return null;
    }

    const pr = pullRequests[0];
    console.dir("Using PR:", {
      id: pr.pullRequestId,
      title: pr.title,
      status: pr.status,
      sourceRefName: pr.sourceRefName,
      pr,
    });

    return pr;
  } catch (error) {
    console.error("findPullRequest error:", error);
    throw new Error(`Failed to find pull request: ${error}`);
  }
}

/**
 * Create a new pull request
 */
export async function createPullRequest(
  connection: azdev.WebApi,
  remoteInfo: GitRemoteInfo,
  branchName: string,
  workItemId?: string
) {
  try {
    const gitApi: GitApi = await connection.getGitApi();

    // Get default branch (usually main or master)
    const repository = await gitApi.getRepository(
      remoteInfo.repository,
      remoteInfo.project
    );
    const defaultBranch = repository.defaultBranch || "refs/heads/main";

    const title = workItemId
      ? `${workItemId}: ${branchName.replace(/^\d+\//, "")}`
      : branchName;

    const pullRequestToCreate: GitPullRequest = {
      sourceRefName: `refs/heads/${branchName}`,
      targetRefName: defaultBranch,
      title,
      description: workItemId
        ? `Automated PR creation for work item ${workItemId}`
        : "Automated PR creation",
    };

    const createdPr = await gitApi.createPullRequest(
      pullRequestToCreate,
      remoteInfo.repository,
      remoteInfo.project
    );

    return createdPr;
  } catch (error) {
    throw new Error(`Failed to create pull request: ${error}`);
  }
}

/**
 * Check if work item exists
 */
export async function workItemExists(
  connection: azdev.WebApi,
  workItemId: string
): Promise<boolean> {
  try {
    const witApi: WorkItemTrackingApi =
      await connection.getWorkItemTrackingApi();
    await witApi.getWorkItem(parseInt(workItemId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract work item ID from PR title
 * Looks for a sequence of at least 4 digits at the beginning of the title
 */
export function extractWorkItemFromPRTitle(title?: string): string | null {
  const match = title?.match(/^(\d{4,})/);
  return match ? match[1] : null;
}

/**
 * Check if work item is already linked to PR
 */
export function isWorkItemLinked(
  pr: GitPullRequest,
  workItemId: string
): boolean {
  return pr.workItemRefs?.some((ref) => ref.id === workItemId) || false;
}

function getPrUrl({
  projectId,
  repoId,
  prNumber,
}: {
  projectId?: string;
  repoId?: string;
  prNumber?: number;
}) {
  return `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${prNumber}`;
}
/**
 * Link work item to pull request
 */
export async function linkWorkItemToPR(
  connection: azdev.WebApi,
  workItemId: string,
  pr: GitPullRequest
): Promise<void> {
  try {
    const witApi: WorkItemTrackingApi =
      await connection.getWorkItemTrackingApi();

    const prUrl = getPrUrl({
      projectId: pr?.repository?.project?.id,
      repoId: pr?.repository?.id,
      prNumber: pr?.pullRequestId,
    });

    const patchDocument = [
      {
        op: "add",
        path: "/relations/-",
        value: {
          attributes: {
            name: "Pull Request",
          },
          rel: "ArtifactLink",
          url: prUrl,
        },
      },
    ];

    await witApi.updateWorkItem(undefined, patchDocument, parseInt(workItemId));
  } catch (error) {
    throw new Error(`Failed to link work item to PR: ${error}`);
  }
}

/**
 * Main function to update work item with PR link
 */
export async function updateWorkItem(
  remoteInfo: GitRemoteInfo,
  branchName: string,
  workItemId: string,
  token: string,
  dryRun: boolean = false
): Promise<{
  success: boolean;
  message: string;
  pr?: GitPullRequest;
  workItemExists?: boolean;
}> {
  const orgUrl = getOrgUrl(remoteInfo.organization);
  const connection = createConnection(orgUrl, token);

  try {
    // Check if work item exists
    const workItemExistsResult = await workItemExists(connection, workItemId);
    if (!workItemExistsResult) {
      return {
        success: false,
        message: `Work item ${workItemId} does not exist`,
        workItemExists: false,
      };
    }

    // Find existing PR
    let pr = await findPullRequest(connection, remoteInfo, branchName);

    if (!pr) {
      return {
        success: false,
        message: `No active pull request found for branch ${branchName}`,
        workItemExists: true,
      };
    }

    // Check if work item is already linked
    if (isWorkItemLinked(pr, workItemId)) {
      return {
        success: true,
        message: `Work item ${workItemId} is already linked to PR ${pr?.pullRequestId}`,
        pr,
        workItemExists: true,
      };
    }

    // Link work item to PR
    if (!dryRun) {
      await linkWorkItemToPR(connection, workItemId, pr);
    }

    return {
      success: true,
      message: dryRun
        ? `[DRY RUN] Would link work item ${workItemId} to PR ${pr?.pullRequestId}`
        : `Successfully linked work item ${workItemId} to PR ${pr?.pullRequestId}`,
      pr,
      workItemExists: true,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to update work item: ${error}`,
    };
  }
}
