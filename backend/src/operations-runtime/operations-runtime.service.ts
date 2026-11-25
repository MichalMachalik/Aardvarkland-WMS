import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';

import { AuthenticatedUser } from '../access-control/types';
import { PrismaService, withTransactionRetry } from '../database';
import type { Prisma } from '../generated/prisma/client';
import { LabelsService } from '../labels/labels.service';
import { escapeZplFieldData } from '../labels/zpl-renderer.helpers';
import {
  RuntimeConnector,
  RuntimeIntegrationCommandCenter,
  RuntimeIntegrationEvent,
  RuntimeIntegrationState,
  RuntimeOperationRule,
  RuntimeRfConsole,
  RuntimeRfException,
  RuntimeRfResult,
  RuntimeRfScanEvent,
  RuntimeRfSession,
  RuntimeRuleEvaluation,
  RuntimeRuleType,
} from './operations-runtime.types';
import {
  RuntimeIntegrationEventApplyDto,
  RuntimeIntegrationEventIngestDto,
  RuntimePrintLabelTestDto,
  RuntimeReconciliationRunDto,
  RuntimeRfExceptionDto,
  RuntimeRfOfflineReplayDto,
  RuntimeRfScanDto,
  RuntimeRuleEvaluationDto,
  RuntimeRuleUpsertDto,
  StartRuntimeRfSessionDto,
} from './dto/operations-runtime.dto';

interface RfSessionRow {
  id: string;
  warehouse_id: string;
  device_code: string;
  worker_code: string;
  flow: string;
  state: string;
  current_step: string;
  offline_queue: unknown;
  last_error: string | null;
  started_at: Date | string;
  last_seen_at: Date | string;
}

interface RfScanRow {
  id: string;
  warehouse_id: string;
  session_id: string | null;
  device_code: string;
  task_reference: string | null;
  step_key: string;
  scanned_value: string;
  expected_value: string | null;
  result: RuntimeRfResult;
  offline_id: string | null;
  quantity: number | null;
  metadata: unknown;
  created_at: Date | string;
}

interface RfScanOutcome {
  result: RuntimeRfResult;
  accepted: boolean;
  instruction: string;
  event: RuntimeRfScanEvent;
}

const mismatchInstruction = 'Scan mismatch. Show exception choices: retry scan, short-pick, supervisor override.';

