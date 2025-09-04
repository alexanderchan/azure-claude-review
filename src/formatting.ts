import chalk from "chalk";

/**
 * Format success message
 */
export function formatSuccess(message: string): string {
  return chalk.green(`✓ ${message}`);
}

/**
 * Format error message
 */
export function formatError(message: string): string {
  return chalk.red(`✗ ${message}`);
}

/**
 * Format warning message
 */
export function formatWarning(message: string): string {
  return chalk.yellow(`⚠ ${message}`);
}

/**
 * Format info message
 */
export function formatInfo(message: string): string {
  return chalk.blue(`ℹ ${message}`);
}

/**
 * Format dry run message
 */
export function formatDryRun(message: string): string {
  return chalk.cyan(`[DRY RUN] ${message}`);
}

/**
 * Format section header
 */
export function formatHeader(message: string): string {
  return chalk.bold.underline(message);
}

/**
 * Format key-value pair
 */
export function formatKeyValue(key: string, value?: string): string {
  return `${chalk.bold(key)}: ${value}`;
}
