import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthenticatedUser } from '../access-control/types';
import { OwnerClientRecord, OwnerScopePrismaClient, OwnerScopeService } from '../clients/owner-scope.service';
import {
  makePageEnvelope,
  normalizeOffsetPagination,
  PageEnvelope,
  safeCompareSecrets,
  stableJsonStringify,
} from '../common';
import { Env } from '../config/env';
import {
  decryptCarrierSecrets,
  EncryptedCarrierSecretBundle,
  encryptCarrierSecrets,
  normalizeCarrierCredentialEnvironment,
  normalizeCarrierCredentialStatus,
} from './carrier-credentials.helpers';
import { PrismaService, withTransactionRetry } from '../database';
import { lockPostgresAdvisoryTransaction, lockPostgresRowById } from '../database/transaction-locks';
import {
  CarrierAdapterMode,
  CarrierCredentialContext,
  createCarrierLabelWithAdapter,
  normalizeCarrierWebhookSignature,
  normalizeTrackingWebhookPayload,
} from './adapters';
import {
  buildCarrierTrackingPayload,
  createCarrierTrackingExternalId,
  mergeLatestTrackingPayload,
  normalizeCarrierTrackingStatus,
} from './carrier-tracking.helpers';
import {
  carrierRequiresLabel,
  carrierLabelIdempotencyKey,
  createCarrierManifestPayload,
  getCarrierServiceProfile,
  listCarrierProfiles,
  normalizeCarrierCode,
  validateCarrierLabelRequest,
} from './carriers.helpers';
import { CarrierTrackingWebhookDto } from './dto/carrier-tracking-webhook.dto';
import { CloseCarrierManifestDto } from './dto/close-carrier-manifest.dto';
import { CreateCarrierLabelDto } from './dto/create-carrier-label.dto';
import { ListCarrierTrackingEventsQueryDto } from './dto/list-carrier-tracking-events-query.dto';
import { SyncCarrierTrackingDto } from './dto/sync-carrier-tracking.dto';
import { UpsertCarrierCredentialDto } from './dto/upsert-carrier-credential.dto';
import { VoidCarrierLabelDto } from './dto/void-carrier-label.dto';
import {
  CarrierCredentialResponse,
  CarrierLabelResult,
  CarrierServiceProfile,
  CarrierTrackingEventResponse,
  CarrierTrackingStatus,
  CarrierTrackingSyncResponse,
  CarrierTrackingWebhookResponse,
  CloseCarrierManifestResponse,
  CreateCarrierLabelResponse,
  VoidCarrierLabelResponse,
} from './carriers.types';

