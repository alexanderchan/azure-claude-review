# Claude Code Review CLI

A command-line tool to review code changes using Claude Code and optionally post reviews to Azure DevOps PRs.

## Installation

### From this repository:

```bash
# Clone the repo and install the CLI tool locally
git clone <repo-url>
cd claude-code-action/cli-tool
npm install
npm link
```

### Prerequisites

- Node.js 14+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally:
  ```bash
  bun install -g @anthropic-ai/claude-code@latest
  ```
- Git repository with changes to review
- `ANTHROPIC_API_KEY` environment variable set

## Usage

### Basic Usage

```bash
# Review changes in current directory against main branch
claude-review

# Review specific directory
claude-review -d /path/to/project

# Compare against different branch
claude-review -c develop

# Use custom prompt file
claude-review -p /path/to/custom-prompt.md
```

### Azure DevOps Integration

Set environment variables:

```bash
export AZURE_DEVOPS_TOKEN="your-pat-token"
```

Or use CLI options:

```bash
claude-review --azure-org myorg --azure-project myproject --azure-repo myrepo --azure-pr 123
```

The tool will ask for confirmation before posting to Azure DevOps.

### Comment Behavior

By default, the tool uses **sticky comments** - it will find and update any existing "Claude Code Review" comment instead of creating multiple comments.

- **Default**: `claude-review` → Updates existing comment (or creates new if none exists)
- **Append**: `claude-review --append` → Adds new review to existing comment with separator
- **New Comment**: `claude-review --new-comment` → Always creates a new comment thread

### Options

```
Options:
  -V, --version                    output the version number
  -d, --directory <path>           Directory to review (default: current directory)
  -c, --compare-branch <branch>    Branch to compare against (default: "main")
  -p, --prompt-file <file>         Custom prompt file (default: built-in prompt)
  --no-post                        Skip posting to Azure DevOps (just show review)
  --azure-pr <id>                  Azure DevOps PR ID (will auto-detect if not provided)
  --use-env-vars                   Use environment variables instead of Azure CLI auto-detection
  --use-existing-review            Use existing claude-review.md file instead of running Claude again
  --append                         Append to existing Claude review comment instead of replacing it
  --new-comment                    Always create a new comment instead of updating existing one
  -h, --help                       display help for command
```

## Environment Variables

| Variable            | Description            | Required |
| ------------------- | ---------------------- | -------- |
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Yes      |

## Azure DevOps Environment Variables

These should all be derived if logged on with `az` cli.

| Variable               | Description                        | Required                    |
| ---------------------- | ---------------------------------- | --------------------------- |
| `AZURE_DEVOPS_TOKEN`   | Azure DevOps Personal Access Token | For posting to Azure DevOps |
| `AZURE_DEVOPS_ORG`     | Azure DevOps organization name     | For posting to Azure DevOps |
| `AZURE_DEVOPS_PROJECT` | Azure DevOps project name          | For posting to Azure DevOps |
| `AZURE_DEVOPS_REPO`    | Azure DevOps repository name       | For posting to Azure DevOps |
| `AZURE_DEVOPS_PR_ID`   | Pull Request ID number             | For posting to Azure DevOps |

## Examples

```bash
# Simple review of current changes
claude-review

# Just show review, don't post anywhere
claude-review --no-post
```

## How it works

1. **Git Diff**: Generates diff between current branch and target branch
2. **Context Creation**: Creates markdown context file with changes
3. **Claude Review**: Runs Claude Code with the prompt and context
4. **Display Results**: Shows the review in terminal with nice formatting
5. **Optional Posting**: Asks user if they want to post to Azure DevOps PR

## Customizing the Prompt

Create your own prompt file and use it with `-p`:

```markdown
# my-custom-prompt.md

Please review this code focusing on:

- Security vulnerabilities
- Performance issues
- Code maintainability

Be extra strict about error handling.
```

```bash
claude-review -p my-custom-prompt.md
```
