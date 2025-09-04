import { describe, it, expect, vi, beforeEach } from "vitest";
import * as azdev from "azure-devops-node-api";
import { PullRequestStatus } from "azure-devops-node-api/interfaces/GitInterfaces";
import {
  createConnection,
  getOrgUrl,
  extractWorkItemFromPRTitle,
  isWorkItemLinked,
  updateWorkItem,
} from "./ado.js";
import type { PullRequestInfo } from "./ado.js";

// Mock azure-devops-node-api
vi.mock("azure-devops-node-api", () => ({
  getPersonalAccessTokenHandler: vi.fn(),
  WebApi: vi.fn(),
}));

const mockWebApi = {
  getGitApi: vi.fn(),
  getWorkItemTrackingApi: vi.fn(),
};

const mockGitApi = {
  getPullRequests: vi.fn(),
  createPullRequest: vi.fn(),
  getRepository: vi.fn(),
};

const mockWitApi = {
  getWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
};

describe("ado utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(azdev.WebApi).mockImplementation(() => mockWebApi as any);
    mockWebApi.getGitApi.mockResolvedValue(mockGitApi);
    mockWebApi.getWorkItemTrackingApi.mockResolvedValue(mockWitApi);
  });

  describe("createConnection", () => {
    it("should create Azure DevOps connection", () => {
      const mockAuthHandler = { token: "test-token" };
      vi.mocked(azdev.getPersonalAccessTokenHandler).mockReturnValue(
        mockAuthHandler as any
      );

      const result = createConnection(
        "https://dev.azure.com/org",
        "test-token"
      );

      expect(azdev.getPersonalAccessTokenHandler).toHaveBeenCalledWith(
        "test-token"
      );
      expect(azdev.WebApi).toHaveBeenCalledWith(
        "https://dev.azure.com/org",
        mockAuthHandler
      );
      expect(result).toBe(mockWebApi);
    });
  });

  describe("getOrgUrl", () => {
    it("should return organization URL", () => {
      expect(getOrgUrl("convergentis")).toBe(
        "https://dev.azure.com/convergentis"
      );
      expect(getOrgUrl("myorg")).toBe("https://dev.azure.com/myorg");
    });
  });

  describe("extractWorkItemFromPRTitle", () => {
    it("should extract work item ID from PR title", () => {
      expect(extractWorkItemFromPRTitle("64805: Add new feature")).toBe(
        "64805"
      );
      expect(extractWorkItemFromPRTitle("12345-Fix bug")).toBe("12345");
      expect(extractWorkItemFromPRTitle("9999 Update documentation")).toBe(
        "9999"
      );
    });

    it("should return null for titles without work item ID", () => {
      expect(extractWorkItemFromPRTitle("Add new feature")).toBeNull();
      expect(extractWorkItemFromPRTitle("Fix: something")).toBeNull();
      expect(extractWorkItemFromPRTitle("123: too short")).toBeNull(); // Less than 4 digits
    });

    it("should require minimum 4 digits", () => {
      expect(extractWorkItemFromPRTitle("123: feature")).toBeNull();
      expect(extractWorkItemFromPRTitle("1234: feature")).toBe("1234");
    });
  });

  describe("isWorkItemLinked", () => {
    it("should return true when work item is linked", () => {
      const pr: PullRequestInfo = {
        id: 123,
        title: "Test PR",
        status: PullRequestStatus.Active,
        artifactId: "test-artifact",
        workItemRefs: [
          {
            id: "64805",
            url: "https://dev.azure.com/org/_apis/wit/workItems/64805",
          },
          {
            id: "64806",
            url: "https://dev.azure.com/org/_apis/wit/workItems/64806",
          },
        ],
        repository: {
          id: "repo-id",
          project: { id: "project-id" },
        },
      };

      expect(isWorkItemLinked(pr, "64805")).toBe(true);
      expect(isWorkItemLinked(pr, "64806")).toBe(true);
    });

    it("should return false when work item is not linked", () => {
      const pr: PullRequestInfo = {
        id: 123,
        title: "Test PR",
        status: PullRequestStatus.Active,
        artifactId: "test-artifact",
        workItemRefs: [
          {
            id: "64805",
            url: "https://dev.azure.com/org/_apis/wit/workItems/64805",
          },
        ],
        repository: {
          id: "repo-id",
          project: { id: "project-id" },
        },
      };

      expect(isWorkItemLinked(pr, "64806")).toBe(false);
      expect(isWorkItemLinked(pr, "99999")).toBe(false);
    });

    it("should handle empty work item refs", () => {
      const pr: PullRequestInfo = {
        id: 123,
        title: "Test PR",
        status: PullRequestStatus.Active,
        artifactId: "test-artifact",
        workItemRefs: [],
        repository: {
          id: "repo-id",
          project: { id: "project-id" },
        },
      };

      expect(isWorkItemLinked(pr, "64805")).toBe(false);
    });
  });

  describe("updateWorkItem", () => {
    const mockRemoteInfo = {
      organization: "convergentis",
      project: "CIS Planning",
      repository: "test-repo",
    };

    const mockPr: PullRequestInfo = {
      id: 4966,
      title: "64805: Test PR",
      status: PullRequestStatus.Active,
      artifactId: "vstfs:///Git/PullRequestId/project-id%2frepo-id%2f4966",
      workItemRefs: [],
      repository: {
        id: "repo-id",
        project: { id: "project-id" },
      },
    };

    it("should return error when work item does not exist", async () => {
      mockWitApi.getWorkItem.mockRejectedValue(
        new Error("Work item not found")
      );

      const result = await updateWorkItem(
        mockRemoteInfo,
        "64805/test-branch",
        "64805",
        "test-token",
        false
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe("Work item 64805 does not exist");
      expect(result.workItemExists).toBe(false);
    });

    it("should return error when no PR found", async () => {
      mockWitApi.getWorkItem.mockResolvedValue({ id: 64805 });
      mockGitApi.getPullRequests.mockResolvedValue([]);

      const result = await updateWorkItem(
        mockRemoteInfo,
        "64805/test-branch",
        "64805",
        "test-token",
        false
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        "No active pull request found for branch 64805/test-branch"
      );
      expect(result.workItemExists).toBe(true);
    });

    it("should return success when work item already linked", async () => {
      mockWitApi.getWorkItem.mockResolvedValue({ id: 64805 });

      const linkedPr = {
        ...mockPr,
        workItemRefs: [{ id: "64805", url: "test-url" }],
      };

      mockGitApi.getPullRequests.mockResolvedValue([
        {
          pullRequestId: linkedPr.id,
          title: linkedPr.title,
          status: linkedPr.status,
          artifactId: linkedPr.artifactId,
          workItemRefs: [{ id: "64805", url: "test-url" }],
          repository: {
            id: linkedPr.repository.id,
            project: { id: linkedPr.repository.project.id },
          },
        },
      ]);

      const result = await updateWorkItem(
        mockRemoteInfo,
        "64805/test-branch",
        "64805",
        "test-token",
        false
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe(
        "Work item 64805 is already linked to PR 4966"
      );
      expect(result.workItemExists).toBe(true);
    });

    it("should link work item to PR successfully", async () => {
      mockWitApi.getWorkItem.mockResolvedValue({ id: 64805 });
      mockWitApi.updateWorkItem.mockResolvedValue({ id: 64805 });

      mockGitApi.getPullRequests.mockResolvedValue([
        {
          pullRequestId: mockPr.id,
          title: mockPr.title,
          status: mockPr.status,
          artifactId: mockPr.artifactId,
          workItemRefs: [],
          repository: {
            id: mockPr.repository.id,
            project: { id: mockPr.repository.project.id },
          },
        },
      ]);

      const result = await updateWorkItem(
        mockRemoteInfo,
        "64805/test-branch",
        "64805",
        "test-token",
        false
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe(
        "Successfully linked work item 64805 to PR 4966"
      );
      expect(result.workItemExists).toBe(true);
      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        undefined,
        [
          {
            op: "add",
            path: "/relations/-",
            value: {
              attributes: { name: "Pull Request" },
              rel: "ArtifactLink",
              url: mockPr.artifactId,
            },
          },
        ],
        64805
      );
    });

    it("should handle dry run mode", async () => {
      mockWitApi.getWorkItem.mockResolvedValue({ id: 64805 });

      mockGitApi.getPullRequests.mockResolvedValue([
        {
          pullRequestId: mockPr.id,
          title: mockPr.title,
          status: mockPr.status,
          artifactId: mockPr.artifactId,
          workItemRefs: [],
          repository: {
            id: mockPr.repository.id,
            project: { id: mockPr.repository.project.id },
          },
        },
      ]);

      const result = await updateWorkItem(
        mockRemoteInfo,
        "64805/test-branch",
        "64805",
        "test-token",
        true // dry run
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe(
        "[DRY RUN] Would link work item 64805 to PR 4966"
      );
      expect(result.workItemExists).toBe(true);
      expect(mockWitApi.updateWorkItem).not.toHaveBeenCalled();
    });
  });
});