@Injectable()
export class CarriersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly ownerScope: OwnerScopeService,
  ) {}

  listCarriers(): CarrierServiceProfile[] {
    return listCarrierProfiles();
  }

  async listCredentials(warehouseReference: string, carrierInput?: string): Promise<CarrierCredentialResponse[]> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const carrier = carrierInput ? normalizeCarrierCode(carrierInput) : null;
    const credentials = await this.client.carrierCredential.findMany({
      where: { warehouseId: warehouse.id, ...(carrier ? { carrier } : {}) },
      orderBy: [{ carrier: 'asc' }, { environment: 'asc' }, { createdAt: 'desc' }],
    });
    return credentials.map(toCarrierCredentialResponse);
  }

  async upsertCredential(
    warehouseReference: string,
    carrierInput: string,
    dto: UpsertCarrierCredentialDto,
    actor: AuthenticatedUser,
  ): Promise<CarrierCredentialResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const carrier = normalizeCarrierCode(carrierInput);
    const environment = normalizeCarrierCredentialEnvironment(dto.environment);
    const status = normalizeCarrierCredentialStatus(dto.status);
    const encryptedSecrets = this.encryptCredentialSecrets(dto);
    const now = new Date();

    const credential = await this.transaction(async (tx) => {
      const result = await tx.carrierCredential.upsert({
        where: { warehouseId_carrier_environment: { warehouseId: warehouse.id, carrier, environment } },
        update: {
          ...(dto.status == null ? {} : { status }),
          ...(dto.accountNumber === undefined ? {} : { accountNumber: normalizeOptionalString(dto.accountNumber) }),
          ...(dto.metadata === undefined ? {} : { metadata: dto.metadata }),
          ...(encryptedSecrets
            ? {
                secretCiphertext: encryptedSecrets,
                secretFingerprint: encryptedSecrets.fingerprint,
                secretLast4: encryptedSecrets.last4,
                keyVersion: encryptedSecrets.keyVersion,
                lastRotatedAt: now,
              }
            : {}),
        },
        create: {
          warehouseId: warehouse.id,
          carrier,
          environment,
          status,
          accountNumber: normalizeOptionalString(dto.accountNumber),
          metadata: dto.metadata ?? null,
          secretCiphertext: encryptedSecrets,
          secretFingerprint: encryptedSecrets?.fingerprint ?? null,
          secretLast4: encryptedSecrets?.last4 ?? null,
          keyVersion: (encryptedSecrets?.keyVersion ?? dto.keyVersion?.trim()) || 'v1',
          lastRotatedAt: encryptedSecrets ? now : null,
        },
      });
      await this.writeAudit(tx, actor.id, warehouse.id, 'carrier.credentials_upserted', 'carrier_credential', result.id, {
        carrier,
        environment,
        status: result.status,
        hasSecret: Boolean(encryptedSecrets),
        secretFingerprint: encryptedSecrets?.fingerprint ?? null,
      });
      await this.writeOutbox(tx, 'CARRIER_CREDENTIALS_UPSERTED', 'carrier_credential', result.id, {
        warehouseId: warehouse.id,
        carrier,
        environment,
        status: result.status,
        hasSecret: Boolean(encryptedSecrets),
      });
      return result;
    });

    return toCarrierCredentialResponse(credential);
  }

  async createLabel(warehouseReference: string, carrierInput: string, dto: CreateCarrierLabelDto, actor: AuthenticatedUser): Promise<CreateCarrierLabelResponse> {
    const carrier = normalizeCarrierCode(carrierInput);
    const warehouse = await this.resolveWarehouse(warehouseReference);

    return this.transaction(async (tx) => {
      const shipment = await this.resolveShipment(tx, warehouse.id, dto.shipmentReference);
      const shipmentPackage = dto.packageReference
        ? await this.resolveShipmentPackage(tx, warehouse.id, shipment.id, dto.packageReference)
        : await this.resolveFirstShipmentPackage(tx, warehouse.id, shipment.id);
      const owner = await this.resolveOperationOwner(tx, warehouse.id, dto.ownerClientReference, [
        { resourceType: 'SHIPMENT_PACKAGE', resourceId: shipmentPackage?.id ?? null },
        { resourceType: 'SHIPMENT', resourceId: shipment.id },
      ]);

      if (carrierRequiresLabel(carrier) && !shipmentPackage) {
        throw new ConflictException('Carrier label requires a shipment package');
      }

      const request = {
        warehouseId: warehouse.id,
        shipmentId: shipment.id,
        shipmentNumber: shipment.shipmentNumber,
        packageId: shipmentPackage?.id ?? null,
        packageCode: shipmentPackage?.packageCode ?? null,
        carrier,
        serviceLevel: normalizeOptionalString(dto.serviceLevel ?? shipment.serviceLevel),
        dimensions: {
          weightGrams: dto.weightGrams ?? shipmentPackage?.weightGrams ?? null,
          lengthCm: dto.lengthCm ?? shipmentPackage?.lengthCm ?? null,
          widthCm: dto.widthCm ?? shipmentPackage?.widthCm ?? null,
          heightCm: dto.heightCm ?? shipmentPackage?.heightCm ?? null,
        },
        idempotencyKey: dto.idempotencyKey,
        metadata: dto.metadata ?? null,
      };
      const validationIssues = validateCarrierLabelRequest(request);

      if (validationIssues.length > 0) {
        throw new ConflictException({ code: 'carrier_label_invalid', message: 'Carrier label request is invalid', details: validationIssues.map((code) => ({ code, message: code })) });
      }

      const idempotencyKey = carrierLabelIdempotencyKey(request);
      const requestHash = createHash('sha256').update(stableJsonStringify({
        serviceLevel: request.serviceLevel,
        dimensions: request.dimensions,
        ownerClientId: owner?.id ?? null,
        environment: dto.environment ? normalizeCarrierCredentialEnvironment(dto.environment) : null,
        metadata: request.metadata,
      })).digest('hex');
      await lockPostgresAdvisoryTransaction(tx, 'carrier_label_request', JSON.stringify([
        warehouse.id, carrier, shipment.id, request.packageId, idempotencyKey,
      ]));
      const existing = await tx.carrierLabel.findFirst({
        where: {
          warehouseId: warehouse.id, shipmentId: shipment.id, packageId: request.packageId, carrier,
          payload: { path: ['idempotencyKey'], equals: idempotencyKey },
        },
      });
      if (existing) {
        const storedHash = toRecord(existing.payload)['requestHash'];
        if (typeof storedHash === 'string' && storedHash !== requestHash) {
          throw new ConflictException('The carrier label request key was already used with different details');
        }
        return { duplicate: true, label: toCarrierLabelResponse(existing), adapter: toSavedCarrierAdapter(existing, carrier, idempotencyKey) };
      }

      const credential = await this.resolveCarrierCredentialContext(tx, warehouse.id, carrier, dto.environment);
      const adapter = await createCarrierLabelWithAdapter({
        request: { ...request, idempotencyKey },
        credential,
        mode: this.getCarrierAdapterMode(),
        timeoutMs: this.getCarrierHttpTimeoutMs(),
      });
      const referenceExists = await tx.carrierLabel.findFirst({ where: { warehouseId: warehouse.id, labelReference: adapter.labelReference } });
      if (referenceExists) {
        throw new ConflictException('The carrier returned a label reference already assigned to another request');
      }

      const label = await tx.carrierLabel.create({
        data: {
          warehouseId: warehouse.id,
          ownerClientId: owner?.id ?? null,
          shipmentId: shipment.id,
          packageId: shipmentPackage?.id ?? null,
          labelReference: adapter.labelReference,
          status: 'GENERATED',
          carrier,
          serviceLevel: adapter.serviceLevel,
          trackingNumber: adapter.trackingNumber,
          labelFormat: adapter.labelFormat,
          payload: {
            labelData: adapter.labelData,
            testMode: adapter.testMode,
            adapter: adapter.adapterCode ?? 'LOCAL_TEST_CARRIER_ADAPTER',
            externalShipmentId: adapter.externalShipmentId ?? null,
            rawResponse: adapter.rawResponse ?? null,
            idempotencyKey: adapter.idempotencyKey,
            requestHash,
            environment: credential?.environment ?? dto.environment ?? null,
            requestMetadata: dto.metadata ?? null,
          },
        },
      });

      if (shipmentPackage) {
        await tx.shipmentPackage.update({ where: { id: shipmentPackage.id }, data: { trackingNumber: adapter.trackingNumber } });
      }

      if (owner) {
        await this.linkOwnerResources(tx, warehouse.id, owner, [
          { resourceType: 'CARRIER_LABEL', resourceId: label.id, metadata: { source: 'carrier.create_label', carrier, shipmentId: shipment.id, packageId: shipmentPackage?.id ?? null } },
        ]);
      }

      await this.writeAudit(tx, actor.id, warehouse.id, 'carrier.label_created', 'carrier_label', label.id, { carrier, shipmentId: shipment.id, packageId: shipmentPackage?.id ?? null, labelReference: label.labelReference });
      await this.writeOutbox(tx, 'CARRIER_LABEL_CREATED', 'carrier_label', label.id, { warehouseId: warehouse.id, carrier, shipmentId: shipment.id, packageId: shipmentPackage?.id ?? null, labelReference: label.labelReference, trackingNumber: adapter.trackingNumber });

      return { duplicate: false, label: toCarrierLabelResponse(label), adapter };
    });
  }

  async voidLabel(warehouseReference: string, carrierInput: string, labelReference: string, dto: VoidCarrierLabelDto, actor: AuthenticatedUser): Promise<VoidCarrierLabelResponse> {
    const carrier = normalizeCarrierCode(carrierInput);
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const profile = getCarrierServiceProfile(carrier);

    if (!profile.supportsVoid) {
      throw new ConflictException(`Carrier ${carrier} does not support label voiding`);
    }

    return this.transaction(async (tx) => {
      const found = await tx.carrierLabel.findFirst({ where: { warehouseId: warehouse.id, labelReference, carrier } });
      const label = found ? await this.lockCarrierLabel(tx, found) : null;

      if (!label) throw new NotFoundException('Carrier label was not found');
      if (label.status === 'CANCELLED') return { labelReference: label.labelReference, carrier, status: label.status, voided: false };
      if (label.status === 'PRINTED') throw new ConflictException('Printed labels cannot be voided without supervisor override');

      const updated = await tx.carrierLabel.update({
        where: { id: label.id },
        data: { status: 'CANCELLED', errorMessage: dto.reasonCode ?? 'VOIDED', payload: mergeMetadata(label.payload, { voidMetadata: dto.metadata ?? null, voidedAt: new Date().toISOString() }) },
      });
      await this.writeAudit(tx, actor.id, warehouse.id, 'carrier.label_voided', 'carrier_label', label.id, { carrier, labelReference, reasonCode: dto.reasonCode ?? null });
      await this.writeOutbox(tx, 'CARRIER_LABEL_VOIDED', 'carrier_label', label.id, { warehouseId: warehouse.id, carrier, labelReference, reasonCode: dto.reasonCode ?? null });

      return { labelReference: updated.labelReference, carrier, status: updated.status, voided: true };
    });
  }

  async closeManifest(warehouseReference: string, carrierInput: string, dto: CloseCarrierManifestDto, actor: AuthenticatedUser): Promise<CloseCarrierManifestResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const carrier = normalizeCarrierCode(carrierInput);
    if (dto.carrier && normalizeCarrierCode(dto.carrier) !== carrier) {
      throw new ConflictException('The manifest carrier must match the requested carrier');
    }
    const profile = getCarrierServiceProfile(carrier);

    if (!profile.supportsManifest) throw new ConflictException(`Carrier ${carrier} does not support manifests`);

    const serviceLevel = normalizeOptionalString(dto.serviceLevel);
    return this.transaction(async (tx) => {
      const labels = await tx.carrierLabel.findMany({
        where: {
          warehouseId: warehouse.id, carrier, status: { in: ['GENERATED', 'PRINTED'] },
          ...(serviceLevel ? { serviceLevel: { equals: serviceLevel, mode: 'insensitive' } } : {}),
        },
      });
      const shipmentIds = new Set(labels.map((label) => label.shipmentId).filter(isString));
      const packageIds = new Set(labels.map((label) => label.packageId).filter(isString));
      const manifest = createCarrierManifestPayload({ carrier, warehouseId: warehouse.id, shipmentCount: shipmentIds.size, packageCount: packageIds.size });

      await this.writeAudit(tx, actor.id, warehouse.id, 'carrier.manifest_closed', 'carrier_manifest', manifest.manifestReference, { ...manifest, metadata: dto.metadata ?? null });
      await this.writeOutbox(tx, 'CARRIER_MANIFEST_CLOSED', 'carrier_manifest', manifest.manifestReference, { warehouseId: warehouse.id, ...manifest, metadata: dto.metadata ?? null });

      return { manifest };
    });
  }

  async listTrackingEvents(warehouseReference: string, query: ListCarrierTrackingEventsQueryDto): Promise<PageEnvelope<CarrierTrackingEventResponse>> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const page = normalizeOffsetPagination(query, { defaultTake: 100, maxTake: 500 });
    const occurredAtFilter = { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) };
    const where = {
      warehouseId: warehouse.id,
      ...(query.carrier ? { carrier: normalizeCarrierCode(query.carrier) } : {}),
      ...(query.status ? { status: normalizeCarrierTrackingStatus(query.status) } : {}),
      ...(query.labelReference ? { labelReference: query.labelReference } : {}),
      ...(query.trackingNumber ? { trackingNumber: query.trackingNumber } : {}),
      ...(Object.keys(occurredAtFilter).length > 0 ? { occurredAt: occurredAtFilter } : {}),
    };
    const [total, events] = await Promise.all([
      this.client.carrierTrackingEvent.count({ where }),
      this.client.carrierTrackingEvent.findMany({ where, orderBy: { occurredAt: 'desc' }, take: page.take, skip: page.skip }),
    ]);

    return makePageEnvelope({ items: events.map(toCarrierTrackingEventResponse), total, take: page.take, skip: page.skip });
  }

  async receiveTrackingWebhook(warehouseReference: string, carrierInput: string, dto: CarrierTrackingWebhookDto, webhookSecret: string | undefined, headers: Record<string, string | string[] | undefined>): Promise<CarrierTrackingWebhookResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const carrier = normalizeCarrierCode(carrierInput);
    this.assertWebhookSecret(carrier, webhookSecret, headers, dto);

    return this.transaction(async (tx) => {
      const normalizedWebhook = dto.rawPayload ? normalizeTrackingWebhookPayload(dto.rawPayload) : null;
      const providedLabelReference = normalizeOptionalString(dto.labelReference) ?? normalizedWebhook?.labelReference ?? null;
      const providedTrackingNumber = normalizeOptionalString(dto.trackingNumber) ?? normalizedWebhook?.trackingNumber ?? null;
      const timestamp = dto.occurredAt ?? normalizedWebhook?.occurredAt;
      const occurredAt = timestamp ? new Date(timestamp) : new Date();
      if (Number.isNaN(occurredAt.getTime())) {
        throw new BadRequestException('Carrier tracking timestamp must be a valid date');
      }
      const label = await this.resolveCarrierLabelForTracking(tx, warehouse.id, carrier, providedLabelReference, providedTrackingNumber);
      const shipmentPackage = await this.resolvePackageForTracking(tx, warehouse.id, label, dto.packageReference, providedTrackingNumber);
      const shipment = await this.resolveShipmentForTracking(tx, warehouse.id, label, shipmentPackage, dto);
      const status = dto.status ? normalizeCarrierTrackingStatus(dto.status) : normalizedWebhook?.status ?? normalizeCarrierTrackingStatus(dto.status);
      const labelReference = label?.labelReference ?? providedLabelReference;
      const trackingNumber = providedTrackingNumber ?? label?.trackingNumber ?? shipmentPackage?.trackingNumber ?? null;
      const eventCode = normalizeOptionalString(dto.eventCode) ?? normalizedWebhook?.eventCode ?? null;
      const message = normalizeOptionalString(dto.message) ?? normalizedWebhook?.message ?? null;
      const externalEventId = normalizeOptionalString(dto.externalEventId) ?? normalizedWebhook?.externalEventId
        ?? createCarrierTrackingExternalId({ carrier, labelReference, trackingNumber, status, eventCode, occurredAt: timestamp ? occurredAt : null, message });
      const existing = await this.findExistingTrackingEvent(tx, warehouse.id, carrier, externalEventId);

      if (existing) return { duplicate: true, event: toCarrierTrackingEventResponse(existing) };

      const event = await tx.carrierTrackingEvent.create({
        data: {
          warehouseId: warehouse.id,
          carrier,
          labelReference,
          trackingNumber,
          shipmentId: shipment?.id ?? label?.shipmentId ?? shipmentPackage?.shipmentId ?? null,
          packageId: shipmentPackage?.id ?? label?.packageId ?? null,
          externalEventId,
          status,
          eventCode,
          message,
          payload: buildCarrierTrackingPayload({ metadata: dto.metadata ?? null, rawPayload: normalizedWebhook?.rawPayload ?? dto.rawPayload ?? null, source: 'webhook' }),
          occurredAt,
        },
      });

      await this.afterTrackingEvent(tx, warehouse.id, carrier, event, label, shipmentPackage, null);
      await this.recordInboxEvent(tx, warehouse.id, carrier, externalEventId, dto, headers, event.id);

      return { duplicate: false, event: toCarrierTrackingEventResponse(event) };
    });
  }

  async syncTracking(warehouseReference: string, carrierInput: string, dto: SyncCarrierTrackingDto, actor: AuthenticatedUser): Promise<CarrierTrackingSyncResponse> {
    const warehouse = await this.resolveWarehouse(warehouseReference);
    const carrier = normalizeCarrierCode(carrierInput);
    const status = normalizeCarrierTrackingStatus(dto.status ?? 'IN_TRANSIT');
    const maxEvents = Math.max(1, Math.min(dto.maxEvents ?? 50, 250));

    return this.transaction(async (tx) => {
      const labels = await tx.carrierLabel.findMany({ where: { warehouseId: warehouse.id, carrier, status: { in: ['GENERATED', 'PRINTED'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: maxEvents });
      const events: CarrierTrackingEventResponse[] = [];
      let skippedDuplicates = 0;

      for (const label of labels) {
        const externalEventId = `LOCAL_SYNC:${label.labelReference}:${status}`;
        const existing = await this.findExistingTrackingEvent(tx, warehouse.id, carrier, externalEventId);

        if (existing) { skippedDuplicates += 1; continue; }

        const event = await tx.carrierTrackingEvent.create({ data: { warehouseId: warehouse.id, carrier, labelReference: label.labelReference, trackingNumber: label.trackingNumber, shipmentId: label.shipmentId, packageId: label.packageId, externalEventId, status, eventCode: dto.eventCode ?? 'LOCAL_TRACKING_SYNC', message: `Local ${carrier} tracking sync reported ${status}.`, payload: buildCarrierTrackingPayload({ metadata: dto.metadata ?? null, rawPayload: null, source: 'local-sync' }), occurredAt: new Date() } });
        await this.afterTrackingEvent(tx, warehouse.id, carrier, event, label, null, actor.id);
        events.push(toCarrierTrackingEventResponse(event));
      }

      return { carrier, scannedLabels: labels.length, createdEvents: events.length, skippedDuplicates, events };
    });
  }

  private async findExistingTrackingEvent(
    tx: CarrierTransactionClient, warehouseId: string, carrier: string, externalEventId: string,
  ): Promise<CarrierTrackingEventRecord | null> {
    await lockPostgresAdvisoryTransaction(tx, 'carrier_tracking_event', JSON.stringify([warehouseId, carrier, externalEventId]));
    return tx.carrierTrackingEvent.findFirst({ where: { warehouseId, carrier, externalEventId } });
  }

  private async resolveOperationOwner(
    client: CarrierTransactionClient,
    warehouseId: string,
    explicitClientReference: string | null | undefined,
    sourceResources: Array<{ resourceType: string; resourceId: string | null | undefined }>,
  ): Promise<OwnerClientRecord | null> {
    const ownerClient = client as unknown as OwnerScopePrismaClient;
    const inheritedOwner = await this.ownerScope.resolveSingleOwnerFromResources({
      warehouseId,
      resources: sourceResources,
      client: ownerClient,
    });

    if (!explicitClientReference) return inheritedOwner;

    const explicitOwner = await this.ownerScope.resolveOwnerClient({
      warehouseId,
      clientReference: explicitClientReference,
      client: ownerClient,
    });
    if (!explicitOwner) throw new ConflictException('Owner client reference is required.');

    if (inheritedOwner && inheritedOwner.id !== explicitOwner.id) {
      throw new ConflictException('Explicit owner client conflicts with parent resource ownership.');
    }

    return explicitOwner;
  }

  private async linkOwnerResources(
    client: CarrierTransactionClient,
    warehouseId: string,
    owner: OwnerClientRecord,
    resources: Array<{ resourceType: string; resourceId: string | null | undefined; metadata?: Record<string, unknown> | null }>,
  ): Promise<void> {
    const ownerClient = client as unknown as OwnerScopePrismaClient;
    for (const resource of resources) {
      await this.ownerScope.linkResourceToResolvedClient({
        warehouseId,
        clientId: owner.id,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        metadata: { inheritedOwnerClientCode: owner.code, ...(resource.metadata ?? {}) },
        client: ownerClient,
      });
    }
  }

  private async resolveCarrierCredentialContext(
    tx: CarrierTransactionClient,
    warehouseId: string,
    carrier: string,
    environmentInput?: string | null,
  ): Promise<CarrierCredentialContext | null> {
    const environment = environmentInput ? normalizeCarrierCredentialEnvironment(environmentInput) : null;
    const credential = await tx.carrierCredential.findFirst({
      where: {
        warehouseId,
        carrier,
        status: 'ACTIVE',
        ...(environment ? { environment } : {}),
      },
      orderBy: [{ environment: environment ? 'asc' : 'desc' }, { updatedAt: 'desc' }],
    });

    if (!credential) {
      if (this.getCarrierAdapterMode() === CarrierAdapterMode.MOCK) return null;
      throw new ConflictException(`Active ${carrier} carrier credentials are required for ${this.getCarrierAdapterMode()} adapter mode.`);
    }

    return {
      carrier,
      environment: credential.environment,
      accountNumber: credential.accountNumber ?? null,
      metadata: toRecord(credential.metadata),
      secrets: this.decryptCredentialSecrets(credential),
    };
  }

  private decryptCredentialSecrets(credential: CarrierCredentialRecord): Record<string, string> {
    if (!credential.secretCiphertext) return {};
    const encryptionKey = this.config.get('CARRIER_CREDENTIAL_ENCRYPTION_KEY', { infer: true });
    if (!encryptionKey) {
      if (this.getCarrierAdapterMode() === CarrierAdapterMode.MOCK) return {};
      throw new ConflictException('CARRIER_CREDENTIAL_ENCRYPTION_KEY is required before using carrier credentials.');
    }

    const bundle = assertEncryptedCarrierSecretBundle(credential.secretCiphertext);
    const keyRing = this.getCarrierCredentialKeyRing(encryptionKey);
    const preferredKeyRing = [
      ...keyRing.filter((entry) => entry.keyVersion === bundle.keyVersion),
      ...keyRing.filter((entry) => entry.keyVersion !== bundle.keyVersion),
    ];

    for (const entry of preferredKeyRing) {
      try {
        return decryptCarrierSecrets(bundle, entry.encryptionKey);
      } catch {
        continue;
      }
    }

    throw new ConflictException('Carrier credential could not be decrypted with the configured key ring.');
  }

  private getCarrierAdapterMode(): CarrierAdapterMode {
    return this.config.get('CARRIER_ADAPTER_MODE', { infer: true });
  }

  private getCarrierHttpTimeoutMs(): number {
    return this.config.get('CARRIER_HTTP_TIMEOUT_MS', { infer: true });
  }

  private encryptCredentialSecrets(dto: UpsertCarrierCredentialDto): EncryptedCarrierSecretBundle | null {
    if (!dto.secrets) return null;
    const encryptionKey = this.config.get('CARRIER_CREDENTIAL_ENCRYPTION_KEY', { infer: true });
    if (!encryptionKey) {
      throw new ConflictException('CARRIER_CREDENTIAL_ENCRYPTION_KEY is required before storing carrier secrets.');
    }
    return encryptCarrierSecrets({
      secrets: dto.secrets,
      encryptionKey,
      keyVersion: dto.keyVersion ?? this.config.get('CARRIER_CREDENTIAL_ENCRYPTION_KEY_ID', { infer: true }),
    });
  }

  private getCarrierCredentialKeyRing(
    currentEncryptionKey: string,
  ): Array<{ keyVersion: string; encryptionKey: string }> {
    return [
      {
        keyVersion: this.config.get('CARRIER_CREDENTIAL_ENCRYPTION_KEY_ID', { infer: true }),
        encryptionKey: currentEncryptionKey,
      },
      ...this.config.get('CARRIER_CREDENTIAL_PREVIOUS_ENCRYPTION_KEYS', { infer: true }).map((entry) => ({
        keyVersion: entry.keyId,
        encryptionKey: entry.secret,
      })),
    ];
  }

  private assertWebhookSecret(
    carrier: string,
    receivedSecret: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    payload: CarrierTrackingWebhookDto,
  ): void {
    const configuredSecret = this.config.get('WEBHOOK_SHARED_SECRET', { infer: true });
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });

    if (!configuredSecret && nodeEnv === 'production') {
      throw new ForbiddenException('WEBHOOK_SHARED_SECRET is required in production');
    }

    if (!configuredSecret) {
      return;
    }

    if (hasAnySignatureHeader(headers)) {
      const result = normalizeCarrierWebhookSignature({
        carrier,
        headers,
        payload,
        secret: configuredSecret,
        toleranceSeconds: this.config.get('WEBHOOK_SIGNATURE_TOLERANCE_SECONDS', { infer: true }),
      });

      if (!result.ok) {
        throw new ForbiddenException(`Invalid carrier webhook signature: ${result.reason}`);
      }

      return;
    }

    if (!safeCompareSecrets(configuredSecret, receivedSecret)) {
      throw new ForbiddenException('Invalid carrier webhook secret');
    }
  }

  private async afterTrackingEvent(tx: CarrierTransactionClient, warehouseId: string, carrier: string, event: CarrierTrackingEventRecord, label: CarrierLabelRecord | null, shipmentPackage: ShipmentPackageRecord | null, actorUserId: string | null): Promise<void> {
    const latestTracking = { carrier, status: event.status, eventCode: event.eventCode, message: event.message, occurredAt: toIsoString(event.occurredAt), trackingNumber: event.trackingNumber, labelReference: event.labelReference };

    if (label) {
      const current = await this.lockCarrierLabel(tx, label);
      const previous = toRecord(toRecord(current?.payload)['latestTracking'])['occurredAt'];
      const previousTime = typeof previous === 'string' ? Date.parse(previous) : NaN;
      if (current && (Number.isNaN(previousTime) || previousTime < toDate(event.occurredAt).getTime())) {
        await tx.carrierLabel.update({
          where: { id: current.id },
          data: {
            ...(event.status === CarrierTrackingStatus.EXCEPTION ? { errorMessage: event.message ?? event.eventCode ?? 'TRACKING_EXCEPTION' } : {}),
            ...(event.status === CarrierTrackingStatus.CANCELLED ? { status: 'CANCELLED' } : {}),
            payload: mergeLatestTrackingPayload(current.payload, latestTracking),
          },
        });
      }
    }

    if (shipmentPackage && event.trackingNumber && !shipmentPackage.trackingNumber) {
      await tx.shipmentPackage.update({ where: { id: shipmentPackage.id }, data: { trackingNumber: event.trackingNumber } });
    }

    const owner = await this.ownerScope.resolveSingleOwnerFromResources({
      warehouseId,
      resources: [
        { resourceType: 'CARRIER_LABEL', resourceId: label?.id ?? null },
        { resourceType: 'SHIPMENT_PACKAGE', resourceId: shipmentPackage?.id ?? label?.packageId ?? null },
        { resourceType: 'SHIPMENT', resourceId: label?.shipmentId ?? shipmentPackage?.shipmentId ?? null },
      ],
      client: tx as unknown as OwnerScopePrismaClient,
    });

    if (owner) {
      await this.linkOwnerResources(tx, warehouseId, owner, [
        { resourceType: 'CARRIER_TRACKING_EVENT', resourceId: event.id, metadata: { source: 'carrier.tracking', carrier, status: event.status } },
      ]);
    }

    await this.writeAudit(tx, actorUserId, warehouseId, 'carrier.tracking_event_received', 'carrier_tracking_event', event.id, latestTracking);
    await this.writeOutbox(tx, 'CARRIER_TRACKING_EVENT_RECEIVED', 'carrier_tracking_event', event.id, { warehouseId, ...latestTracking });
  }

  private async lockCarrierLabel(tx: CarrierTransactionClient, label: CarrierLabelRecord): Promise<CarrierLabelRecord | null> {
    await lockPostgresRowById(tx, 'carrier_labels', label.id);
    return tx.carrierLabel.findFirst({ where: { id: label.id, warehouseId: label.warehouseId } });
  }

  private async recordInboxEvent(tx: CarrierTransactionClient, warehouseId: string, carrier: string, externalEventId: string, dto: CarrierTrackingWebhookDto, headers: Record<string, string | string[] | undefined>, resourceId: string): Promise<void> {
    const sourceSystem = `CARRIER:${carrier}:${warehouseId}`;
    const existing = await tx.inboxEvent.findFirst({ where: { sourceSystem, externalEventId } });

    if (existing) return;

    await tx.inboxEvent.create({ data: { sourceSystem, externalEventId, type: 'CARRIER_TRACKING_WEBHOOK', status: 'PROCESSED', payload: dto, headers: sanitizeHeaders(headers), resourceType: 'carrier_tracking_event', resourceId, attempts: 1, processedAt: new Date() } });
  }

  private async resolveWarehouse(reference: string): Promise<WarehouseRecord> {
    const warehouse = await this.client.warehouse.findFirst({ where: warehouseWhere(reference) });
    if (!warehouse) throw new NotFoundException('Warehouse was not found');
    return warehouse;
  }

  private async resolveShipment(tx: CarrierTransactionClient, warehouseId: string, reference: string): Promise<ShipmentRecord> {
    const shipment = await tx.shipment.findFirst({ where: { warehouseId, OR: referenceOr(reference, { shipmentNumber: normalizeReference(reference) }) } });
    if (!shipment) throw new NotFoundException('Shipment was not found');
    return shipment;
  }

  private async resolveShipmentPackage(tx: CarrierTransactionClient, warehouseId: string, shipmentId: string, reference: string): Promise<ShipmentPackageRecord> {
    const shipmentPackage = await tx.shipmentPackage.findFirst({ where: { warehouseId, shipmentId, OR: referenceOr(reference, { packageCode: normalizeReference(reference) }) } });
    if (!shipmentPackage) throw new NotFoundException('Shipment package was not found');
    return shipmentPackage;
  }

  private async resolveFirstShipmentPackage(tx: CarrierTransactionClient, warehouseId: string, shipmentId: string): Promise<ShipmentPackageRecord | null> {
    return tx.shipmentPackage.findFirst({ where: { warehouseId, shipmentId, status: { in: ['PACKED', 'STAGED', 'LOADED', 'SHIPPED'] } }, orderBy: { createdAt: 'asc' } });
  }

  private async resolveCarrierLabelForTracking(tx: CarrierTransactionClient, warehouseId: string, carrier: string, labelReference: string | null, trackingNumber: string | null): Promise<CarrierLabelRecord | null> {
    const label = labelReference
      ? await tx.carrierLabel.findFirst({ where: { warehouseId, carrier, labelReference } })
      : null;
    if (label?.trackingNumber && trackingNumber && label.trackingNumber !== trackingNumber) {
      throw new ConflictException('Tracking number does not match the referenced carrier label');
    }
    return label ?? (trackingNumber ? tx.carrierLabel.findFirst({ where: { warehouseId, carrier, trackingNumber } }) : null);
  }

  private async resolvePackageForTracking(tx: CarrierTransactionClient, warehouseId: string, label: CarrierLabelRecord | null, packageReference: string | undefined, trackingNumber: string | null): Promise<ShipmentPackageRecord | null> {
    if (packageReference) {
      const shipmentPackage = await tx.shipmentPackage.findFirst({ where: { warehouseId, OR: referenceOr(packageReference, { packageCode: normalizeReference(packageReference) }) } });
      if (!shipmentPackage) throw new NotFoundException('Shipment package was not found');
      if ((label?.packageId && label.packageId !== shipmentPackage.id) || (label?.shipmentId && label.shipmentId !== shipmentPackage.shipmentId)) {
        throw new ConflictException('Shipment package does not match the referenced carrier label');
      }
      return shipmentPackage;
    }
    if (label?.packageId) return tx.shipmentPackage.findFirst({ where: { warehouseId, id: label.packageId } });
    if (trackingNumber) return tx.shipmentPackage.findFirst({ where: { warehouseId, trackingNumber } });
    return null;
  }

  private async resolveShipmentForTracking(tx: CarrierTransactionClient, warehouseId: string, label: CarrierLabelRecord | null, shipmentPackage: ShipmentPackageRecord | null, dto: CarrierTrackingWebhookDto): Promise<ShipmentRecord | null> {
    const shipmentId = label?.shipmentId ?? shipmentPackage?.shipmentId ?? null;
    if (dto.shipmentReference) {
      const shipment = await this.resolveShipment(tx, warehouseId, dto.shipmentReference);
      if (shipmentId && shipment.id !== shipmentId) {
        throw new ConflictException('Shipment does not match the referenced carrier label or package');
      }
      return shipment;
    }
    return shipmentId ? tx.shipment.findFirst({ where: { warehouseId, id: shipmentId } }) : null;
  }

  private async writeAudit(tx: CarrierTransactionClient, actorUserId: string | null, warehouseId: string, action: string, resourceType: string, resourceId: string | null, metadata: Record<string, unknown>): Promise<void> {
    await tx.auditLog.create({ data: { actorUserId, warehouseId, action, resourceType, resourceId, metadata } });
  }

  private async writeOutbox(tx: CarrierTransactionClient, type: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
    await tx.outboxEvent.create({ data: { type, aggregateType, aggregateId, payload, status: 'PENDING', availableAt: new Date() } });
  }

  private transaction<T>(fn: (client: CarrierTransactionClient) => Promise<T>): Promise<T> {
    return withTransactionRetry(() => this.client.$transaction(fn));
  }

  private get client(): CarrierPrismaClient {
    return this.prisma as unknown as CarrierPrismaClient;
  }
}