interface RfExceptionRow {
  id: string;
  warehouse_id: string;
  session_id: string | null;
  device_code: string;
  task_reference: string | null;
  code: string;
  title: string;
  status: string;
  severity: string;
  metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface IntegrationEventRow {
  id: string;
  warehouse_id: string;
  connector_code: string;
  flow: string;
  state: RuntimeIntegrationState;
  external_id: string;
  attempts: number;
  max_attempts: number;
  retry_after: Date | string | null;
  payload: unknown;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReconciliationRow {
  id: string;
  warehouse_id: string;
  connector_code: string | null;
  status: string;
  mismatches: number;
  summary: unknown;
  created_at: Date | string;
}

interface OperationRuleRow {
  id: string;
  warehouse_id: string;
  code: string;
  name: string;
  type: RuntimeRuleType;
  enabled: boolean;
  priority: number;
  scope: unknown;
  conditions: unknown;
  actions: unknown;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class OperationsRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly labels: LabelsService,
  ) {}

  async getRfConsole(warehouseId: string): Promise<RuntimeRfConsole> {
    await this.ensureTables();

    const [sessions, recentScans, exceptions] = await Promise.all([
      this.query<RfSessionRow>(
        `SELECT * FROM ops_rf_sessions
         WHERE warehouse_id = $1 AND state IN ('ACTIVE', 'OFFLINE', 'BLOCKED')
         ORDER BY last_seen_at DESC LIMIT 12`,
        warehouseId,
      ),
      this.query<RfScanRow>(
        `SELECT * FROM ops_rf_scan_events
         WHERE warehouse_id = $1
         ORDER BY created_at DESC LIMIT 25`,
        warehouseId,
      ),
      this.query<RfExceptionRow>(
        `SELECT * FROM ops_rf_exceptions
         WHERE warehouse_id = $1 AND status IN ('OPEN', 'ESCALATED')
         ORDER BY created_at DESC LIMIT 20`,
        warehouseId,
      ),
    ]);

    const queued = sessions.reduce((sum, session) => sum + offlineQueueLength(session.offline_queue), 0);

    return {
      warehouseId,
      profile: {
        scannerFocusLock: true,
        offlineQueue: true,
        fallbackMode: false,
        supervisorUnlock: true,
        recommendedDevice: sessions[0]?.device_code ?? '',
      },
      activeSessions: sessions.map(toRfSession),
      recentScans: recentScans.map(toRfScanEvent),
      exceptionQueue: exceptions.map(toRfException),
      nextInstruction: {
        stepKey: 'SCAN_LOCATION',
        label: 'Scan location first',
        expectedExample: '',
        helpText: 'Scan-first screen keeps focus in the scan input and supports offline replay.',
      },
      offlineQueue: {
        queued,
        replayable: queued + recentScans.filter((scan) => scan.result === RuntimeRfResult.MISMATCH).length,
        duplicateProtected: true,
        policy: 'An offline scan is stored once per device and action ID. Repeat submissions retain the original outcome.',
      },
    };
  }

  async startRfSession(
    warehouseId: string,
    dto: StartRuntimeRfSessionDto,
  ): Promise<RuntimeRfSession> {
    await this.ensureTables();
    const rows = await this.query<RfSessionRow>(
      `INSERT INTO ops_rf_sessions
        (warehouse_id, device_code, worker_code, flow, state, current_step, offline_queue, last_error)
       VALUES ($1, $2, $3, $4, 'ACTIVE', 'SCAN_LOCATION', '[]'::jsonb, NULL)
       RETURNING *`,
      warehouseId,
      dto.deviceCode.trim(),
      dto.workerCode.trim(),
      dto.flow?.trim() || 'WAVE_PICK',
    );

    return toRfSession(required(rows, 'RF session was not created'));
  }

  async submitRfScan(warehouseId: string, dto: RuntimeRfScanDto): Promise<RfScanOutcome> {
    await this.ensureTables();
    return withTransactionRetry(() => this.prisma.$transaction(tx => this.storeRfScan(tx, warehouseId, dto)));
  }

  private async storeRfScan(tx: Prisma.TransactionClient, warehouseId: string, dto: RuntimeRfScanDto): Promise<RfScanOutcome> {
    const deviceCode = dto.deviceCode.trim();
    const sessionId = await this.lockRfSession(tx, warehouseId, deviceCode, dto.sessionId);
    const taskReference = dto.taskReference || null;
    const stepKey = dto.stepKey.trim();
    const scannedValue = dto.scannedValue.trim();
    const expectedValue = dto.expectedValue || null;
    const offlineId = dto.offlineId || null;
    const quantity = dto.quantity ?? null;
    const result = isExpected(dto.scannedValue, dto.expectedValue)
      ? RuntimeRfResult.ACCEPTED
      : RuntimeRfResult.MISMATCH;

    const rows = await tx.$queryRawUnsafe<RfScanRow[]>(
      `INSERT INTO ops_rf_scan_events
        (warehouse_id, session_id, device_code, task_reference, step_key, scanned_value, expected_value, result, offline_id, quantity, metadata)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (warehouse_id, device_code, offline_id) WHERE offline_id IS NOT NULL DO NOTHING
       RETURNING *`,
      warehouseId,
      sessionId,
      deviceCode,
      taskReference,
      stepKey,
      scannedValue,
      expectedValue,
      result,
      offlineId,
      quantity,
      json(dto.metadata),
    );

    const stored = rows[0];
    if (!stored) {
      const existing = required(await tx.$queryRawUnsafe<RfScanRow[]>(
        `SELECT * FROM ops_rf_scan_events WHERE warehouse_id = $1 AND device_code = $2 AND offline_id = $3`,
        warehouseId, deviceCode, offlineId,
      ), 'Offline scan was not found');
      if (existing.session_id !== sessionId || existing.task_reference !== taskReference
        || existing.step_key !== stepKey || existing.scanned_value !== scannedValue
        || existing.expected_value !== expectedValue || existing.quantity !== quantity) {
        throw new ConflictException('This offline scan ID belongs to a different scan.');
      }
      const accepted = existing.result === RuntimeRfResult.ACCEPTED;
      return {
        result: accepted ? RuntimeRfResult.DUPLICATE : existing.result,
        accepted,
        instruction: accepted ? 'This offline scan has already been recorded.' : mismatchInstruction,
        event: toRfScanEvent(existing),
      };
    }

    const event = toRfScanEvent(stored);
    if (sessionId) {
      await tx.$executeRawUnsafe(
        `UPDATE ops_rf_sessions
         SET last_seen_at = now(),
             current_step = CASE WHEN state <> 'BLOCKED' AND current_step = $3 AND $4::text IS NULL THEN $5 ELSE current_step END,
             last_error = CASE WHEN state = 'BLOCKED' THEN last_error ELSE $4 END
         WHERE warehouse_id = $1 AND id = $2::uuid`,
        warehouseId,
        sessionId,
        stepKey,
        result === RuntimeRfResult.MISMATCH ? 'SCAN_MISMATCH' : null,
        nextRfStep(stepKey, result),
      );
    }

    if (result === RuntimeRfResult.MISMATCH) {
      await tx.$executeRawUnsafe(
        `INSERT INTO ops_rf_exceptions
          (warehouse_id, session_id, device_code, task_reference, code, title, status, severity, metadata)
         VALUES ($1, $2::uuid, $3, $4, 'SCAN_MISMATCH', $5, 'OPEN', 'HIGH', $6::jsonb)`,
        warehouseId,
        sessionId,
        deviceCode,
        taskReference,
        `Expected ${expectedValue ?? 'configured value'}, scanned ${scannedValue}`,
        json({ scanEventId: event.id, stepKey }),
      );
    }

    return {
      result,
      accepted: result === RuntimeRfResult.ACCEPTED,
      instruction:
        result === RuntimeRfResult.ACCEPTED
          ? `${nextRfStep(stepKey, result)} ready. Continue.`
          : mismatchInstruction,
      event,
    };
  }

  async replayRfOfflineQueue(warehouseId: string, dto: RuntimeRfOfflineReplayDto): Promise<{
    warehouseId: string;
    deviceCode: string;
    accepted: number;
    duplicates: number;
    rejected: number;
    results: Array<{ offlineId: string | null; result: RuntimeRfResult }>;
  }> {
    await this.ensureTables();
    return withTransactionRetry(() => this.prisma.$transaction(async tx => {
      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      const results: Array<{ offlineId: string | null; result: RuntimeRfResult }> = [];
      for (const action of dto.actions) {
        const outcome = await this.storeRfScan(tx, warehouseId, { ...action, deviceCode: action.deviceCode || dto.deviceCode });
        if (outcome.result === RuntimeRfResult.ACCEPTED) accepted += 1;
        else if (outcome.result === RuntimeRfResult.DUPLICATE) duplicates += 1;
        else rejected += 1;
        results.push({ offlineId: outcome.event.offlineId, result: outcome.result });
      }
      return { warehouseId, deviceCode: dto.deviceCode, accepted, duplicates, rejected, results };
    }));
  }

  async reportRfException(
    warehouseId: string,
    dto: RuntimeRfExceptionDto,
  ): Promise<RuntimeRfException> {
    await this.ensureTables();
    return withTransactionRetry(() => this.prisma.$transaction(async tx => {
      const deviceCode = dto.deviceCode.trim();
      const sessionId = await this.lockRfSession(tx, warehouseId, deviceCode, dto.sessionId);
      const code = dto.code.trim().toUpperCase();
      const rows = await tx.$queryRawUnsafe<RfExceptionRow[]>(
        `INSERT INTO ops_rf_exceptions
          (warehouse_id, session_id, device_code, task_reference, code, title, status, severity, metadata)
         VALUES ($1, $2::uuid, $3, NULLIF($4, ''), $5, $6, 'OPEN', $7, $8::jsonb)
         RETURNING *`,
        warehouseId,
        sessionId,
        deviceCode,
        dto.taskReference ?? '',
        code,
        dto.title?.trim() || defaultExceptionTitle(code),
        dto.severity?.trim().toUpperCase() || 'MEDIUM',
        json({
          releaseReservation: dto.releaseReservation ?? false,
          supervisorPinPresent: Boolean(dto.supervisorPin),
          metadata: dto.metadata ?? null,
        }),
      );

      if (sessionId) {
        await tx.$executeRawUnsafe(
          `UPDATE ops_rf_sessions
           SET state = 'BLOCKED', last_error = $3, last_seen_at = now()
           WHERE warehouse_id = $1 AND id = $2::uuid`,
          warehouseId, sessionId, code,
        );
      }
      return toRfException(required(rows, 'RF exception was not stored'));
    }));
  }

  private async lockRfSession(
    tx: Prisma.TransactionClient, warehouseId: string, deviceCode: string, sessionId?: string,
  ): Promise<string | null> {
    if (!sessionId) return null;
    if (!isUUID(sessionId)) throw new BadRequestException('RF session ID must be a UUID.');
    const sessions = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM ops_rf_sessions WHERE warehouse_id = $1 AND device_code = $2 AND id = $3::uuid FOR UPDATE`,
      warehouseId, deviceCode, sessionId,
    );
    return required(sessions, 'RF session was not found for this device').id;
  }

  async getIntegrationCommandCenter(warehouseId: string): Promise<RuntimeIntegrationCommandCenter> {
    await this.ensureTables();

    const [events, reconciliations] = await Promise.all([
      this.query<IntegrationEventRow>(
        `SELECT * FROM ops_integration_events
         WHERE warehouse_id = $1
         ORDER BY updated_at DESC LIMIT 50`,
        warehouseId,
      ),
      this.query<ReconciliationRow>(
        `SELECT * FROM ops_reconciliation_runs
         WHERE warehouse_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        warehouseId,
      ),
    ]);

    const eventModels = events.map(toIntegrationEvent);
    const connectors = buildConnectors(eventModels);
    const lastRun = reconciliations[0];

    return {
      warehouseId,
      connectors,
      events: eventModels,
      deadLetterCount: eventModels.filter((event) => event.state === RuntimeIntegrationState.DEAD_LETTER).length,
      retryableCount: eventModels.filter((event) => event.state === RuntimeIntegrationState.DEAD_LETTER || event.state === RuntimeIntegrationState.WAITING).length,
      reconciliation: {
        lastRunAt: lastRun ? isoString(lastRun.created_at) : null,
        status: lastRun?.status ?? 'NOT_RUN',
        mismatches: lastRun?.mismatches ?? 0,
        nextRunHint: 'Run reconciliation after connector retry or before end-of-day billing export.',
      },
      productionChecklist: [
        { code: 'erp-map', label: 'ERP/e-shop ID mapping exists', status: 'ok' },
        { code: 'webhook-retry', label: 'Webhook retry + dead-letter queue enabled', status: 'ok' },
        { code: 'carrier-label', label: 'Carrier labels/manifest tested', status: 'watch' },
        { code: 'print-proof', label: 'Physical printer proof uploaded', status: hasEnv('PRINT_RAW_9100_HOST') ? 'ok' : 'missing' },
        { code: 'edi-ack', label: 'EDI 940/945/846 ACK lifecycle', status: 'watch' },
      ],
    };
  }

  async ingestIntegrationEvent(warehouseId: string, dto: RuntimeIntegrationEventIngestDto): Promise<RuntimeIntegrationEvent> {
    await this.ensureTables();
    const connectorCode = dto.connectorCode.trim().toUpperCase();
    const flow = dto.flow.trim();
    const externalId = dto.externalId.trim();
    if (!connectorCode || !flow || !externalId) {
      throw new BadRequestException('Connector code, flow, and external ID must not be blank');
    }
    const state = normalizeIntegrationState(dto.state);
    const rows = await this.query<IntegrationEventRow>(
      `INSERT INTO ops_integration_events
        (warehouse_id, connector_code, flow, state, external_id, attempts, max_attempts, retry_after, payload, last_error)
       VALUES ($1, $2, $3, $4, $5, 0, $6, CASE WHEN $4 IN ('WAITING','RETRYING') THEN now() ELSE NULL END, $7::jsonb, NULL)
       ON CONFLICT (warehouse_id, connector_code, flow, external_id) DO UPDATE SET
         state = EXCLUDED.state,
         max_attempts = EXCLUDED.max_attempts,
         retry_after = EXCLUDED.retry_after,
         payload = EXCLUDED.payload,
         last_error = NULL,
         updated_at = now()
       WHERE ops_integration_events.state <> 'APPLIED'
       RETURNING *`,
      warehouseId,
      connectorCode,
      flow,
      state,
      externalId,
      dto.maxAttempts ?? 5,
      json({
        ...(dto.payload ?? {}),
        ingestedAt: new Date().toISOString(),
        source: 'operations-runtime',
      }),
    );

    const event = rows[0] ?? await this.findIntegrationEventByExternalId(warehouseId, connectorCode, flow, externalId);
    return toIntegrationEvent(event);
  }

  async applyIntegrationEvent(
    warehouseId: string,
    eventId: string,
    dto: RuntimeIntegrationEventApplyDto,
  ): Promise<RuntimeIntegrationEvent> {
    this.assertIntegrationEventId(eventId);
    await this.ensureTables();
    const rows = await this.query<IntegrationEventRow>(
      `UPDATE ops_integration_events
       SET state = 'APPLIED',
           attempts = attempts + 1,
           retry_after = NULL,
           last_error = NULL,
           payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE warehouse_id = $1 AND id = $2::uuid AND state <> 'APPLIED'
       RETURNING *`,
      warehouseId,
      eventId,
      json({
        appliedAt: new Date().toISOString(),
        mapping: dto.mapping ?? null,
        note: dto.note ?? null,
      }),
    );

    return toIntegrationEvent(rows[0] ?? await this.findIntegrationEvent(warehouseId, eventId));
  }

  async testPrintLabel(warehouseId: string, dto: RuntimePrintLabelTestDto, actor: AuthenticatedUser): Promise<{
    event: RuntimeIntegrationEvent;
    dryRun: boolean;
    stationCode: string;
    zplPreview: string;
    instruction: string;
    printJobId: string | null;
  }> {
    await this.ensureTables();
    const dryRun = dto.dryRun !== false;
    const flow = dryRun ? 'label.print.preview' : 'label.print';
    const connectorCode = dto.connectorCode?.trim().toUpperCase() || 'PRINT';
    const stationCode = dto.stationCode?.trim().toUpperCase() || 'PACK-01';
    const reference = dto.reference?.trim() || `PRINT-TEST-${Date.now()}`;
    const templateCode = dto.templateCode?.trim().toUpperCase() || 'SAMPLE_ZPL';
    const printableReference = escapeZplFieldData(reference);
    const zplPreview = `^XA^FO40,40^A0N,34,34^FDWMS TEST ${printableReference}^FS^FO40,95^BY2^BCN,80,Y,N,N^FD${printableReference}^FS^XZ`;
    let printJobId: string | null = null;
    if (!dryRun) {
      const permissions = actor.warehouses.find(item => item.warehouseId === warehouseId || item.warehouseCode === warehouseId)?.permissionCodes;
      if (!permissions?.some(permission => permission === 'label.print' || permission === '*')) {
        throw new ForbiddenException('Missing required warehouse print permission');
      }
      const jobKey = createHash('sha256').update(json([connectorCode, reference])).digest('hex');
      const job = await this.labels.createRuntimePrintJob(warehouseId, {
        printerCode: stationCode,
        templateCode,
        renderedZpl: zplPreview,
        idempotencyKey: `integration-print-test-${jobKey}`,
        payload: { connectorCode, reference },
      }, actor);
      printJobId = job.id;
    }
    const rows = await this.query<IntegrationEventRow>(
      `INSERT INTO ops_integration_events
        (warehouse_id, connector_code, flow, state, external_id, attempts, max_attempts, payload, last_error)
       VALUES ($1, $2, $3, $4, $5, 1, 3, $6::jsonb, NULL)
       ON CONFLICT (warehouse_id, connector_code, flow, external_id) DO UPDATE SET
         state = EXCLUDED.state,
         attempts = ops_integration_events.attempts + 1,
         payload = EXCLUDED.payload,
         updated_at = now(),
         last_error = NULL
       WHERE ops_integration_events.payload IS DISTINCT FROM EXCLUDED.payload
       RETURNING *`,
      warehouseId,
      connectorCode,
      flow,
      dryRun ? RuntimeIntegrationState.APPLIED : RuntimeIntegrationState.WAITING,
      reference,
      json({ stationCode, templateCode, dryRun, zplPreview, printJobId }),
    );

    const event = rows[0] ?? await this.findIntegrationEventByExternalId(warehouseId, connectorCode, flow, reference);
    return {
      event: toIntegrationEvent(event),
      dryRun,
      stationCode,
      zplPreview,
      printJobId,
      instruction: dryRun
        ? 'Dry-run label rendered and stored without sending data to a physical printer.'
        : 'Print test was queued for the configured printer.',
    };
  }

  async retryIntegrationEvent(warehouseId: string, eventId: string): Promise<RuntimeIntegrationEvent> {
    this.assertIntegrationEventId(eventId);
    await this.ensureTables();
    const rows = await this.query<IntegrationEventRow>(
      `WITH retry AS (
         SELECT id, max_attempts,
           CASE WHEN state = 'DEAD_LETTER' THEN 1 ELSE LEAST(attempts::bigint + 1, max_attempts)::integer END AS attempts
         FROM ops_integration_events
         WHERE warehouse_id = $1 AND id = $2::uuid AND state <> 'APPLIED'
         FOR UPDATE
       )
       UPDATE ops_integration_events AS event
       SET attempts = retry.attempts,
           state = CASE WHEN retry.attempts >= retry.max_attempts THEN 'DEAD_LETTER' ELSE 'RETRYING' END,
           retry_after = CASE WHEN retry.attempts < retry.max_attempts THEN now() + interval '2 minutes' ELSE NULL END,
           updated_at = now(),
           last_error = CASE WHEN retry.attempts >= retry.max_attempts THEN event.last_error ELSE NULL END
       FROM retry WHERE event.id = retry.id
       RETURNING event.*`,
      warehouseId,
      eventId,
    );

    if (!rows[0]) {
      await this.findIntegrationEvent(warehouseId, eventId);
      throw new ConflictException('An applied integration event cannot be retried');
    }
    return toIntegrationEvent(rows[0]);
  }

  private assertIntegrationEventId(eventId: string): void {
    if (!isUUID(eventId)) throw new BadRequestException('Integration event ID must be a UUID');
  }

  private async findIntegrationEvent(warehouseId: string, eventId: string): Promise<IntegrationEventRow> {
    const rows = await this.query<IntegrationEventRow>(
      'SELECT * FROM ops_integration_events WHERE warehouse_id = $1 AND id = $2::uuid',
      warehouseId,
      eventId,
    );
    return required(rows, 'Integration event was not found');
  }

  private async findIntegrationEventByExternalId(
    warehouseId: string,
    connectorCode: string,
    flow: string,
    externalId: string,
  ): Promise<IntegrationEventRow> {
    const rows = await this.query<IntegrationEventRow>(
      `SELECT * FROM ops_integration_events
       WHERE warehouse_id = $1 AND connector_code = $2 AND flow = $3 AND external_id = $4`,
      warehouseId,
      connectorCode,
      flow,
      externalId,
    );
    return required(rows, 'Integration event was not found');
  }

  async runReconciliation(warehouseId: string, dto: RuntimeReconciliationRunDto): Promise<{
    id: string;
    warehouseId: string;
    connectorCode: string | null;
    status: string;
    mismatches: number;
    summary: Record<string, unknown>;
    createdAt: string;
  }> {
    await this.ensureTables();
    const connectorCode = dto.connectorCode?.trim().toUpperCase() || null;
    const flow = dto.flow?.trim() || null;
    const events = await this.query<IntegrationEventRow>(
      `SELECT * FROM ops_integration_events
       WHERE warehouse_id = $1 AND ($2::text IS NULL OR connector_code = $2)
         AND ($3::text IS NULL OR flow = $3)`,
      warehouseId,
      connectorCode,
      flow,
    );
    const dead = events.filter((event) => event.state === RuntimeIntegrationState.DEAD_LETTER).length;
    const waiting = events.filter((event) => event.state === RuntimeIntegrationState.WAITING || event.state === RuntimeIntegrationState.RETRYING).length;
    const mismatches = dead + Math.max(0, waiting - 1);
    const status = mismatches > 2 ? 'ATTENTION_REQUIRED' : mismatches > 0 ? 'WATCH' : 'MATCHED';
    const summary = {
      dryRun: dto.dryRun ?? true,
      flow: flow ?? 'all',
      checked: events.length,
      deadLetters: dead,
      waiting,
      advice: mismatches ? 'Resolve dead letters and re-run reconciliation.' : 'No mismatches found.',
    };
    const rows = await this.query<ReconciliationRow>(
      `INSERT INTO ops_reconciliation_runs
        (warehouse_id, connector_code, status, mismatches, summary)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      warehouseId,
      connectorCode,
      status,
      mismatches,
      json(summary),
    );
    const row = required(rows, 'Reconciliation run was not stored');
    return {
      id: row.id,
      warehouseId: row.warehouse_id,
      connectorCode: row.connector_code,
      status: row.status,
      mismatches: row.mismatches,
      summary: asRecord(row.summary),
      createdAt: isoString(row.created_at),
    };
  }

  async listRules(warehouseId: string, type?: RuntimeRuleType): Promise<RuntimeOperationRule[]> {
    await this.ensureTables();
    const rows = await this.query<OperationRuleRow>(
      `SELECT * FROM ops_operation_rules
       WHERE warehouse_id = $1 AND ($2::text IS NULL OR type = $2)
       ORDER BY type ASC, priority DESC, code ASC`,
      warehouseId,
      type ?? null,
    );
    return rows.map(toOperationRule);
  }

  async upsertRule(warehouseId: string, dto: RuntimeRuleUpsertDto): Promise<RuntimeOperationRule> {
    await this.ensureTables();
    const rows = await this.query<OperationRuleRow>(
      `INSERT INTO ops_operation_rules
        (warehouse_id, code, name, type, enabled, priority, scope, conditions, actions, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       ON CONFLICT (warehouse_id, code) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         enabled = EXCLUDED.enabled,
         priority = EXCLUDED.priority,
         scope = EXCLUDED.scope,
         conditions = EXCLUDED.conditions,
         actions = EXCLUDED.actions,
         notes = EXCLUDED.notes,
         updated_at = now()
       RETURNING *`,
      warehouseId,
      dto.code.trim().toUpperCase(),
      dto.name.trim(),
      dto.type,
      dto.enabled ?? true,
      dto.priority ?? 50,
      json(dto.scope),
      json(dto.conditions),
      json(dto.actions),
      dto.notes?.trim() || null,
    );
    return toOperationRule(required(rows, 'Operation rule was not saved'));
  }

  async evaluateRules(
    warehouseId: string,
    dto: RuntimeRuleEvaluationDto,
  ): Promise<RuntimeRuleEvaluation> {
    const rules = await this.listRules(warehouseId);
    const allowedTypes = new Set(dto.ruleTypes ?? Object.values(RuntimeRuleType));
    const matchedRules = rules.filter((rule) => rule.enabled && allowedTypes.has(rule.type)
      && matchesContext(rule.scope, dto.context) && matchesContext(rule.conditions, dto.context));

    return {
      warehouseId,
      evaluatedAt: new Date().toISOString(),
      context: dto.context,
      matchedRules,
      recommendedActions: matchedRules.map((rule) => ({ ruleCode: rule.code, action: rule.actions })),
    };
  }

  private async ensureTables(): Promise<void> {
    await this.exec(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await this.exec(`CREATE TABLE IF NOT EXISTS ops_rf_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id text NOT NULL,
      device_code text NOT NULL,
      worker_code text NOT NULL,
      flow text NOT NULL,
      state text NOT NULL,
      current_step text NOT NULL,
      offline_queue jsonb NOT NULL DEFAULT '[]'::jsonb,
      last_error text,
      started_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.exec(`CREATE INDEX IF NOT EXISTS ops_rf_sessions_scope_idx ON ops_rf_sessions (warehouse_id, device_code, state, last_seen_at DESC)`);
    await this.exec(`CREATE TABLE IF NOT EXISTS ops_rf_scan_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id text NOT NULL,
      session_id uuid,
      device_code text NOT NULL,
      task_reference text,
      step_key text NOT NULL,
      scanned_value text NOT NULL,
      expected_value text,
      result text NOT NULL,
      offline_id text,
      quantity integer,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ops_rf_scan_events_offline_key ON ops_rf_scan_events (warehouse_id, device_code, offline_id) WHERE offline_id IS NOT NULL`);
    await this.exec(`CREATE INDEX IF NOT EXISTS ops_rf_scan_events_scope_idx ON ops_rf_scan_events (warehouse_id, created_at DESC)`);
    await this.exec(`CREATE TABLE IF NOT EXISTS ops_rf_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id text NOT NULL,
      session_id uuid,
      device_code text NOT NULL,
      task_reference text,
      code text NOT NULL,
      title text NOT NULL,
      status text NOT NULL,
      severity text NOT NULL,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.exec(`CREATE INDEX IF NOT EXISTS ops_rf_exceptions_scope_idx ON ops_rf_exceptions (warehouse_id, status, severity, created_at DESC)`);
    await this.exec(`CREATE TABLE IF NOT EXISTS ops_integration_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id text NOT NULL,
      connector_code text NOT NULL,
      flow text NOT NULL,
      state text NOT NULL,
      external_id text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      retry_after timestamptz,
      payload jsonb,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.exec(`CREATE INDEX IF NOT EXISTS ops_integration_events_scope_idx ON ops_integration_events (warehouse_id, state, updated_at DESC)`);
    await this.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ops_integration_events_external_key ON ops_integration_events (warehouse_id, connector_code, flow, external_id)`);
    await this.exec(`CREATE TABLE IF NOT EXISTS ops_reconciliation_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id text NOT NULL,
      connector_code text,
      status text NOT NULL,
      mismatches integer NOT NULL DEFAULT 0,
      summary jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.exec(`CREATE INDEX IF NOT EXISTS ops_reconciliation_runs_scope_idx ON ops_reconciliation_runs (warehouse_id, created_at DESC)`);
    await this.exec(`CREATE TABLE IF NOT EXISTS ops_operation_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id text NOT NULL,
      code text NOT NULL,
      name text NOT NULL,
      type text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      priority integer NOT NULL DEFAULT 50,
      scope jsonb NOT NULL DEFAULT '{}'::jsonb,
      conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
      actions jsonb NOT NULL DEFAULT '{}'::jsonb,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, code)
    )`);
    await this.exec(`CREATE INDEX IF NOT EXISTS ops_operation_rules_scope_idx ON ops_operation_rules (warehouse_id, type, enabled, priority DESC)`);
  }

  private query<T>(query: string, ...params: unknown[]): Promise<T[]> {
    return this.prisma.$queryRawUnsafe<T[]>(query, ...params);
  }

  private async exec(query: string, ...params: unknown[]): Promise<void> {
    await this.prisma.$executeRawUnsafe(query, ...params);
  }
}

function toRfSession(row: RfSessionRow): RuntimeRfSession {
  return {
    id: row.id,
    warehouseId: row.warehouse_id,
    deviceCode: row.device_code,
    workerCode: row.worker_code,
    flow: row.flow,
    state: row.state,
    currentStep: row.current_step,
    queuedOfflineActions: offlineQueueLength(row.offline_queue),
    lastError: row.last_error,
    startedAt: isoString(row.started_at),
    lastSeenAt: isoString(row.last_seen_at),
  };
}

function toRfScanEvent(row: RfScanRow): RuntimeRfScanEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    deviceCode: row.device_code,
    taskReference: row.task_reference,
    stepKey: row.step_key,
    scannedValue: row.scanned_value,
    expectedValue: row.expected_value,
    result: row.result,
    offlineId: row.offline_id,
    quantity: row.quantity,
    createdAt: isoString(row.created_at),
  };
}

