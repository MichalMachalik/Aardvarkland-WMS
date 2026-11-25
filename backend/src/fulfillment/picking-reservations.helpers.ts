import { ConflictException } from '@nestjs/common';

interface LineToPick {
  id: string;
  lineNumber: string;
  orderedQuantity: number;
  pickedQuantity: number;
}

export function requirePickingReservations<T extends { outboundOrderLineId?: string | null; quantity: number }>(
  lines: LineToPick[],
  reservations: T[],
): Map<string, T[]> {
  const reservationsByLine = new Map<string, T[]>();
  for (const reservation of reservations) {
    if (!reservation.outboundOrderLineId) continue;
    const existing = reservationsByLine.get(reservation.outboundOrderLineId);
    if (existing) existing.push(reservation);
    else reservationsByLine.set(reservation.outboundOrderLineId, [reservation]);
  }

  for (const line of lines) {
    const remaining = line.orderedQuantity - line.pickedQuantity;
    const reserved = (reservationsByLine.get(line.id) ?? []).reduce((sum, reservation) => sum + reservation.quantity, 0);
    if (reserved !== remaining) {
      throw new ConflictException(
        `Outbound line ${line.lineNumber} needs ${remaining} units for picking and has ${reserved} reserved.`,
      );
    }
  }
  return reservationsByLine;
}