function toCarrierCredentialResponse(credential: CarrierCredentialRecord): CarrierCredentialResponse {
  return {
    id: credential.id,
    warehouseId: credential.warehouseId,
    carrier: credential.carrier,
    environment: credential.environment,
    status: credential.status,
    accountNumber: credential.accountNumber ?? null,
    secretFingerprint: credential.secretFingerprint ?? null,
    secretLast4: credential.secretLast4 ?? null,
    keyVersion: credential.keyVersion,
    lastRotatedAt: credential.lastRotatedAt ?? null,
    metadata: credential.metadata ?? null,
    createdAt: toDate(credential.createdAt),
    updatedAt: toDate(credential.updatedAt),
  };
}

function toCarrierLabelResponse(label: CarrierLabelRecord): CreateCarrierLabelResponse['label'] {
  return { id: label.id, labelReference: label.labelReference, status: label.status, carrier: label.carrier ?? null, serviceLevel: label.serviceLevel ?? null, trackingNumber: label.trackingNumber ?? null, labelFormat: label.labelFormat, shipmentId: label.shipmentId ?? null, packageId: label.packageId ?? null, payload: label.payload ?? null };
}

function toSavedCarrierAdapter(label: CarrierLabelRecord, carrier: string, idempotencyKey: string): CarrierLabelResult {
  const { labelData, testMode, adapter, externalShipmentId, rawResponse } = toRecord(label.payload);
  if (!label.trackingNumber || typeof labelData !== 'string' || (label.labelFormat !== 'ZPL' && label.labelFormat !== 'PDF')) {
    throw new ConflictException('The stored carrier label has incomplete adapter data');
  }
  return {
    carrier,
    serviceLevel: label.serviceLevel,
    labelReference: label.labelReference,
    trackingNumber: label.trackingNumber,
    labelFormat: label.labelFormat,
    labelData,
    idempotencyKey,
    testMode: testMode === true,
    ...(typeof adapter === 'string' ? { adapterCode: adapter } : {}),
    ...(typeof externalShipmentId === 'string' ? { externalShipmentId } : {}),
    ...(rawResponse ? { rawResponse: toRecord(rawResponse) } : {}),
  };
}

