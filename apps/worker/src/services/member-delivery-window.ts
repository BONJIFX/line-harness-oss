export const MEMBER_DELIVERY_START_HOUR_JST = 8;
export const MEMBER_DELIVERY_END_HOUR_JST = 21;
export const BONJI_EMERGENCY_OVERRIDE = 'bonji-explicit-approved';

export function jstHour(now = new Date()): number {
  return (now.getUTCHours() + 9) % 24;
}

export function isMemberDeliveryWindow(now = new Date()): boolean {
  const hour = jstHour(now);
  return hour >= MEMBER_DELIVERY_START_HOUR_JST && hour < MEMBER_DELIVERY_END_HOUR_JST;
}

export function hasBonjiEmergencyOverride(value: string | null | undefined): boolean {
  return value === BONJI_EMERGENCY_OVERRIDE;
}

export function nextMemberDeliveryWindowStart(now = new Date()): string {
  const shifted = new Date(now.getTime() + 9 * 60 * 60_000);
  const hour = shifted.getUTCHours();
  if (hour >= MEMBER_DELIVERY_END_HOUR_JST) shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(MEMBER_DELIVERY_START_HOUR_JST, 0, 0, 0);
  return shifted.toISOString().replace('Z', '+09:00');
}
