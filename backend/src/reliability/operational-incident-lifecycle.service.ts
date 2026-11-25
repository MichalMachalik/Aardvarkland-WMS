import { BadRequestException, Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../access-control';
import { AuditService } from '../audit/audit.service';
import { PrismaService, withTransactionRetry } from '../database';
import type { Prisma } from '../generated/prisma/client';
import {
  OperationalIncident,
  OperationalIncidentLifecycleStatus,
  OperationalIncidentState,
} from './reliability.types';

interface IncidentStateRow {
  incident_key: string;
  status: OperationalIncidentLifecycleStatus;
  note: string | null;
  acknowledged_by_user_id: string | null;
  acknowledged_by_display_name: string | null;
  acknowledged_at: Date | string | null;
  resolved_by_user_id: string | null;
  resolved_by_display_name: string | null;
  resolved_at: Date | string | null;
  updated_at: Date | string;
}

@Injectable()
export class OperationalIncidentLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async enrichIncidents(incidents: OperationalIncident[]): Promise<OperationalIncident[]> {
    if (incidents.length === 0) {
      return incidents;
    }

    let stateByKey: Map<string, OperationalIncidentState>;
    try {
      stateByKey = await this.findStates(incidents.map((incident) => incident.key));
    } catch {
      stateByKey = new Map();
    }
    return incidents.map((incident) => ({
      ...incident,
      state: stateByKey.get(incident.key) ?? this.defaultState(incident.key),
    }));
  }

  acknowledgeIncident(
    incidentKey: string,
    note: string | undefined,
    actor: AuthenticatedUser,
  ): Promise<OperationalIncidentState> {
    return this.transitionIncident(incidentKey, note, actor, 'ACKNOWLEDGED');
  }

  resolveIncident(
    incidentKey: string,
    note: string | undefined,
    actor: AuthenticatedUser,
  ): Promise<OperationalIncidentState> {
    return this.transitionIncident(incidentKey, note, actor, 'RESOLVED');
  }

  private transitionIncident(
    incidentKey: string,
    note: string | undefined,
    actor: AuthenticatedUser,
    status: 'ACKNOWLEDGED' | 'RESOLVED',
  ): Promise<OperationalIncidentState> {
    const normalizedKey = normalizeIncidentKey(incidentKey);
    const normalizedNote = normalizeNote(note);
    return withTransactionRetry(() => this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRawUnsafe<IncidentStateRow[]>(
        `INSERT INTO operational_incident_states AS previous
          (incident_key, status, note, acknowledged_by_user_id, acknowledged_at, resolved_by_user_id, resolved_at, updated_at)
         VALUES ($1, $4, $2,
           CASE WHEN $4 = 'ACKNOWLEDGED' THEN $3::uuid ELSE NULL END,
           CASE WHEN $4 = 'ACKNOWLEDGED' THEN statement_timestamp() ELSE NULL END,
           CASE WHEN $4 = 'RESOLVED' THEN $3::uuid ELSE NULL END,
           CASE WHEN $4 = 'RESOLVED' THEN statement_timestamp() ELSE NULL END,
           statement_timestamp())
         ON CONFLICT (incident_key) DO UPDATE SET
           status = EXCLUDED.status,
           note = EXCLUDED.note,
           acknowledged_by_user_id = CASE WHEN EXCLUDED.status = 'ACKNOWLEDGED'
             THEN EXCLUDED.acknowledged_by_user_id ELSE previous.acknowledged_by_user_id END,
           acknowledged_at = CASE WHEN EXCLUDED.status = 'ACKNOWLEDGED'
             THEN EXCLUDED.acknowledged_at ELSE previous.acknowledged_at END,
           resolved_by_user_id = EXCLUDED.resolved_by_user_id,
           resolved_at = EXCLUDED.resolved_at,
           updated_at = statement_timestamp()
         WHERE previous.status IS DISTINCT FROM EXCLUDED.status
           OR previous.note IS DISTINCT FROM EXCLUDED.note
           OR (EXCLUDED.status = 'ACKNOWLEDGED' AND previous.resolved_at IS NOT NULL)
         RETURNING
           previous.*,
           (SELECT display_name FROM users WHERE id = previous.acknowledged_by_user_id) AS acknowledged_by_display_name,
           (SELECT display_name FROM users WHERE id = previous.resolved_by_user_id) AS resolved_by_display_name`,
        normalizedKey,
        normalizedNote,
        actor.id,
        status,
      );
      if (!rows[0]) {
        const existing = (await this.findStates([normalizedKey], tx)).get(normalizedKey);
        if (existing) return existing;
      }
      const state = toState(rows[0]);
      await this.audit.writeAction({
        actorUserId: actor.id,
        action: status === 'ACKNOWLEDGED' ? 'reliability.incident_acknowledged' : 'reliability.incident_resolved',
        resourceType: 'operational_incident',
        resourceId: normalizedKey,
        metadata: { note: normalizedNote },
      }, tx);
      return state;
    }));
  }

  private async findStates(
    keys: string[],
    client: Pick<Prisma.TransactionClient, '$queryRawUnsafe'> = this.prisma,
  ): Promise<Map<string, OperationalIncidentState>> {
    const rows = await client.$queryRawUnsafe<IncidentStateRow[]>(
      `
        SELECT
          state.incident_key,
          state.status,
          state.note,
          state.acknowledged_by_user_id,
          ack.display_name AS acknowledged_by_display_name,
          state.acknowledged_at,
          state.resolved_by_user_id,
          resolved.display_name AS resolved_by_display_name,
          state.resolved_at,
          state.updated_at
        FROM operational_incident_states state
        LEFT JOIN users ack ON ack.id = state.acknowledged_by_user_id
        LEFT JOIN users resolved ON resolved.id = state.resolved_by_user_id
        WHERE state.incident_key = ANY($1::text[])
      `,
      keys,
    );

    return new Map(rows.map((row) => [row.incident_key, toState(row)]));
  }

  private defaultState(incidentKey: string): OperationalIncidentState {
    return {
      incidentKey,
      status: 'OPEN',
      note: null,
      acknowledgedByUserId: null,
      acknowledgedByDisplayName: null,
      acknowledgedAt: null,
      resolvedByUserId: null,
      resolvedByDisplayName: null,
      resolvedAt: null,
      updatedAt: new Date().toISOString(),
    };
  }
}

function normalizeIncidentKey(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(normalized)) {
    throw new BadRequestException('Invalid incident key');
  }
  return normalized;
}

function normalizeNote(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function toState(row: IncidentStateRow | undefined): OperationalIncidentState {
  if (!row) {
    throw new BadRequestException('Incident state could not be written');
  }

  return {
    incidentKey: row.incident_key,
    status: row.status,
    note: row.note,
    acknowledgedByUserId: row.acknowledged_by_user_id,
    acknowledgedByDisplayName: row.acknowledged_by_display_name,
    acknowledgedAt: toIsoString(row.acknowledged_at),
    resolvedByUserId: row.resolved_by_user_id,
    resolvedByDisplayName: row.resolved_by_display_name,
    resolvedAt: toIsoString(row.resolved_at),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

function toIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