function toCarrierTrackingEventResponse(event: CarrierTrackingEventRecord): CarrierTrackingEventResponse {
  return { id: event.id, warehouseId: event.warehouseId, carrier: event.carrier, labelReference: event.labelReference ?? null, trackingNumber: event.trackingNumber ?? null, shipmentId: event.shipmentId ?? null, packageId: event.packageId ?? null, externalEventId: event.externalEventId ?? null, status: event.status, eventCode: event.eventCode ?? null, message: event.message ?? null, payload: event.payload ?? null, occurredAt: toDate(event.occurredAt), createdAt: toDate(event.createdAt) };
}

function referenceOr(reference: string, fallback: Record<string, unknown>): Record<string, unknown>[] { return isUuid(reference) ? [{ id: reference }, fallback] : [fallback]; }
function warehouseWhere(reference: string): Record<string, unknown> {
  return isUuid(reference) ? { OR: [{ id: reference }, { code: normalizeReference(reference) }] } : { code: normalizeReference(reference) };
}
function normalizeReference(value: string): string { return value.trim().toUpperCase(); }
function normalizeOptionalString(value: string | null | undefined): string | null { const normalized = value?.trim(); return normalized && normalized.length > 0 ? normalized : null; }
function mergeMetadata(metadata: unknown, extra: Record<string, unknown>): Record<string, unknown> { return { ...toRecord(metadata), ...extra }; }
function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, unknown> { const sanitized: Record<string, unknown> = {}; for (const [key, value] of Object.entries(headers)) { if (['authorization', 'x-webhook-secret', 'cookie'].includes(key.toLowerCase())) continue; sanitized[key] = Array.isArray(value) ? value[0] : value ?? null; } return sanitized; }