function toRfException(row: RfExceptionRow): RuntimeRfException {
  return {
    id: row.id,
    sessionId: row.session_id,
    deviceCode: row.device_code,
    taskReference: row.task_reference,
    code: row.code,
    title: row.title,
    status: row.status,
    severity: row.severity,
    createdAt: isoString(row.created_at),
  };
}

function toIntegrationEvent(row: IntegrationEventRow): RuntimeIntegrationEvent {
  return {
    id: row.id,
    connectorCode: row.connector_code,
    flow: row.flow,
    state: row.state,
    externalId: row.external_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    retryAfter: row.retry_after ? isoString(row.retry_after) : null,
    lastError: row.last_error,
    updatedAt: isoString(row.updated_at),
  };
}

function toOperationRule(row: OperationRuleRow): RuntimeOperationRule {
  return {
    id: row.id,
    warehouseId: row.warehouse_id,
    code: row.code,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    priority: row.priority,
    scope: asRecord(row.scope),
    conditions: asRecord(row.conditions),
    actions: asRecord(row.actions),
    notes: row.notes,
    updatedAt: isoString(row.updated_at),
  };
}

function buildConnectors(events: RuntimeIntegrationEvent[]): RuntimeConnector[] {
  const connectorCodes = [...new Set(events.map((event) => event.connectorCode).filter(Boolean))]
    .filter((code) => !isPlaceholderConnectorCode(code));

  return connectorCodes.map((code) => {
    const ownEvents = events.filter((event) => event.connectorCode === code);
    const deadLetters = ownEvents.filter((event) => event.state === RuntimeIntegrationState.DEAD_LETTER).length;
    const openEvents = ownEvents.filter((event) => event.state !== RuntimeIntegrationState.APPLIED).length;

    return {
      code,
      title: humanizeConnectorCode(code),
      category: connectorCategoryFromCode(code),
      mode: 'LIVE',
      health: deadLetters > 0 ? 'DEGRADED' : 'CONNECTED',
      openEvents,
      deadLetters,
      lastSyncAt: ownEvents[0]?.updatedAt ?? null,
      requiredSecrets: [],
      capabilities: [...new Set(ownEvents.map((event) => event.flow).filter(Boolean))],
    };
  });
}

