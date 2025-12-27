/**
 * SMI-583: Logging utility for MCP server
 * Logs errors to ~/.skillsmith/logs/
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(homedir(), '.skillsmith', 'logs');

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Format date for log filename
 */
function getLogFilename(): string {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0];
  return join(LOG_DIR, 'mcp-server-' + dateStr + '.log');
}

/**
 * Format log entry
 */
function formatLogEntry(level: string, message: string, details?: unknown): string {
  const timestamp = new Date().toISOString();
  let entry = '[' + timestamp + '] [' + level + '] ' + message;

  if (details !== undefined) {
    try {
      entry += '\n  Details: ' + JSON.stringify(details, null, 2).replace(/\n/g, '\n  ');
    } catch {
      entry += '\n  Details: [Unable to serialize]';
    }
  }

  return entry + '\n';
}

/**
 * Write log entry to file
 */
function writeLog(level: string, message: string, details?: unknown): void {
  try {
    ensureLogDir();
    const entry = formatLogEntry(level, message, details);
    appendFileSync(getLogFilename(), entry);
  } catch {
    // Silently fail if unable to write logs
    // Don't want logging failures to break the application
  }
}

/**
 * Logger interface
 */
export const logger = {
  info(message: string, details?: unknown): void {
    writeLog('INFO', message, details);
  },

  warn(message: string, details?: unknown): void {
    writeLog('WARN', message, details);
  },

  error(message: string, details?: unknown): void {
    writeLog('ERROR', message, details);
  },

  debug(message: string, details?: unknown): void {
    if (process.env.DEBUG) {
      writeLog('DEBUG', message, details);
    }
  },
};

export default logger;
