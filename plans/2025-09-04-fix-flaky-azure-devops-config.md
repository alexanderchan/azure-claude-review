# Fix Flaky Azure DevOps Configuration Detection

**Date:** 2025-09-04
**Status:** ✅ Completed

## Problem

The `getAzureDevOpsConfig` function in `claude-review.ts` was flaky because it relied solely on Azure CLI auto-detection, which can be unreliable in various environments and scenarios.

## Solution

Implemented a more robust PR detection system using a layered approach:

1. **Primary Method: Git + API Detection** (`getConfigFromGitAndApi`)

   - Uses git commands to detect current branch and remote URL
   - Parses Azure DevOps remote URL to extract organization, project, and repository
   - Uses Azure DevOps APIs directly to find PRs for the current branch
   - More reliable than Azure CLI auto-detection

2. **Fallback Method: Azure CLI Auto-detection** (existing `getConfigFromAzureCli`)

   - Kept as fallback for compatibility
   - Uses `az repos pr list --detect` commands

3. **Final Fallback: Environment Variables** (existing `getConfigFromEnvVars`)
   - Uses explicit environment variables when other methods fail

## Implementation Details

### New Function: `getConfigFromGitAndApi()`

```typescript
async function getConfigFromGitAndApi(): Promise<AzureConfig | null> {
  // 1. Check for AZURE_DEVOPS_TOKEN
  // 2. Verify we're in a git repository
  // 3. Get current branch using git commands
  // 4. Parse remote URL to extract Azure DevOps info
  // 5. Use Azure DevOps APIs to find PR for current branch
  // 6. Return configuration or null if not found
}
```

### Updated Detection Order

```typescript
async function getAzureDevOpsConfig(): Promise<AzureConfig | null> {
  if (options.useEnvVars) return getConfigFromEnvVars();

  try {
    // 1. Try git + API detection (NEW - most reliable)
    const config = await getConfigFromGitAndApi();
    if (config) return config;
  } catch (error) {
    // Log and continue to fallback
  }

  try {
    // 2. Fallback to Azure CLI auto-detection
    const config = await getConfigFromAzureCli();
    if (config) return config;
  } catch (error) {
    // Log and continue to final fallback
  }

  // 3. Final fallback to environment variables
  return getConfigFromEnvVars();
}
```

## Benefits

1. **More Reliable**: Uses git commands and direct API calls instead of relying on Azure CLI auto-detection
2. **Better Error Handling**: Graceful fallbacks when methods fail
3. **Existing Compatibility**: Maintains all existing functionality and command-line options
4. **Improved Logging**: Better debug information for troubleshooting

## Testing

- ✅ All existing tests pass (26/26)
- ✅ Build completes successfully
- ✅ No breaking changes to existing functionality
- ✅ Maintains backward compatibility

## Files Modified

- `src/claude-review.ts`: Updated `getAzureDevOpsConfig()` and added `getConfigFromGitAndApi()`
- Added imports for git utilities: `getCurrentBranch`, `getRemoteUrl`, `parseAzureDevOpsRemote`, `isGitRepository`
- Added imports for ADO utilities: `createConnection`, `getOrgUrl`, `findPullRequest`

## Usage

The changes are transparent to users. The tool will now:

1. First try the new reliable git + API detection method
2. Fall back to Azure CLI if that fails
3. Finally use environment variables as the last resort

Users can still force specific methods using existing flags:

- `--use-env-vars`: Skip detection and use environment variables only
- `--azure-pr <id>`: Specify PR ID explicitly

## Future Improvements

- Could add unit tests specifically for `getConfigFromGitAndApi()`
- Could add metrics/telemetry to track which detection method succeeds most often
- Could add caching to avoid repeated API calls in the same session
