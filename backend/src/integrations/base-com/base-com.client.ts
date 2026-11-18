import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Env } from '../../config/env';
import { readBoundedIntegrationResponse } from '../http-integration-adapter';

export const BASE_COM_REQUEST_TIMEOUT_MS = 5_000;
const BASE_COM_RESPONSE_LIMIT = 2 * 1024 * 1024;

@Injectable()
export class BaseComClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get configured(): boolean {
    return Boolean(this.config.get('BASE_COM_API_TOKEN', { infer: true }));
  }

  get shippedStatusId(): number | null {
    return this.config.get('BASE_COM_SHIPPED_STATUS_ID', { infer: true });
  }

  async getOrder(orderId: number): Promise<{ statusId: number; products: unknown }> {
    const payload = await this.call('getOrders', { order_id: orderId, get_unconfirmed_orders: false });
    const orders = payload['orders'];
    if (!Array.isArray(orders)) throw new BadGatewayException('Base.com returned an invalid order list.');
    if (orders.length === 0) throw new NotFoundException('No confirmed order with this ID was found in Base.com.');

    const order = asRecord(orders[0]);
    const statusId = baseComInteger(order?.['order_status_id']);
    if (orders.length !== 1 || !order || baseComInteger(order['order_id']) !== orderId || statusId === null) {
      throw new BadGatewayException('Base.com returned an invalid or unexpected order.');
    }
    if (order['confirmed'] !== true) {
      throw new UnprocessableEntityException('Confirm the order in Base.com before importing or updating it.');
    }
    return { statusId, products: order['products'] };
  }

  async setOrderStatus(orderId: number, statusId: number): Promise<void> {
    await this.call('setOrderStatus', { order_id: orderId, status_id: statusId });
  }

  private async call(
    method: 'getOrders' | 'setOrderStatus',
    parameters: Record<string, number | boolean>,
  ): Promise<Record<string, unknown>> {
    const token = this.config.get('BASE_COM_API_TOKEN', { infer: true });
    if (!token) throw new ServiceUnavailableException('The Base.com connector token is not configured.');

    try {
      const response = await fetch(this.config.get('BASE_COM_API_URL', { infer: true }), {
        method: 'POST',
        headers: { Accept: 'application/json', 'X-BLToken': token },
        body: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }),
        redirect: 'error',
        signal: AbortSignal.timeout(BASE_COM_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BadGatewayException(`Base.com API returned HTTP ${response.status}.`);
      }
      const payload = asRecord(JSON.parse(await readBoundedIntegrationResponse(response, BASE_COM_RESPONSE_LIMIT)));
      if (payload?.['status'] !== 'SUCCESS') {
        throw new BadGatewayException(`Base.com rejected ${method}. Check the API access and order settings in Base.com.`);
      }
      return payload;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('Could not read a valid response from Base.com.');
    }
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function baseComInteger(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
}
