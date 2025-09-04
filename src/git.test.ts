import { describe, it, expect, vi, beforeEach } from "vitest";
import { $ } from "zx";
import {
  getCurrentBranch,
  extractWorkItemId,
  getRemoteUrl,
  parseAzureDevOpsRemote,
  isGitRepository,
} from "./git.js";

// Mock zx
vi.mock("zx", () => ({
  $: vi.fn(),
}));

const mockZx = vi.mocked($);

describe("git utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCurrentBranch", () => {
    it("should return the current branch name", async () => {
      mockZx.mockResolvedValue({
        stdout: "feature/64805-add-feature\n",
        stderr: "",
        exitCode: 0,
      } as any);

      const result = await getCurrentBranch();
      expect(result).toBe("feature/64805-add-feature");
      expect(mockZx).toHaveBeenCalledWith`git rev-parse --abbrev-ref HEAD`;
    });

    it("should throw error when git command fails", async () => {
      mockZx.mockRejectedValue(new Error("Not a git repository"));

      await expect(getCurrentBranch()).rejects.toThrow(
        "Failed to get current branch"
      );
    });
  });

  describe("extractWorkItemId", () => {
    it("should extract work item ID from branch name starting with digits", () => {
      expect(extractWorkItemId("64805/add-feature")).toBe("64805");
      expect(extractWorkItemId("12345-fix-bug")).toBe("12345");
      expect(extractWorkItemId("9999/feature/something")).toBe("9999");
    });

    it("should return null for branch names without work item ID", () => {
      expect(extractWorkItemId("feature/add-something")).toBeNull();
      expect(extractWorkItemId("main")).toBeNull();
      expect(extractWorkItemId("123-too-short")).toBeNull(); // Less than 4 digits
    });

    it("should require minimum 4 digits", () => {
      expect(extractWorkItemId("123/feature")).toBeNull();
      expect(extractWorkItemId("1234/feature")).toBe("1234");
    });
  });

  describe("getRemoteUrl", () => {
    it("should return the remote URL", async () => {
      const mockUrl =
        "https://dev.azure.com/convergentis/CIS%20Planning/_git/repo";
      mockZx.mockResolvedValue({
        stdout: `${mockUrl}\n`,
        stderr: "",
        exitCode: 0,
      } as any);

      const result = await getRemoteUrl();
      expect(result).toBe(mockUrl);
      expect(mockZx).toHaveBeenCalledWith`git remote get-url origin`;
    });

    it("should throw error when git command fails", async () => {
      mockZx.mockRejectedValue(new Error("No remote configured"));

      await expect(getRemoteUrl()).rejects.toThrow("Failed to get remote URL");
    });
  });

  describe("parseAzureDevOpsRemote", () => {
    it("should parse HTTPS Azure DevOps URL", () => {
      const url =
        "https://dev.azure.com/convergentis/CIS%20Planning/_git/PGW-TemplateBuilder-BTP";
      const result = parseAzureDevOpsRemote(url);

      expect(result).toEqual({
        organization: "convergentis",
        project: "CIS Planning", // URL decoded
        repository: "PGW-TemplateBuilder-BTP",
      });
    });

    it("should parse SSH Azure DevOps URL", () => {
      const url =
        "convergentis@vs-ssh.visualstudio.com:v3/convergentis/CIS Planning/PGW-TemplateBuilder-BTP";
      const result = parseAzureDevOpsRemote(url);

      expect(result).toEqual({
        organization: "convergentis",
        project: "CIS Planning",
        repository: "PGW-TemplateBuilder-BTP",
      });
    });

    it("should handle URL encoded project names", () => {
      const url = "https://dev.azure.com/myorg/My%20Project%20Name/_git/repo";
      const result = parseAzureDevOpsRemote(url);

      expect(result.project).toBe("My Project Name");
    });

    it("should throw error for invalid URLs", () => {
      expect(() =>
        parseAzureDevOpsRemote("https://github.com/user/repo")
      ).toThrow("Unable to parse Azure DevOps remote URL");
      expect(() => parseAzureDevOpsRemote("invalid-url")).toThrow(
        "Unable to parse Azure DevOps remote URL"
      );
    });
  });

  describe("isGitRepository", () => {
    it("should return true when in a git repository", async () => {
      mockZx.mockResolvedValue({
        stdout: ".git\n",
        stderr: "",
        exitCode: 0,
      } as any);

      const result = await isGitRepository();
      expect(result).toBe(true);
      expect(mockZx).toHaveBeenCalledWith`git rev-parse --git-dir`;
    });

    it("should return false when not in a git repository", async () => {
      mockZx.mockRejectedValue(new Error("Not a git repository"));

      const result = await isGitRepository();
      expect(result).toBe(false);
    });
  });
});