function humanizeConnectorCode(code: string): string {
  return code
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function connectorCategoryFromCode(code: string): RuntimeConnector['category'] {
  const normalized = code.toUpperCase();
  if (normalized.includes('ERP')) return 'ERP';
  if (normalized.includes('SHOP') || normalized.includes('ECOM')) return 'ECOMMERCE';
  if (normalized.includes('CARRIER') || normalized.includes('SHIP')) return 'CARRIER';
  if (normalized.includes('PRINT') || normalized.includes('LABEL')) return 'PRINT';
  if (normalized.includes('EDI')) return 'EDI';
  return 'WEBHOOK';
}

function isPlaceholderConnectorCode(code: string): boolean {
  const normalized = code.toUpperCase();
  return (
    /(^|_)[A-D]$/.test(normalized)
    || /^CARRIER_[A-D]$/.test(normalized)
    || /^PRINT_PACK_[0-9]+$/.test(normalized)
    || normalized.includes('CLIENT_')
    || normalized.includes('DEMO')
    || normalized.includes('SANDBOX')
    || normalized.includes('PLACEHOLDER')
  );
}

function matchesContext(conditions: Record<string, unknown>, context: Record<string, unknown>): boolean {
  const entries = Object.entries(conditions);
  if (!entries.length) return true;

  return entries.every(([key, expected]) => {
    if (!Object.hasOwn(context, key)) return false;
    const actual = context[key];
    if (Array.isArray(expected)) return expected.some(value => sameContextValue(actual, value));
    if (expected && typeof expected === 'object' && ('min' in expected || 'max' in expected)) {
      const value = contextNumber(actual);
      const min = 'min' in expected ? contextNumber(expected.min) : -Infinity;
      const max = 'max' in expected ? contextNumber(expected.max) : Infinity;
      return value >= min && value <= max;
    }
    return sameContextValue(actual, expected);
  });
}

function sameContextValue(actual: unknown, expected: unknown): boolean {
  if (actual == null || expected == null) return actual === expected;
  if (typeof actual === 'object' || typeof expected === 'object') return false;
  return String(actual) === String(expected);
}

function contextNumber(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function isExpected(scanned: string, expected?: string): boolean {
  if (!expected || !expected.trim()) return true;
  return normalize(scanned) === normalize(expected);
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function nextRfStep(current: string, result: RuntimeRfResult): string {
  if (result !== RuntimeRfResult.ACCEPTED) return current;
  const order = ['SCAN_LOCATION', 'SCAN_SKU', 'CONFIRM_QTY', 'SCAN_TOTE', 'COMPLETE'];
  const index = order.indexOf(current);
  return order[Math.min(order.length - 1, index + 1)] ?? 'SCAN_LOCATION';
}

function defaultExceptionTitle(code: string): string {
  const normalized = code.trim().toUpperCase();
  const labels: Record<string, string> = {
    SHORT_PICK: 'Short pick reported from RF',
    DAMAGED_STOCK: 'Damaged stock found by operator',
    WRONG_LOCATION: 'Wrong location scan',
    WRONG_SKU: 'Wrong SKU scan',
    PRINTER_DOWN: 'Printer unavailable',
  };
  return labels[normalized] ?? `${normalized} reported from RF`;
}

function offlineQueueLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function required<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new NotFoundException(message);
  return row;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeIntegrationState(value?: string): RuntimeIntegrationState {
  const normalized = value?.trim().toUpperCase();
  const allowed = Object.values(RuntimeIntegrationState);
  return allowed.includes(normalized as RuntimeIntegrationState)
    ? (normalized as RuntimeIntegrationState)
    : RuntimeIntegrationState.WAITING;
}

function hasEnv(key: string): boolean {
  return Boolean(process.env[key]?.trim());
}
