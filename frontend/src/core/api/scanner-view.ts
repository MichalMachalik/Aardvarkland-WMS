import { asArray, asRecord, finiteNumber, nonBlankText, textOr } from './response-values';

export interface ScannerView {
  id: string;
  code: string;
  name: string;
  status: string;
  assignedZone: string | null;
  assignedWorkerId: string | null;
  batteryLevel: number | null;
  signalStrength: number | null;
  lastActivityAt: string | null;
}

export function mapScanners(payload: unknown): ScannerView[] {
  const rows = Array.isArray(payload) ? payload : asArray(asRecord(payload)['data']);
  const scanners: ScannerView[] = [];
  for (const value of rows) {
    const row = asRecord(value);
    const code = nonBlankText(row['code']);
    if (!code) continue;

    const metadata = asRecord(row['metadata']);
    scanners.push({
      id: textOr(row['id'], code),
      code,
      name: textOr(row['name'], code),
      status: textOr(row['status'], 'INACTIVE'),
      assignedZone: nonBlankText(row['assignedZone']),
      assignedWorkerId: nonBlankText(row['assignedWorkerId'] ?? metadata['assignedWorkerId']),
      batteryLevel: readPercent(row['batteryLevel'] ?? metadata['batteryLevel']),
      signalStrength: readPercent(row['signalStrength'] ?? metadata['signalStrength']),
      lastActivityAt: readTimestamp(row['lastActivityAt'])
        ?? readTimestamp(metadata['lastActivityAt'])
        ?? readTimestamp(row['lastSeenAt']),
    });
  }
  return scanners;
}

function readPercent(value: unknown): number | null {
  const percent = finiteNumber(value);
  return percent !== null && Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

function readTimestamp(value: unknown): string | null {
  const timestamp = nonBlankText(value);
  return timestamp !== null && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}