function hasAnySignatureHeader(headers: Record<string, string | string[] | undefined>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase().includes('signature'));
}
function toRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}; }
function assertEncryptedCarrierSecretBundle(value: unknown): EncryptedCarrierSecretBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictException('Carrier credential secret bundle is invalid.');
  }
  const bundle = value as Partial<EncryptedCarrierSecretBundle>;
  if (
    bundle.algorithm !== 'aes-256-gcm' ||
    typeof bundle.iv !== 'string' ||
    typeof bundle.authTag !== 'string' ||
    typeof bundle.ciphertext !== 'string' ||
    typeof bundle.fingerprint !== 'string'
  ) {
    throw new ConflictException('Carrier credential secret bundle is invalid.');
  }
  return bundle as EncryptedCarrierSecretBundle;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isString(value: string | null | undefined): value is string { return typeof value === 'string' && value.length > 0; }
function toDate(value: Date | string): Date { return value instanceof Date ? value : new Date(value); }
function toIsoString(value: Date | string): string { return toDate(value).toISOString(); }

interface CarrierPrismaClient extends CarrierTransactionClient { $transaction<T>(fn: (client: CarrierTransactionClient) => Promise<T>): Promise<T>; }
interface CarrierTransactionClient {
  warehouse: { findFirst(args: Record<string, unknown>): Promise<WarehouseRecord | null> };
  shipment: { findFirst(args: Record<string, unknown>): Promise<ShipmentRecord | null> };
  shipmentPackage: { findFirst(args: Record<string, unknown>): Promise<ShipmentPackageRecord | null>; update(args: Record<string, unknown>): Promise<ShipmentPackageRecord> };
  carrierLabel: { create(args: Record<string, unknown>): Promise<CarrierLabelRecord>; findFirst(args: Record<string, unknown>): Promise<CarrierLabelRecord | null>; findMany(args: Record<string, unknown>): Promise<CarrierLabelRecord[]>; update(args: Record<string, unknown>): Promise<CarrierLabelRecord> };
  carrierCredential: { findFirst(args: Record<string, unknown>): Promise<CarrierCredentialRecord | null>; findMany(args: Record<string, unknown>): Promise<CarrierCredentialRecord[]>; upsert(args: Record<string, unknown>): Promise<CarrierCredentialRecord> };
  carrierTrackingEvent: { count(args: Record<string, unknown>): Promise<number>; create(args: Record<string, unknown>): Promise<CarrierTrackingEventRecord>; findFirst(args: Record<string, unknown>): Promise<CarrierTrackingEventRecord | null>; findMany(args: Record<string, unknown>): Promise<CarrierTrackingEventRecord[]> };
  inboxEvent: { create(args: Record<string, unknown>): Promise<unknown>; findFirst(args: Record<string, unknown>): Promise<unknown | null> };
  auditLog: { create(args: Record<string, unknown>): Promise<unknown> };
  outboxEvent: { create(args: Record<string, unknown>): Promise<unknown> };
}
interface WarehouseRecord { id: string; code: string }
interface ShipmentRecord { id: string; warehouseId: string; shipmentNumber: string; serviceLevel: string | null }
interface ShipmentPackageRecord { id: string; warehouseId: string; shipmentId: string; packageCode: string; status: string; weightGrams: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null; trackingNumber: string | null; createdAt: Date }
interface CarrierLabelRecord { id: string; warehouseId: string; shipmentId: string | null; packageId: string | null; labelReference: string; status: string; carrier: string | null; serviceLevel: string | null; trackingNumber: string | null; labelFormat: string; payload: unknown; createdAt: Date }
interface CarrierCredentialRecord { id: string; warehouseId: string; carrier: string; environment: string; status: CarrierCredentialResponse['status']; accountNumber: string | null; secretCiphertext: unknown; secretFingerprint: string | null; secretLast4: string | null; keyVersion: string; lastRotatedAt: Date | null; metadata: unknown; createdAt: Date | string; updatedAt: Date | string }
interface CarrierTrackingEventRecord { id: string; warehouseId: string; carrier: string; labelReference: string | null; trackingNumber: string | null; shipmentId: string | null; packageId: string | null; externalEventId: string | null; status: CarrierTrackingStatus; eventCode: string | null; message: string | null; payload: unknown; occurredAt: Date | string; createdAt: Date | string }
