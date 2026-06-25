import clsx, { type ClassValue } from 'clsx';

/** Tiny className combiner (clsx wrapper). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
