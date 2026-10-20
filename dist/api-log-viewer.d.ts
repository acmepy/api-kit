import type { Router } from "express";

export interface ParsedLogLine {
  timestamp: string | null;
  level: string;
  source: string;
  scope: string | null;
  txId: string | null;
  message: string;
}
export interface LogViewerOptions {
  /** Directory containing .log files. Only direct children are listed. */
  directory: string;
  /** Entries per page, from 1 to 500. Default: 200. */
  pageSize?: number;
  /** Return null for a continuation of the previous entry. */
  parseLine?: (line: string) => ParsedLogLine | null;
}
export function createLogViewer(options: LogViewerOptions): Router;
export function parseLogLine(line: string): ParsedLogLine | null;
